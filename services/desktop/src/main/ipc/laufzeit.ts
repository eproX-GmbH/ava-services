// IPC-Handler „Ollama, Speicher, Postgres, Verarbeitung, Producer, externe Dienste, Updater“, aus src/main/index.ts herausgelöst (docs/PLAN_AVA_CLOUD.md §12, R2).
// Die Handler sind unverändert; die Abhängigkeiten kommen explizit über `deps`.
// Spät gesetzte Dienste (vormals `let` in index.ts) werden als Getter übergeben.

import { app, ipcMain, protocol, shell } from "electron";
import type { StorageDeps } from "../storage-usage";
import { OllamaBinaryUpdater, PINNED_OLLAMA_VERSION } from "../ollama-binary-updater";
import { processingControl } from "../processing-control";
import { producerLogBuffer } from "../producer-log-buffer";
import { listScreenshots } from "../producer-screenshots";
import { buildStorageOverview, cleanupOrphanModels, deleteStorageItem } from "../storage-usage";
import { writeUpdatingFlag } from "../watchdog";
import { spawn as spawnChild } from "node:child_process";
import { join } from "node:path";
import type { ExternalServiceMonitor } from "../external-service-monitor";
import type { OllamaSupervisor } from "../ollama-supervisor";
import type { PostgresSupervisor } from "../postgres-supervisor";
import type { ProducerSupervisor } from "../producer-supervisor";
import type { Updater } from "../updater";

export interface LaufzeitIpcDeps {
  externalServiceMonitor: ExternalServiceMonitor;
  ollama: OllamaSupervisor;
  ollamaUpdater: OllamaBinaryUpdater;
  postgres: PostgresSupervisor;
  producers: ProducerSupervisor[];
  storageDeps: () => StorageDeps;
  updater: Updater;
}

export function registerLaufzeitIpc(deps: LaufzeitIpcDeps): void {
  const { externalServiceMonitor, ollama, ollamaUpdater, postgres, producers, storageDeps, updater } = deps;

  // Ollama supervisor IPC. The renderer drives:
  //   - getStatus on startup (then subscribes to `ollama-status:changed`)
  //   - pullModel during the FirstRunWizard (progress arrives via
  //     `ollama-pull:progress`, terminal frame as the resolved value)
  ipcMain.handle("ollama:getStatus", () => ollama.getStatus());

  ipcMain.handle("ollama:pullModel", (_e, modelName: string) =>
    ollama.pullModel(modelName),
  );

  // Phase 8.k10e — let the user reclaim disk space from Whoami. The
  // supervisor refreshes its installed-models list before resolving so
  // the renderer's next ollama-status push reflects the deletion.
  ipcMain.handle("ollama:deleteModel", (_e, modelName: string) =>
    ollama.deleteModel(modelName),
  );

  ipcMain.handle("storage:getOverview", () =>
    buildStorageOverview(storageDeps()),
  );

  ipcMain.handle(
    "storage:deleteItem",
    (_e, category: import("../../shared/types").StorageCategoryKey, id: string) =>
      deleteStorageItem(storageDeps(), category, id),
  );

  ipcMain.handle("storage:cleanupOrphans", () =>
    cleanupOrphanModels(storageDeps()),
  );

  ipcMain.handle("storage:openFolder", async (_e, path: string) => {
    const err = await shell.openPath(path);
    return { ok: err === "", error: err || undefined };
  });

  // v0.1.220 — Ollama-Binary Self-Update.
  //
  // Flow:
  //   1. Renderer ruft `ollama:updateBinary` (z. B. nach 412-Fehler
  //      bei pullModel).
  //   2. OllamaBinaryUpdater lädt die gepinnte Ollama-Version aus den
  //      GitHub-Releases und legt sie unter <userData>/ollama-managed/
  //      ab. Progress via `ollama-updater:state`-Events.
  //   3. Auf state=ready: Supervisor stoppen, neu starten — der
  //      resolveBinaryPath findet jetzt die Managed-Variante zuerst.
  //   4. Renderer kann den fehlgeschlagenen Pull erneut anstoßen.
  ipcMain.handle("ollama:updateBinary", async () => {
    await ollamaUpdater.update();
    const final = ollamaUpdater.getState();
    if (final.state === "ready") {
      // Supervisor sauber durchstarten, damit der neue Binary-Pfad
      // greift. stop()+start() statt restart() weil die start()-Logik
      // den Pfad neu auflöst — ein in-place reload wäre fragiler.
      try {
        await ollama.stop();
      } catch (err) {
        console.warn(
          "[ollama-updater] stop() failed during binary swap:",
          err instanceof Error ? err.message : err,
        );
      }
      try {
        await ollama.start();
      } catch (err) {
        console.warn(
          "[ollama-updater] start() after swap failed:",
          err instanceof Error ? err.message : err,
        );
      }
    }
    return final;
  });

  ipcMain.handle("ollama:getUpdaterState", () => ollamaUpdater.getState());

  ipcMain.handle("ollama:getManagedVersion", () =>
    ollamaUpdater.getManagedVersion(),
  );

  // v0.1.221 — was "getPinnedVersion": liefert jetzt die FLOOR-Version,
  // also die Mindest-Kompatibilität. Floor wird nur installiert, wenn
  // GitHub für das aktuelle Latest nicht erreichbar ist oder Upstream
  // eine niedrigere Version als Latest meldet (Schutz vor zurückgezogenen
  // Releases). Name bleibt aus Backward-Compat erhalten; semantisch ist
  // es der Floor.
  ipcMain.handle("ollama:getPinnedVersion", () => PINNED_OLLAMA_VERSION);

  // v0.1.221 — Welche Ollama-Version würde das Update gerade
  // installieren? Antwortet mit dem Resolved-Wert (max(floor, latest)
  // aus dem GitHub-Cache). Null wenn der GitHub-Lookup noch nicht
  // gemacht wurde oder fehlschlug. Settings-UI nutzt das zur Anzeige
  // „Neueste verfügbare: v0.27.1".
  ipcMain.handle("ollama:getResolvedTargetVersion", () =>
    ollamaUpdater.peekResolvedTargetVersion(),
  );

  // v0.1.222 — Welche Ollama-Version läuft gerade?
  ipcMain.handle("ollama:getInstalledVersion", () =>
    ollama.getInstalledVersion(),
  );

  // Postgres supervisor IPC (8.v1.0). Renderer reads getStatus on
  // mount and subscribes to `postgres-status:changed`. No restart /
  // reset endpoints yet — those come with the Settings panel UX.
  ipcMain.handle("postgres:getStatus", () => postgres.getStatus());

  // Auto-updater IPC (8.u4).
  ipcMain.handle("updater:getStatus", () => updater.getStatus());

  ipcMain.handle("updater:check", () => updater.check());

  ipcMain.handle("updater:download", () => updater.download());

  // v0.1.395 — Lokaler Verarbeitungs-Schalter (Play/Pause).
  ipcMain.handle("processing:getStatus", () => ({
    paused: processingControl.isPaused(),
  }));

  ipcMain.handle("processing:setPaused", (_e, paused: boolean) => {
    processingControl.setPaused(paused === true);
    return { paused: processingControl.isPaused() };
  });

  ipcMain.handle("updater:install", () => {
    console.log("[updater:install] pre-kill subprocesses + arm backstop");
    // Synchron alle Subprozesse hart killen (bevor Squirrel den
    // Main-Thread in den JIT-Loop schickt).
    for (const p of producers) {
      try {
        p.forceKill();
      } catch (err) {
        console.warn("[updater:install] producer.forceKill failed:", err instanceof Error ? err.message : String(err));
      }
    }
    try {
      ollama.forceKill();
    } catch (err) {
      console.warn("[updater:install] ollama.forceKill failed:", err instanceof Error ? err.message : String(err));
    }
    // Backstop: detached child process der den Eltern (AVA) mit SIGKILL
    // umbringt, falls Squirrel das nicht selbst schafft (V8/JIT-Spin auf
    // dem Main-Thread → kein sauberes Quit). Läuft auf OS-Ebene,
    // unabhängig von der hängenden JS-Loop.
    //
    // v0.1.343 — STAGING-GATED statt blindem 10s-Timeout. Real-Run-Bug:
    // Squirrel.Mac lädt+entpackt das Update IN-PROCESS (über den von
    // electron-updater gehosteten lokalen Proxy) in
    // `~/Library/Caches/com.ava.desktop.ShipIt/update.<X>/AVA.app`. Das
    // ~1 GB-Bundle braucht real >10s; der alte `sleep 10 && kill -9`
    // tötete den Prozess MITTEN im Entpacken → unvollständige
    // `update.<X>/AVA.app` → ShipIt "Failed to copy bundle … no such
    // file" → Update scheitert (siehe ShipIt_stderr.log).
    //
    // Neu: der Backstop pollt, bis die gestagete `AVA.app` vollständig
    // (Executable + _CodeSignature vorhanden) UND größenstabil (2× du
    // identisch → Extraktion fertig) ist, und killt erst DANN. Quittiert
    // AVA vorher sauber (kill -0 schlägt fehl), beenden wir uns ohne Kill.
    // Absolute Obergrenze 120s, damit eine WIRKLICH tote App (der Spin,
    // der den Backstop überhaupt nötig macht) nicht ewig hängt — gibt
    // auch langsamen Laptops genug Zeit fürs Entpacken.
    // v0.1.351 — Watchdog (v0.1.341) VOR dem Quit stilllegen. Sonst
    // sieht der externe Watchdog während des Update-Quits den
    // eingefrorenen/sterbenden Main-Prozess, deklariert „wedged" und
    // RELAUNCHT AVA mitten in der Installation. Auf Windows heißt das:
    // NSIS sieht AVA.exe wieder laufen → „kann nicht geschlossen
    // werden". Das Flag wird vom Watchdog bei jedem Tick geprüft; ist
    // es da, beendet er sich ohne Relaunch. Cross-platform sicher
    // (auf macOS verhindert es nur einen störenden Relaunch während
    // des 1–3-min-ShipIt-Copy, ändert den Erfolgs-Pfad nicht).
    try {
      writeUpdatingFlag();
    } catch (err) {
      console.warn("[updater:install] writeUpdatingFlag failed:", err instanceof Error ? err.message : String(err));
    }
    // v0.1.351 — Der OS-Level-Backstop unten ist NUR für den macOS-
    // Squirrel.Mac-JIT-Spin (quitAndInstall wedged den Main-Thread in
    // einer V8-Schleife). Auf Windows gibt es diesen Spin nicht: NSIS
    // läuft als eigener Prozess, und der silent-Install (/S) + der
    // customInit-taskkill in installer.nsh schließen AVA zuverlässig.
    // Das sichtbare `timeout /t 120`-Konsolenfenster (Real-Run-
    // Screenshots) war reiner Schaden. Daher: Backstop NUR auf
    // Nicht-Windows armen.
    const parentPid = process.pid;
    const CEIL_S = 120;
    try {
      if (process.platform === "win32") {
        console.log("[updater:install] backstop skipped on win32 (NSIS handles close via /S + customInit)");
        return updater.installAndRelaunch();
      }
      const macScript = [
        `PID=${parentPid}`,
        `CACHE="$HOME/Library/Caches/com.ava.desktop.ShipIt"`,
        `ST="$CACHE/ShipItState.plist"`,
        `start=$(date +%s); last=-1; stable=0`,
        `while :; do`,
        `  kill -0 $PID 2>/dev/null || exit 0`,
        `  now=$(date +%s)`,
        `  app=$(/usr/bin/plutil -extract updateBundleURL raw -o - "$ST" 2>/dev/null | sed -e "s|^file://||" -e "s|/$||")`,
        `  [ -z "$app" ] && app=$(ls -dt "$CACHE"/update.*/AVA.app 2>/dev/null | head -1)`,
        `  ready=0`,
        `  if [ -n "$app" ] && [ -x "$app/Contents/MacOS/AVA" ] && [ -f "$app/Contents/_CodeSignature/CodeResources" ]; then`,
        `    sz=$(/usr/bin/du -s "$app" 2>/dev/null | cut -f1)`,
        `    if [ "$sz" = "$last" ]; then stable=$((stable+1)); else stable=0; fi`,
        `    last="$sz"`,
        `    [ $stable -ge 2 ] && ready=1`,
        `  fi`,
        `  if [ $ready -eq 1 ] || [ $(( now - start )) -ge ${CEIL_S} ]; then`,
        `    kill -0 $PID 2>/dev/null && kill -9 $PID`,
        `    exit 0`,
        `  fi`,
        `  sleep 2`,
        `done`,
      ].join("\n");
      const sh = spawnChild("/bin/sh", ["-c", macScript], {
        detached: true,
        stdio: "ignore",
      });
      sh.unref();
      console.log(
        `[updater:install] backstop armed (pid=${parentPid}, staging-gated, ceiling ${CEIL_S}s)`,
      );
    } catch (err) {
      console.warn("[updater:install] backstop spawn failed:", err instanceof Error ? err.message : String(err));
    }
    // Jetzt regulär quitAndInstall — ShipIt wird spawned, AVA SOLL
    // sauber terminieren. Wenn nicht: Backstop killt, sobald das Staging
    // fertig ist (spätestens nach der 120s-Obergrenze).
    return updater.installAndRelaunch();
  });

  // v0.1.155 — diagnostics for silent OTA failures. The renderer's
  // Settings panel calls getDiagnostics when the user clicks
  // "Update-Logs zeigen" and dismissSilentFailure when they
  // acknowledge the banner.
  ipcMain.handle("updater:getDiagnostics", () => updater.getDiagnostics());

  ipcMain.handle("updater:dismissSilentFailure", () =>
    updater.dismissSilentFailure(),
  );

  // Producer supervisors (8.v1.1). Renderer reads the snapshot list
  // on mount and subscribes to `producer-status:changed` for diffs.
  ipcMain.handle("producers:list", () =>
    producers.map((p) => p.getStatus()),
  );

  // Producer log streaming. The Logs tab in the matrix drill-down
  // panel calls tail() on open (backfill) then subscribes to
  // `producer-log:line` for the live tail. See producer-log-buffer.ts
  // for the ring-buffer semantics.
  ipcMain.handle(
    "producers:logs:tail",
    (_e, args: { producer: string; limit?: number }) =>
      producerLogBuffer.tail(args.producer, args.limit ?? 500),
  );

  // v0.1.432 — P4: Zeilen eines konkreten Runs (Firma) aus dem Run-Index.
  ipcMain.handle(
    "producers:logs:tailForRun",
    (_e, args: { producer: string; runId: string; limit?: number }) =>
      producerLogBuffer.tailForRun(
        String(args.producer),
        String(args.runId),
        args.limit,
      ),
  );

  // v0.1.163 — on-disk log file path per producer so renderer / chat
  // tools can point the user at the file for `tail -f` from Terminal.
  ipcMain.handle(
    "producers:logs:filePath",
    (_e, args: { producer: string }) =>
      producerLogBuffer.filePath(args.producer),
  );

  // Producer screenshots. The Screenshots tab calls list() with
  // (producer, runId) where runId = `${transactionId}:${companyId}`,
  // matches the on-disk dir created by each producer's screenshot
  // util. The custom `ava-screenshot://` protocol (registered before
  // app.whenReady) serves the actual PNG bytes.
  ipcMain.handle(
    "producers:screenshots:list",
    (_e, args: { producer: string; runId: string }) =>
      listScreenshots(args.producer, args.runId),
  );

  // v0.1.52 — external-service status (today: only
  // unternehmensregister.de). Renderer reads on mount + subscribes
  // to `external-service-status:changed` for transition pushes
  // (state changes, not every probe). The banner under the topbar
  // surfaces the unreachable state and explains which stages are
  // paused so users aren't confused by stuck-pending cells.
  ipcMain.handle("external-service:getStatus", () =>
    externalServiceMonitor.getStatus(),
  );

  ipcMain.handle("external-service:probeNow", () =>
    externalServiceMonitor.probeNow(),
  );

  ipcMain.handle("ollama:restart", () => ollama.restart());
}

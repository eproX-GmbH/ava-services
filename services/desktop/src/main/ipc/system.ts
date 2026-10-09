// IPC-Handler „App, Fenster, Shell, Protokoll, Diagnose, Strom, Screenshots, Konten, Status, Einstellungen“, aus src/main/index.ts herausgelöst (docs/PLAN_AVA_CLOUD.md §12, R2).
// Die Handler sind unverändert; die Abhängigkeiten kommen explizit über `deps`.
// Spät gesetzte Dienste (vormals `let` in index.ts) werden als Getter übergeben.

import { BrowserWindow, app, ipcMain, protocol, shell } from "electron";
import type { resolveConfig } from "../../shared/config";
import { paths } from "../../core/platform";
import { getActiveSpaceId, listAccounts, readIdentity, removeAccount, startNewAccount, switchAccount } from "../account-space";
import { Heartbeat } from "../agent";
import { Auth } from "../auth";
import { getLogDir, getMainLogPath, logRendererLine } from "../file-logger";
import { deleteScreenshotsForCompany } from "../producer-screenshots";
import { requestResetExceptModels } from "../reset-store";
import type { AlertsStore, GatewayClient } from "../agent";
import type { AuditEventInput } from "../audit/audit-types";
import type { ChromeForTesting } from "../chrome-for-testing";
import type { StatusWatcher } from "../status-watcher";

export interface SystemIpcDeps {
  alerts: AlertsStore;
  APP_CONFIG: ReturnType<typeof resolveConfig>;
  audit: (input: AuditEventInput) => void;
  auth: Auth;
  eigenerBrowser: { readonly current: ChromeForTesting | null };
  gatewayClient: GatewayClient;
  pendingWakeAcks: Map<string, Set<number>>;
  statusWatcher: StatusWatcher;
}

export function registerSystemIpc(deps: SystemIpcDeps): void {
  const { alerts, APP_CONFIG, audit, auth, eigenerBrowser, gatewayClient, pendingWakeAcks, statusWatcher } = deps;

  ipcMain.handle("browser:stand", () => eigenerBrowser.current?.aktuellerStand() ?? { zustand: "aus" });

  ipcMain.handle("power:ack", (e, { nonce }: { nonce: string }) => {
    const pending = pendingWakeAcks.get(nonce);
    if (pending) {
      pending.delete(e.sender.id);
      console.log(
        `[power] ack received for nonce=${nonce} from window=${e.sender.id} (${pending.size} remaining)`,
      );
    }
  });

  // Renderer console-mirror. The renderer patches its console + window
  // error handlers (see renderer/src/main.tsx) and forwards lines here so
  // pre-wedge renderer breadcrumbs land in the same persistent file as
  // the main-process logs. `on` (fire-and-forget) keeps it cheap and
  // never blocks the renderer. Defensive truncation caps a runaway line.
  ipcMain.on(
    "log:renderer",
    (_e, payload: { level?: string; line?: string }) => {
      const line = String(payload?.line ?? "");
      if (!line) return;
      logRendererLine(payload?.level ?? "log", line.slice(0, 8192));
    },
  );

  // Lets the renderer (Settings → Diagnose) reveal the log file so the
  // user can attach it to a bug report. Reuses the existing
  // shell:showItemInFolder handler on the renderer side.
  ipcMain.handle("diag:getLogPaths", () => ({
    mainLog: getMainLogPath(),
    logDir: getLogDir(),
  }));

  ipcMain.handle("status:pruefen", () => statusWatcher.pruefeJetzt());

  // ---- IPC contract ---------------------------------------------------------
  //
  // `app:getConfig` returns *static* boot config — gateway URL only. The
  // access token is no longer included here; renderer fetches it on demand
  // via `auth:getAccessToken` so it always gets a fresh-enough one.
  ipcMain.handle("app:getConfig", () => ({
    gatewayUrl: APP_CONFIG.gatewayUrl,
    authIssuer: APP_CONFIG.authIssuer,
    authClientId: APP_CONFIG.authClientId,
    updateChannel: APP_CONFIG.updateChannel,
    appVersion: APP_CONFIG.appVersion,
    isDev: APP_CONFIG.isDev,
  }));

  // v0.1.101 — generic shell.openExternal bridge for plain http/https
  // links (Enterprise contact page on Settings → Plan & Abrechnung).
  // Refuses any other scheme so the renderer can't open arbitrary
  // URIs (file:, javascript:, custom protocols, etc.) through this
  // path — those should each have their own dedicated IPC.
  ipcMain.handle("shell:openExternal", async (_e, url: string) => {
    if (typeof url !== "string") {
      throw new Error("shell:openExternal requires a string URL");
    }
    let parsed: URL;
    try {
      parsed = new URL(url);
    } catch {
      throw new Error("shell:openExternal: invalid URL");
    }
    if (parsed.protocol !== "https:" && parsed.protocol !== "http:") {
      throw new Error(
        `shell:openExternal: refused non-http(s) scheme '${parsed.protocol}'`,
      );
    }
    await shell.openExternal(parsed.toString());
  });

  // v0.1.155 — reveal-in-Finder + open-dir bridge for the
  // silent-OTA-failure banner. We don't enforce a scheme here because
  // file-system paths aren't URLs; we DO restrict to absolute paths
  // so the renderer can't trick main into opening relative paths from
  // CWD. file:// schemes are blocked at the openExternal layer above.
  ipcMain.handle("shell:showItemInFolder", (_e, path: string) => {
    if (typeof path !== "string" || !path.startsWith("/")) return;
    shell.showItemInFolder(path);
  });

  ipcMain.handle("shell:openPath", async (_e, path: string) => {
    if (typeof path !== "string" || !path.startsWith("/")) return;
    await shell.openPath(path);
  });

  // v0.1.322 — Install-Pfad härter machen. Real-Run-Crash (Stackshot
  // v0.1.316 → next) zeigt: AVA hängt 70s in einer V8/JIT-Schleife
  // während Squirrel.Mac via ReactiveObjC einen Callback auf den
  // Main-Thread dispatcht. Mein v0.1.314-Fix im before-quit-Handler
  // kommt nie zum Zug, weil das setTimeout(..., 200) auf einer wedged
  // Event-Loop nicht feuert. Daher: alle Subprozesse JETZT hart killen
  // (BEVOR quitAndInstall die JS-Loop-Schleife auslöst), und einen
  // Backstop-Timer setzen der notfalls process.exit(0) ruft.
  //
  // process.exit ist Node-Primitiv, läuft NICHT durch die V8-Event-
  // Loop sondern direkt _exit(). Selbst wenn JS in einer Endlosschleife
  // hängt, kommt der Timer durch — solange der libuv-Timer-Thread
  // noch lebt (was er bei einer JIT-Schleife sehr wohl tut; nur die
  // Main-Event-Loop ist blockiert).
  //
  // Wait — libuv-Timer feuern AUCH erst beim Event-Loop-Tick. Hmm.
  // Plan B: setImmediate funktioniert auch nicht. Wirklicher Fallback:
  // spawn ein detached Child mit Sleep+kill der parent-PID via SIGKILL.
  // Das ist OS-Level, läuft auch wenn JS hängt.
  // v0.1.327 — Wake-Health-Heartbeat. Renderer kann nach dem
  // power:resumed-Event diesen Endpoint pingen um zu pruefen ob der
  // Main-Process gesund antwortet. Wenn der Renderer keinen pong
  // innerhalb seines Timeouts kriegt, macht er einen window.location.
  // reload() um aus einem moeglichen Frozen-UI-State auszubrechen.
  // Antwortet IMMER synchron mit pong + Zeitstempel; jede Latenz hier
  // ist diagnostisch wertvoll (Renderer kann das loggen).
  ipcMain.handle("app:ping", () => ({ pong: true, at: Date.now() }));

  // v0.1.386 — Windows-Fensterleiste (titleBarOverlay) bei Theme-Wechsel
  // umfärben. Auf macOS sind die Ampel-Buttons systemgezeichnet und brauchen
  // das nicht — dort ist der Handler ein No-op. Der Renderer ruft das aus
  // `applyTheme` mit „light"/„dark".
  ipcMain.handle(
    "window:setTitleBarOverlay",
    (event, theme: "light" | "dark") => {
      if (process.platform !== "win32") return;
      const w = BrowserWindow.fromWebContents(event.sender);
      if (!w) return;
      const overlay =
        theme === "dark"
          ? { color: "#0A1F2A", symbolColor: "#F2F7F6", height: 64 }
          : { color: "#F2F7F6", symbolColor: "#0A1F2A", height: 64 };
      try {
        w.setTitleBarOverlay(overlay);
      } catch {
        /* nur verfügbar wenn das Fenster mit titleBarOverlay erstellt wurde */
      }
    },
  );

  // Heartbeat alerts IPC (Phase 8.f1). The renderer reads via
  // `alerts:list` / `alerts:unreadCount` and mutates with
  // `alerts:markSeen` / `alerts:dismiss`. `alerts:triggerNow` exists
  // primarily as a dev affordance ("Jetzt auslösen" button in
  // Settings — wired in 8.f3) but is safe to call at any time. Mutation
  // handlers re-broadcast `alerts:changed` so every open window's store
  // refreshes without the renderer having to invalidate cache.
  // T1 — Account-Spaces (Kontowechsler-UI folgt in T2).
  ipcMain.handle("accounts:list", () => ({
    ...listAccounts(),
    activeSpace: getActiveSpaceId(),
    identity: readIdentity(),
  }));

  ipcMain.handle("accounts:switch", (_e, sub: string) => switchAccount(String(sub)));

  ipcMain.handle("accounts:addAnother", () => {
    startNewAccount();
    return true;
  });

  ipcMain.handle("accounts:remove", (_e, sub: string) => removeAccount(String(sub)));

  // v0.1.409 — „Alles zurücksetzen außer KI-Modelle" (Werksreset). Setzt
  // einen Marker und startet die App neu; die Löschung passiert beim
  // nächsten Boot vor Store-Init (siehe reset-store.ts).
  // v0.1.431 — P3: lokale Screenshots einer geloeschten Firma entfernen.
  ipcMain.handle(
    "screenshots:deleteForCompany",
    async (_e, companyId: string): Promise<{ removed: number }> => {
      const removed = await deleteScreenshotsForCompany(String(companyId));
      return { removed };
    },
  );

  ipcMain.handle("settings:resetAllExceptModels", async () => {
    // Zentrale Radar-Entscheidungen (ignoriert/importiert, pro Nutzer im
    // Gateway) JETZT loeschen — beim Boot-Reset gibt es keine Auth mehr.
    // Best-effort: ein Offline-Reset soll nicht daran scheitern; dann
    // bleiben die Entscheidungen stehen (im Audit vermerkt).
    let radarDecisionsDeleted: number | null = null;
    try {
      const r = await gatewayClient.request<{ deleted: number }>(
        "/v1/discovery/decisions",
        { method: "DELETE" },
      );
      radarDecisionsDeleted = r.deleted;
    } catch (err) {
      console.warn(
        "[reset] Radar-Entscheidungen konnten nicht geloescht werden (offline?):",
        err instanceof Error ? err.message : String(err),
      );
    }
    audit({
      actorType: "user",
      actorId: null,
      category: "auth",
      action: "settings.reset.all-except-models",
      severity: "warning",
      subjectType: null,
      subjectId: null,
      summary:
        "Werksreset ausgelöst: alle lokalen Daten außer LLM-Modelle/Keys werden beim Neustart gelöscht" +
        (radarDecisionsDeleted !== null
          ? ` (${radarDecisionsDeleted} zentrale Radar-Entscheidungen gelöscht)`
          : " (zentrale Radar-Entscheidungen NICHT erreichbar — bleiben bestehen)"),
      metadata: { radarDecisionsDeleted },
    });
    // Kurze Verzögerung, damit die IPC-Antwort + das Audit-Log noch
    // durchgehen, bevor der Prozess neu startet.
    setTimeout(() => {
      requestResetExceptModels();
    }, 250);
    return { ok: true };
  });
}

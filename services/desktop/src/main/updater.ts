import { autoUpdater, type UpdateInfo, type ProgressInfo } from "electron-updater";
import { app, BrowserWindow, Notification } from "electron";
import { EventEmitter } from "node:events";
import { promises as fs } from "node:fs";
import { existsSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import type {
  UpdateDiagnostics,
  UpdateProgress,
  UpdateState,
  UpdateStatus,
} from "../shared/types";
import { scrubQuarantine, scrubPathExplicit } from "./scrub-quarantine";

// Auto-update via electron-updater (Phase 8.u4 — finally landed in
// 8.v1.5; substantially reworked in v0.1.155 after silent-install
// failures on the user's machine).
//
// Lifecycle:
//   1. App boots, Updater.start() runs once on app.whenReady. At this
//      point we also check whether the PREVIOUS boot tried to install
//      an update that didn't actually take — if so we surface a
//      silent-install-failed flag the renderer can show.
//   2. autoUpdater.checkForUpdates() — async, non-blocking
//   3. event 'update-available' → setState("available")
//   4. user clicks Download → autoUpdater.downloadUpdate() →
//      'download-progress' frames, then 'update-downloaded'
//   5. event 'update-downloaded' → setState("ready") AND scrub
//      quarantine on the EXACT downloaded artifact (info.downloadedFile).
//      Doing it here, before the user clicks install, is the only
//      timing that guarantees the .zip is on disk + the scrub
//      completes before Squirrel.Mac touches it.
//   6. User clicks "Update installieren" → IPC 'updater:install'
//      → write "expected version" marker → autoUpdater.quitAndInstall()
//      → app relaunches. Next boot compares running version to
//      the marker; mismatch ⇒ silent failure surfaced to the user.
//
// What changed in v0.1.155 vs. the v0.1.57 attempt:
//   - Scrub timing moved from pre-quitAndInstall to update-downloaded.
//     Earlier the scrub ran on a directory path that often didn't yet
//     contain the artifact; now we scrub the exact file electron-updater
//     reports.
//   - autoInstallOnAppQuit flipped to true. Belt-and-suspenders: if
//     quitAndInstall fails to spawn Squirrel cleanly, the next normal
//     Cmd-Q will retry. The user previously had no fallback.
//   - Silent-install detection: a pending-install marker on disk +
//     boot-time version compare turns "it didn't work and I don't
//     know why" into a visible UI signal.

// v0.1.230 — auf 15 Min runter. Vorher 4h, was bei aktiver
// Entwicklungs-Phase (mehrere Releases pro Tag) den Banner faktisch
// unsichtbar machte: Nutzer schließen die App tags öfter, kommen
// nie an die 4h-Marke. 15 Min ist nah genug am „während ich arbeite"-
// Fenster, dass mindestens eine Release-Welle pro Sitzung den Popup
// triggert.
const CHECK_INTERVAL_MS = 15 * 60 * 1000;

/** Persistent marker we write right before quitAndInstall. Read on
 *  next boot to detect a silent failure (running version unchanged
 *  despite the install attempt). Path is under userData so it survives
 *  the .app swap and is per-installation. */
function pendingInstallMarkerPath(): string {
  return join(app.getPath("userData"), "pending-install.json");
}

/** Squirrel.Mac log directory. ShipIt writes stderr/stdout logs here
 *  on macOS; surfacing the path is our best diagnostic when an install
 *  fails after the parent process is already dead. */
function squirrelLogDir(): string {
  // Squirrel.Mac's per-app cache dir. The appId is fixed in
  // electron-builder.yml.
  return join(homedir(), "Library", "Caches", "com.ava.desktop.ShipIt");
}

/** electron-log's default location for electron-updater's own logs. */
function electronUpdaterLogPath(): string {
  // electron-updater pipes through electron-log; on macOS the file is
  // under <userData>/logs/. We surface this so the user can attach it
  // even when Squirrel itself didn't get far enough to log.
  return join(app.getPath("userData"), "logs", "main.log");
}

export class Updater extends EventEmitter {
  private state: UpdateState = "idle";
  private latestVersion: string | null = null;
  /** v0.1.279 — Dedup-Cursor für die native OS-Notification. Wenn der
   *  15min-Check zum dritten Mal dieselbe Version meldet, soll der User
   *  nicht erneut angepiept werden. */
  private lastNotifiedVersion: string | null = null;
  private progress: UpdateProgress | null = null;
  private errorMessage: string | null = null;
  private silentInstallFailedFromVersion: string | null = null;
  private interval: NodeJS.Timeout | null = null;
  private started = false;
  /** Path electron-updater reports on `update-downloaded`. We hold
   *  onto it so the manual install path can re-scrub if needed and so
   *  we can include it in diagnostics. */
  private downloadedFilePath: string | null = null;

  async start(): Promise<void> {
    if (this.started) return;
    this.started = true;

    if (!app.isPackaged) {
      // Dev mode: no updater, would point at GitHub Releases for
      // a tag that may not match the dev version anyway.
      console.log("[updater] skipped — not packaged");
      return;
    }

    // Inject the build-time-baked GH_TOKEN so electron-updater can
    // talk to the private repo's releases.atom feed. See
    // electron.vite.config.ts's `define` block for the source.
    const bakedToken = process.env.AVA_RELEASE_TOKEN;
    if (bakedToken && !process.env.GH_TOKEN) {
      process.env.GH_TOKEN = bakedToken;
    }

    // v0.1.279 — autoDownload=true. Vorher false (User musste explizit
    // "Download" klicken); mit aktiven Release-Wellen mehrfach pro Tag
    // hat das den Updater faktisch nutzlos gemacht, weil die meisten
    // Nutzer den Banner nicht bewusst angesehen haben. Jetzt: Update
    // wird im Hintergrund gezogen; der Nutzer muss nur noch den
    // Neustart bestätigen ("Neu starten, um zu aktualisieren").
    // autoInstallOnAppQuit bleibt true als Sicherheitsnetz: wenn der
    // Nutzer die App regulär schließt ohne neu zu starten, holt der
    // nächste Cmd-Q die Installation nach.
    autoUpdater.autoDownload = true;
    autoUpdater.autoInstallOnAppQuit = true;
    autoUpdater.logger = {
      info: (m: unknown) => console.log("[updater]", m),
      warn: (m: unknown) => console.warn("[updater]", m),
      error: (m: unknown) => console.error("[updater]", m),
      debug: (m: unknown) => console.log("[updater]", m),
    };

    autoUpdater.on("checking-for-update", () => {
      console.info("[updater] check started");
      this.setState("checking");
    });
    autoUpdater.on("update-available", (info: UpdateInfo) => {
      console.info(
        `[updater] update-available: current=${app.getVersion()} → latest=${info.version}`,
      );
      this.latestVersion = info.version;
      this.setState("available");
      // v0.1.279 — native OS-Notification. Mit autoDownload=true springt
      // der State direkt weiter zu "downloading", aber die OS-Bubble bleibt
      // sichtbar auch wenn AVA im Hintergrund läuft. Dedupliziert pro
      // Version damit der User nicht alle 15min angepiept wird.
      if (this.lastNotifiedVersion !== info.version) {
        this.lastNotifiedVersion = info.version;
        try {
          new Notification({
            title: `AVA-Update v${info.version} verfügbar`,
            body: 'Wird im Hintergrund heruntergeladen. Klick auf AVA, sobald „Neu starten" angezeigt wird.',
            silent: false,
          }).show();
        } catch (err) {
          // Notifications nicht freigegeben oder Plattform-Quirk — kein
          // Drama, in-app banner zeigt es eh auch.
          console.warn(
            "[updater] OS-Notification fehlgeschlagen:",
            err instanceof Error ? err.message : String(err),
          );
        }
      }
    });
    autoUpdater.on("update-not-available", (info: UpdateInfo) => {
      console.info(
        `[updater] up-to-date: running v${app.getVersion()} (server reports latest=${info.version})`,
      );
      this.latestVersion = info.version;
      this.setState("up-to-date");
    });
    autoUpdater.on("download-progress", (p: ProgressInfo) => {
      this.progress = {
        bytesPerSec: p.bytesPerSecond,
        percent: p.percent,
        transferred: p.transferred,
        total: p.total,
      };
      this.emit("status", this.snapshot());
    });
    autoUpdater.on(
      "update-downloaded",
      (info: UpdateInfo & { downloadedFile?: string }) => {
        this.latestVersion = info.version;
        // v0.1.279 — zweite OS-Notification: jetzt ist Action gefragt.
        // "Klick → Neustart" geht zwar nicht direkt aus der Notification
        // (Electron-Notifications haben keine Actions auf macOS ohne
        // app-bundled Helper), aber der Body sagt dem User wohin er
        // klicken soll.
        try {
          new Notification({
            title: `AVA-Update v${info.version} bereit`,
            body: 'Klick auf das AVA-Icon und dann auf „Neu starten, um zu aktualisieren".',
            silent: false,
          }).show();
        } catch (err) {
          console.warn(
            "[updater] update-downloaded OS-Notification fehlgeschlagen:",
            err instanceof Error ? err.message : String(err),
          );
        }
        // v0.1.155 — scrub quarantine on the EXACT artifact path
        // electron-updater reports, the moment it lands. This is the
        // only timing where (a) the file definitely exists, and (b)
        // Squirrel hasn't touched it yet. The earlier scrub-before-
        // quitAndInstall was racing the user's click and frequently
        // ran on a stale or wrong path.
        const filePath = info.downloadedFile ?? null;
        this.downloadedFilePath = filePath;
        if (filePath) {
          void scrubPathExplicit(filePath).catch((err) => {
            console.warn(
              "[updater] update-downloaded scrub failed:",
              (err as Error).message,
            );
          });
        }
        this.setState("ready");
      },
    );
    autoUpdater.on("error", (err: Error) => {
      console.warn(
        `[updater] error in autoUpdater pipeline: ${err.message}`,
      );
      this.errorMessage = err.message;
      this.setState("error");
    });

    // v0.1.155 — surface a previous boot's silent install failure
    // BEFORE we kick the next check, so the renderer paints the
    // banner immediately. Doesn't block startup.
    await this.detectSilentInstallFailure();

    void this.check();
    this.interval = setInterval(() => void this.check(), CHECK_INTERVAL_MS);
  }

  stop(): void {
    if (this.interval) {
      clearInterval(this.interval);
      this.interval = null;
    }
  }

  async check(): Promise<void> {
    if (!app.isPackaged) {
      console.info(
        "[updater] check() skipped — app.isPackaged is false (dev mode).",
      );
      return;
    }
    try {
      await autoUpdater.checkForUpdates();
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      console.warn(`[updater] check() threw: ${msg}`);
      this.errorMessage = msg;
      this.setState("error");
    }
  }

  async download(): Promise<void> {
    if (this.state !== "available") return;
    this.setState("downloading");
    try {
      await autoUpdater.downloadUpdate();
    } catch (err) {
      this.errorMessage = err instanceof Error ? err.message : String(err);
      this.setState("error");
    }
  }

  /**
   * Quit, swap binaries, relaunch. Caller is responsible for
   * confirming with the user (we surface a prompt in the renderer).
   */
  installAndRelaunch(): void {
    if (this.state !== "ready") return;
    this.setState("installing");
    // v0.1.155 — write the "intent to install" marker BEFORE handing
    // off to Squirrel. On next boot we compare app.getVersion() to
    // this marker; mismatch ⇒ Squirrel silently failed and the user
    // sees a "Update auf X.Y.Z konnte nicht installiert werden"
    // banner. Without this the failure is completely invisible.
    void this.writePendingInstallMarker(this.latestVersion).catch((err) => {
      console.warn(
        "[updater] failed to write pending-install marker:",
        (err as Error).message,
      );
    });
    // Re-scrub the broad cache directories AND the specific downloaded
    // file. Cheap; covers the cases where Squirrel may have copied the
    // artifact to a sibling path since the update-downloaded event.
    const file = this.downloadedFilePath;
    void Promise.all([
      scrubQuarantine(),
      file ? scrubPathExplicit(file) : Promise.resolve(),
    ]).finally(() => {
      // Defer quitAndInstall so the IPC push has a tick to land in
      // the renderer before the main process tears down.
      setTimeout(() => autoUpdater.quitAndInstall(false, true), 100);
    });
  }

  getStatus(): UpdateStatus {
    return this.snapshot();
  }

  /**
   * v0.1.155 — surfaced log paths the user can attach when reporting
   * an OTA failure. The data is intentionally just metadata (path +
   * size + mtime); we don't ship log contents over IPC by default,
   * the renderer opens the file via shell.showItemInFolder.
   */
  async getDiagnostics(): Promise<UpdateDiagnostics> {
    const candidates: string[] = [];
    if (process.platform === "darwin") {
      const dir = squirrelLogDir();
      if (existsSync(dir)) {
        try {
          for (const name of await fs.readdir(dir)) {
            if (name.endsWith(".log") || name.endsWith(".txt")) {
              candidates.push(join(dir, name));
            }
          }
        } catch {
          /* ignore — directory unreadable */
        }
      }
    }
    candidates.push(electronUpdaterLogPath());

    const logs: UpdateDiagnostics["logs"] = [];
    for (const p of candidates) {
      if (!existsSync(p)) continue;
      try {
        const st = statSync(p);
        if (!st.isFile()) continue;
        logs.push({ path: p, sizeBytes: st.size, mtimeMs: st.mtimeMs });
      } catch {
        /* skip unreadable */
      }
    }
    const marker = await this.readPendingInstallMarker();
    return {
      platform: process.platform,
      logs,
      lastInstallAttempt: marker,
    };
  }

  /** Renderer-driven dismissal of the silent-failure banner. */
  dismissSilentFailure(): void {
    if (this.silentInstallFailedFromVersion === null) return;
    this.silentInstallFailedFromVersion = null;
    this.emit("status", this.snapshot());
  }

  // ---- Internal ------------------------------------------------------------

  private async writePendingInstallMarker(
    targetVersion: string | null,
  ): Promise<void> {
    if (!targetVersion) return;
    const payload = {
      version: targetVersion,
      at: new Date().toISOString(),
    };
    await fs.mkdir(app.getPath("userData"), { recursive: true });
    await fs.writeFile(
      pendingInstallMarkerPath(),
      JSON.stringify(payload),
      "utf8",
    );
  }

  private async readPendingInstallMarker(): Promise<
    { version: string; at: string } | null
  > {
    const path = pendingInstallMarkerPath();
    if (!existsSync(path)) return null;
    try {
      const raw = await fs.readFile(path, "utf8");
      const parsed = JSON.parse(raw) as { version?: unknown; at?: unknown };
      if (typeof parsed.version !== "string" || typeof parsed.at !== "string") {
        return null;
      }
      return { version: parsed.version, at: parsed.at };
    } catch {
      return null;
    }
  }

  private async clearPendingInstallMarker(): Promise<void> {
    await fs.unlink(pendingInstallMarkerPath()).catch(() => undefined);
  }

  private async detectSilentInstallFailure(): Promise<void> {
    const marker = await this.readPendingInstallMarker();
    if (!marker) return;
    const running = app.getVersion();
    if (running === marker.version) {
      // The install succeeded — running version matches the intent.
      // Clear the marker so we don't fire on subsequent boots.
      await this.clearPendingInstallMarker();
      return;
    }
    // Running version differs from the install intent → Squirrel
    // silently failed. Surface to the renderer; do NOT clear the
    // marker yet — clearing it on dismiss lets the user re-trigger
    // the diagnostic if they Cmd-Q before reading the banner.
    console.warn(
      `[updater] silent install failure detected: intent=${marker.version} running=${running}`,
    );
    this.silentInstallFailedFromVersion = marker.version;
    // Emit so a Settings panel already mounted picks it up.
    this.emit("status", this.snapshot());
  }

  private snapshot(): UpdateStatus {
    return {
      state: this.state,
      currentVersion: app.getVersion(),
      latestVersion: this.latestVersion,
      progress: this.progress,
      errorMessage: this.errorMessage,
      silentInstallFailedFromVersion: this.silentInstallFailedFromVersion,
    };
  }

  private setState(next: UpdateState): void {
    if (this.state !== next) {
      console.info(`[updater] state: ${this.state} → ${next}`);
    }
    this.state = next;
    if (next !== "error") this.errorMessage = null;
    this.emit("status", this.snapshot());
  }
}

/**
 * Broadcast helper used by main/index.ts wiring.
 */
export function broadcastUpdateStatus(status: UpdateStatus): void {
  for (const win of BrowserWindow.getAllWindows()) {
    win.webContents.send("updater-status:changed", status);
  }
}

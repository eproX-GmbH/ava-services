import { autoUpdater, type UpdateInfo, type ProgressInfo } from "electron-updater";
import { app, BrowserWindow } from "electron";
import { EventEmitter } from "node:events";
import type {
  UpdateProgress,
  UpdateState,
  UpdateStatus,
} from "../shared/types";

// Auto-update via electron-updater (Phase 8.u4 — finally landed in
// 8.v1.5).
//
// Talks to the GitHub Releases feed configured in
// `electron-builder.yml`'s `publish:` block. On launch we ask
// GitHub for the latest tag matching `vX.Y.Z`; if it's newer than
// the installed `app.getVersion()` we download it in the
// background and surface a "Restart to update" prompt to the
// renderer. The user always sees + confirms the download — no
// silent autorun.
//
// Auth / signing inheritance:
//   - macOS: the .dmg shipped to the user is already signed +
//     notarised by our Developer ID Application cert. The
//     downloaded update inherits that trust chain; macOS
//     verifies the signature before swapping the app in.
//   - Windows: deferred (Windows builds are CI-disabled in v0.1.24)
//
// Lifecycle:
//   1. App boots, Updater.start() runs once on app.whenReady
//   2. autoUpdater.checkForUpdates() — async, non-blocking
//   3. event 'update-available' → setState("downloading")
//   4. event 'download-progress' → emit progress to renderer
//   5. event 'update-downloaded' → setState("ready") + IPC
//      'updater-status:changed'
//   6. User clicks "Update installieren" → IPC 'updater:install'
//      → autoUpdater.quitAndInstall() relaunches with new version
//
// Errors are non-fatal: the user keeps the running version. We
// log the error message + push a status snapshot the renderer can
// surface in the Settings panel.

const CHECK_INTERVAL_MS = 4 * 60 * 60 * 1000; // 4h re-check while open

export class Updater extends EventEmitter {
  private state: UpdateState = "idle";
  private latestVersion: string | null = null;
  private progress: UpdateProgress | null = null;
  private errorMessage: string | null = null;
  private interval: NodeJS.Timeout | null = null;
  private started = false;

  start(): void {
    if (this.started) return;
    this.started = true;

    if (!app.isPackaged) {
      // Dev mode: no updater, would point at GitHub Releases for
      // a tag that may not match the dev version anyway.
      console.log("[updater] skipped — not packaged");
      return;
    }

    // Don't auto-download — we surface the prompt and the user
    // confirms. Avoids surprising "where did my disk space go"
    // behaviour for slow connections.
    autoUpdater.autoDownload = false;
    autoUpdater.autoInstallOnAppQuit = false;
    // Keep electron-updater's logger going to console; we already
    // tag main-process output with `[component]` prefixes elsewhere.
    autoUpdater.logger = {
      info: (m: unknown) => console.log("[updater]", m),
      warn: (m: unknown) => console.warn("[updater]", m),
      error: (m: unknown) => console.error("[updater]", m),
      debug: (m: unknown) => console.log("[updater]", m),
    };

    autoUpdater.on("checking-for-update", () => {
      this.setState("checking");
    });
    autoUpdater.on("update-available", (info: UpdateInfo) => {
      this.latestVersion = info.version;
      this.setState("available");
    });
    autoUpdater.on("update-not-available", (info: UpdateInfo) => {
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
    autoUpdater.on("update-downloaded", (info: UpdateInfo) => {
      this.latestVersion = info.version;
      this.setState("ready");
    });
    autoUpdater.on("error", (err: Error) => {
      this.errorMessage = err.message;
      this.setState("error");
    });

    void this.check();
    this.interval = setInterval(() => void this.check(), CHECK_INTERVAL_MS);
  }

  stop(): void {
    if (this.interval) {
      clearInterval(this.interval);
      this.interval = null;
    }
  }

  /**
   * Manual check trigger from the Settings panel — same path as the
   * scheduled interval, but the renderer can call it on demand.
   */
  async check(): Promise<void> {
    if (!app.isPackaged) return;
    try {
      await autoUpdater.checkForUpdates();
    } catch (err) {
      this.errorMessage = err instanceof Error ? err.message : String(err);
      this.setState("error");
    }
  }

  /**
   * Download the available update. No-op if state is anything other
   * than `available`.
   */
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
    autoUpdater.quitAndInstall(false, true);
  }

  getStatus(): UpdateStatus {
    return this.snapshot();
  }

  private snapshot(): UpdateStatus {
    return {
      state: this.state,
      currentVersion: app.getVersion(),
      latestVersion: this.latestVersion,
      progress: this.progress,
      errorMessage: this.errorMessage,
    };
  }

  private setState(next: UpdateState): void {
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

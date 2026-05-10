// LinkedIn-Beobachter IPC surface.
//
// L0: master switch + consent + image-analysis controls + kill-switch.
// L1: embedded-BrowserWindow login flow + encrypted cookie store +
//     auth status + fingerprint scaffolding.
// The renderer NEVER receives the raw cookies — only the metadata
// (capturedAt, earliestExpiresAt, memberUrn). The cookies stay on this
// device, encrypted via safeStorage, and L2's main-process scraper
// will read them directly when constructing its Playwright context.

import { app, BrowserWindow, ipcMain } from "electron";
import type {
  LinkedInAuthStatus,
  LinkedInFeedCounts,
  LinkedInImageAnalysisStatus,
  LinkedInLoginResult,
  LinkedInRecentPost,
  LinkedInScanResult,
  LinkedInScanStatus,
  LinkedInSettings,
  LinkedInSignalStatus,
} from "../../shared/types";
import {
  attachProviders as attachExtractorProviders,
  cancelDrain as cancelExtractorDrain,
  drainQueue as drainSignalQueue,
  imageAnalysisStatusSnapshot,
  onLinkedInSettingsChanged,
  statusSnapshot as signalStatusSnapshot,
} from "./extractor";
import type { LlmProviderManager } from "../agent/providers";
import { ProviderConfigStore } from "../agent/providers";
import { read, write, reset } from "./store";
import {
  clearStoredSession,
  hasStoredSession,
  readStoredMeta,
} from "./session";
import { runLoginFlow } from "./login-window";
import { generateFingerprint } from "./fingerprint";
import {
  cancelActiveScan,
  feedCountsSnapshot,
  runScan,
  scanStatusSnapshot,
  shutdownScraper,
} from "./scraper";
import { getDb, recentPosts } from "./db";
import { startScheduler, stopScheduler } from "./scheduler";

/** Generate + persist the fingerprint on first run if it's missing.
 *  Idempotent — safe to call on every boot. */
function ensureFingerprint(): void {
  const current = read();
  if (!current.fingerprint) {
    write({ fingerprint: generateFingerprint() });
  }
}

export function initLinkedIn(opts?: { providers?: LlmProviderManager }): void {
  ensureFingerprint();

  if (opts?.providers) {
    attachExtractorProviders(opts.providers, ProviderConfigStore.shared());
  }

  ipcMain.handle("linkedin:settings:get", (): LinkedInSettings => read());

  ipcMain.handle(
    "linkedin:settings:update",
    (_e, partial: Partial<LinkedInSettings>): LinkedInSettings | { error: string } => {
      const current = read();
      const next: LinkedInSettings = { ...current, ...partial };

      // Consent gate: cannot enable without an accepted consent.
      if (next.enabled && !next.consentAcceptedAt) {
        return { error: "Consent not accepted. Run linkedin:consent:accept first." };
      }

      // Cloud image analysis requires a separate explicit opt-in.
      if (next.imageAnalysis === "cloud" && !next.imageAnalysisCloudOptIn) {
        return { error: "Cloud image analysis requires explicit opt-in." };
      }

      // Clamp scanIntervalHours to [1, 24].
      if (typeof partial.scanIntervalHours === "number") {
        const clamped = Math.max(1, Math.min(24, Math.round(partial.scanIntervalHours)));
        next.scanIntervalHours = clamped;
      }

      const result = write(next);
      // L4: when imageAnalysis or cloud opt-in changes, give skipped
      // image rows another chance and trigger a drain. The store-side
      // listener handles provider/key changes; this handles the
      // LinkedIn-specific settings the agent provider doesn't know about.
      if (
        partial.imageAnalysis !== undefined ||
        partial.imageAnalysisCloudOptIn !== undefined
      ) {
        onLinkedInSettingsChanged();
      }
      return result;
    },
  );

  ipcMain.handle("linkedin:consent:accept", (): LinkedInSettings => {
    return write({ consentAcceptedAt: Date.now() });
  });

  ipcMain.handle("linkedin:consent:revoke", (): LinkedInSettings => {
    // Disconnecting consent also drops the stored session — leaving
    // cookies on disk after the user revoked their explicit consent
    // would violate the "data is here only because you said yes" promise.
    clearStoredSession();
    return write({ consentAcceptedAt: null, enabled: false });
  });

  ipcMain.handle("linkedin:killswitch", (): { ok: true } => {
    reset();
    // After reset() the fingerprint is gone too — regenerate so the
    // settings file is consistent on the next read.
    ensureFingerprint();
    return { ok: true };
  });

  // ---- L1 auth surface --------------------------------------------------

  ipcMain.handle("linkedin:auth:status", (): LinkedInAuthStatus => {
    const meta = readStoredMeta();
    return { connected: hasStoredSession() && meta !== null, meta };
  });

  ipcMain.handle("linkedin:auth:openLogin", async (event): Promise<LinkedInLoginResult> => {
    // Prefer the BrowserWindow that owns the invoking webContents;
    // fall back to the focused window so the modal binds to something
    // sensible even when invoked from an unusual context.
    const parent =
      BrowserWindow.fromWebContents(event.sender) ??
      BrowserWindow.getFocusedWindow();
    return await runLoginFlow(parent);
  });

  ipcMain.handle("linkedin:auth:disconnect", (): { ok: true } => {
    clearStoredSession();
    return { ok: true };
  });

  // ---- L2 scan + feed surface ------------------------------------------

  ipcMain.handle(
    "linkedin:scan:run",
    async (
      _e,
      args: { manual?: boolean; maxPosts?: number } | undefined,
    ): Promise<LinkedInScanResult> => {
      return await runScan({
        manual: args?.manual === true,
        maxPosts: args?.maxPosts,
      });
    },
  );

  ipcMain.handle("linkedin:scan:cancel", (): { ok: true } => {
    cancelActiveScan();
    return { ok: true };
  });

  ipcMain.handle(
    "linkedin:scan:status",
    async (): Promise<LinkedInScanStatus> => {
      return await scanStatusSnapshot();
    },
  );

  ipcMain.handle(
    "linkedin:feed:counts",
    async (): Promise<LinkedInFeedCounts> => {
      return await feedCountsSnapshot();
    },
  );

  ipcMain.handle(
    "linkedin:feed:recent",
    async (
      _e,
      args: { limit?: number; offset?: number; since?: number } | undefined,
    ): Promise<LinkedInRecentPost[]> => {
      const db = await getDb();
      return await recentPosts(db, args ?? {});
    },
  );

  // ---- L3 signal extraction surface -----------------------------------

  ipcMain.handle(
    "linkedin:signals:status",
    async (): Promise<LinkedInSignalStatus> => {
      return await signalStatusSnapshot();
    },
  );

  ipcMain.handle(
    "linkedin:signals:run",
    async (): Promise<LinkedInSignalStatus> => {
      return await drainSignalQueue({ limit: 100 });
    },
  );

  ipcMain.handle("linkedin:signals:cancel", (): { ok: true } => {
    cancelExtractorDrain();
    return { ok: true };
  });

  // ---- L4 image-analysis surface --------------------------------------

  ipcMain.handle(
    "linkedin:images:status",
    async (): Promise<LinkedInImageAnalysisStatus> => {
      return await imageAnalysisStatusSnapshot();
    },
  );

  // Background scheduler — re-arms automatically on settings changes.
  startScheduler();

  // Clean shutdown
  app.on("before-quit", () => {
    stopScheduler();
    void shutdownScraper();
  });
}

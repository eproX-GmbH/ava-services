// LinkedIn-Beobachter background scheduler (Phase L2).
//
// Owns a single setInterval that fires `runScan({ manual: false })`
// at the user-configured cadence. Re-arms whenever the settings
// change (the store emits `changed` on every `write`). Skips firing
// when the app has no focused BrowserWindow — LinkedIn is more
// tolerant of activity that LOOKS like a real user, and unattended
// scans add risk without much benefit.
//
// Single-flight: the scraper itself rejects concurrent runs, but we
// also guard here to avoid spamming the scraper with rejected calls.

import { BrowserWindow } from "electron";
import { isScanRunning, runScan } from "./scraper";
import { linkedInSettingsEvents, read as readSettings } from "./store";

let timer: NodeJS.Timeout | null = null;

function clear(): void {
  if (timer) {
    clearInterval(timer);
    timer = null;
  }
}

async function tick(): Promise<void> {
  if (isScanRunning()) return;
  // Skip when the app isn't in the foreground.
  if (!BrowserWindow.getFocusedWindow()) return;
  const s = readSettings();
  if (!s.enabled || !s.automaticScans || !s.consentAcceptedAt) return;
  try {
    await runScan({ manual: false });
  } catch (err) {
    console.warn(
      "[linkedin/scheduler] tick failed:",
      err instanceof Error ? err.message : String(err),
    );
  }
}

function arm(): void {
  clear();
  const s = readSettings();
  if (!s.enabled || !s.automaticScans) return;
  const hours = Math.max(1, Math.min(24, s.scanIntervalHours || 4));
  const ms = hours * 60 * 60 * 1000;
  timer = setInterval(() => {
    void tick();
  }, ms);
  // Don't keep the event loop alive just to schedule the next scan;
  // the renderer windows already do that.
  if (timer.unref) timer.unref();
}

export function startScheduler(): void {
  arm();
  linkedInSettingsEvents.on("changed", () => {
    arm();
  });
}

export function stopScheduler(): void {
  clear();
  linkedInSettingsEvents.removeAllListeners("changed");
}

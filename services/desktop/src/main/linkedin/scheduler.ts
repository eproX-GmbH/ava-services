// LinkedIn-Beobachter background scheduler (Phase L2).
//
// Owns a single setInterval that fires `runScan({ manual: false })`
// at the user-configured cadence. Re-arms when SCHEDULE-RELEVANTE
// Settings sich ändern (enabled, automaticScans, scanIntervalHours).
//
// v0.1.310 — Re-Arm-Loop-Fix: vorher hat jedes write() der Settings
// (auch innerhalb von runScan, das `lastScanAt` setzt) ein 'changed'-
// Event gefeuert → arm() lief erneut → frischer 30s-Initial-Tick →
// Scan → write → … Loop alle ~2 Minuten statt einmal pro Stunde.
// Real-Run zeigte 10 Scans in ~17min. Jetzt: arm() merkt sich die
// schedule-relevanten Settings, und der changed-Listener vergleicht
// vor dem Re-Arm. Identisch → ignore, keine Loop.
//
// v0.1.306 — Fokus-Check abgeschwächt + initial-Tick.
//   show-Fokus-Gate auf "irgendein lebendes Window" reduziert.
//   Initial-Tick 30s nach arm() damit nach App-Start nicht erst N
//   Stunden gewartet wird bis der erste Scan läuft.
//
// Single-flight: the scraper itself rejects concurrent runs, but we
// also guard here to avoid spamming the scraper with rejected calls.

import { BrowserWindow } from "electron";
import { isScanRunning, runScan } from "./scraper";
import { linkedInSettingsEvents, read as readSettings } from "./store";

let timer: NodeJS.Timeout | null = null;
let initialTickHandle: NodeJS.Timeout | null = null;

/**
 * v0.1.310 — Snapshot der schedule-relevanten Settings beim letzten
 * arm(). Wird im changed-Listener verglichen, damit nur ECHTE
 * Schedule-Änderungen (User toggelt automaticScans, ändert Interval)
 * ein Re-Arm triggern. lastScanAt-Updates aus dem Scan-Result
 * werden ignoriert.
 */
type ScheduleKeys = Pick<
  ReturnType<typeof readSettings>,
  "enabled" | "automaticScans" | "scanIntervalHours" | "consentAcceptedAt"
>;
let lastArmKeys: ScheduleKeys | null = null;

function clear(): void {
  if (timer) {
    clearInterval(timer);
    timer = null;
  }
  if (initialTickHandle) {
    clearTimeout(initialTickHandle);
    initialTickHandle = null;
  }
}

async function tick(reason: "initial" | "interval"): Promise<void> {
  if (isScanRunning()) {
    console.log(
      `[linkedin/scheduler] tick (${reason}) skipped — already running`,
    );
    return;
  }
  // v0.1.306 — Mindest-Voraussetzung: AVA hat überhaupt noch ein
  // lebendes Window (nicht alle zugemacht). „Focused" war zu streng.
  const wins = BrowserWindow.getAllWindows().filter((w) => !w.isDestroyed());
  if (wins.length === 0) {
    console.log(
      `[linkedin/scheduler] tick (${reason}) skipped — no live BrowserWindow`,
    );
    return;
  }
  const s = readSettings();
  if (!s.enabled || !s.automaticScans || !s.consentAcceptedAt) {
    console.log(
      `[linkedin/scheduler] tick (${reason}) skipped — settings: enabled=${s.enabled}, automaticScans=${s.automaticScans}, consentAccepted=${!!s.consentAcceptedAt}`,
    );
    return;
  }
  console.log(`[linkedin/scheduler] tick (${reason}) — running scan now`);
  try {
    await runScan({ manual: false });
  } catch (err) {
    console.warn(
      `[linkedin/scheduler] tick (${reason}) failed:`,
      err instanceof Error ? err.message : String(err),
    );
  }
}

function extractScheduleKeys(s: ReturnType<typeof readSettings>): ScheduleKeys {
  return {
    enabled: s.enabled,
    automaticScans: s.automaticScans,
    scanIntervalHours: s.scanIntervalHours,
    consentAcceptedAt: s.consentAcceptedAt,
  };
}

function scheduleKeysEqual(
  a: ScheduleKeys | null,
  b: ScheduleKeys,
): boolean {
  if (!a) return false;
  return (
    a.enabled === b.enabled &&
    a.automaticScans === b.automaticScans &&
    a.scanIntervalHours === b.scanIntervalHours &&
    a.consentAcceptedAt === b.consentAcceptedAt
  );
}

function arm(opts?: { runInitial?: boolean }): void {
  const runInitial = opts?.runInitial !== false;
  clear();
  const s = readSettings();
  lastArmKeys = extractScheduleKeys(s);
  if (!s.enabled || !s.automaticScans) {
    console.log(
      `[linkedin/scheduler] arm() skipped — settings: enabled=${s.enabled}, automaticScans=${s.automaticScans}`,
    );
    return;
  }
  const hours = Math.max(1, Math.min(24, s.scanIntervalHours || 4));
  const ms = hours * 60 * 60 * 1000;
  console.log(
    `[linkedin/scheduler] armed — interval=${hours}h, next tick in ${ms / 1000}s${runInitial ? " (plus initial in 30s)" : ""}`,
  );
  timer = setInterval(() => {
    void tick("interval");
  }, ms);
  if (timer.unref) timer.unref();
  if (runInitial) {
    // v0.1.306 — Initial-Tick mit 30s Delay nur beim ECHTEN Start
    // (App-Boot oder User-Toggle), nicht bei jedem Re-Arm. Sonst
    // Loop wie in v0.1.306-v0.1.309 (siehe Header-Kommentar).
    initialTickHandle = setTimeout(() => {
      void tick("initial");
    }, 30_000);
    if (initialTickHandle.unref) initialTickHandle.unref();
  }
}

export function startScheduler(): void {
  arm({ runInitial: true });
  linkedInSettingsEvents.on("changed", () => {
    // v0.1.310 — Nur re-armen wenn sich SCHEDULE-relevante Settings
    // ändern. lastScanAt-Updates (nach jedem Scan), Fingerprint-
    // Rotation etc. emittieren auch 'changed', sollen aber den
    // Timer NICHT zurücksetzen.
    const next = extractScheduleKeys(readSettings());
    if (scheduleKeysEqual(lastArmKeys, next)) {
      return;
    }
    console.log(
      `[linkedin/scheduler] settings changed (schedule-relevant) — re-arming`,
    );
    // Echter Settings-Toggle → Initial-Tick wieder ja, damit User
    // sofort feedback bekommt dass die neuen Settings greifen.
    arm({ runInitial: true });
  });
}

export function stopScheduler(): void {
  clear();
  lastArmKeys = null;
  linkedInSettingsEvents.removeAllListeners("changed");
}

// LinkedIn-Beobachter background scheduler (Phase L2).
//
// Owns a single setInterval that fires `runScan({ manual: false })`
// at the user-configured cadence. Re-arms whenever the settings
// change (the store emits `changed` on every `write`).
//
// v0.1.306 — Fokus-Check abgeschwächt + initial-Tick.
//   Vorher: nur scan wenn BrowserWindow.getFocusedWindow() — also
//   AVA muss explizit das aktive Fenster sein. User sieht das nie,
//   weil er praktisch immer in einem anderen App ist (Browser,
//   Outlook, …). Ergebnis: automatische Scans lieten nie.
//   Jetzt: scan wenn mindestens ein lebendes AVA-Fenster existiert
//   (kann minimiert/hintergrund sein). Das matched die User-
//   Erwartung „läuft im Hintergrund" und ist immer noch sicherer
//   als „auch wenn AVA geschlossen" (was nicht ginge, weil der
//   Main-Process-Event-Loop dann eh weg ist).
//
//   Plus initial-Tick: bei arm() nach 30s einmal sofort feuern, damit
//   ein gerade gestartetes AVA nicht erst nach scanIntervalHours
//   das erste Mal scannt.
//
// Single-flight: the scraper itself rejects concurrent runs, but we
// also guard here to avoid spamming the scraper with rejected calls.

import { BrowserWindow } from "electron";
import { isScanRunning, runScan } from "./scraper";
import { linkedInSettingsEvents, read as readSettings } from "./store";

let timer: NodeJS.Timeout | null = null;
let initialTickHandle: NodeJS.Timeout | null = null;

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

function arm(): void {
  clear();
  const s = readSettings();
  if (!s.enabled || !s.automaticScans) {
    console.log(
      `[linkedin/scheduler] arm() skipped — settings: enabled=${s.enabled}, automaticScans=${s.automaticScans}`,
    );
    return;
  }
  const hours = Math.max(1, Math.min(24, s.scanIntervalHours || 4));
  const ms = hours * 60 * 60 * 1000;
  console.log(
    `[linkedin/scheduler] armed — interval=${hours}h, next tick in ${ms / 1000}s (plus initial in 30s)`,
  );
  timer = setInterval(() => {
    void tick("interval");
  }, ms);
  // Don't keep the event loop alive just to schedule the next scan;
  // the renderer windows already do that.
  if (timer.unref) timer.unref();
  // v0.1.306 — Initial-Tick mit 30s Delay. So lange braucht AVA
  // typisch um BrowserWindow + LinkedIn-Login-State + andere
  // Services hochzubringen. Ohne Delay läuft der erste Scan auf
  // einem half-initialised State und failed unschön.
  initialTickHandle = setTimeout(() => {
    void tick("initial");
  }, 30_000);
  if (initialTickHandle.unref) initialTickHandle.unref();
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

// Persistent file logger for the main process.
//
// Why this exists: until now, ALL of the app's diagnostic output
// (`[power] resume`, `[updater] …`, `[producer:…]`, `[ollama] …`, every
// console.* in main) only went to stdout. stdout is captured ONLY when
// the user launches the .app from a terminal — a normal Finder/Dock
// launch discards it. So when a real-world incident happens (the macOS
// V8-wake-deadlock: app frozen after the MacBook lid opens), there is
// no log to inspect afterwards. The user has to reproduce by quitting
// and relaunching from Terminal, which starts a FRESH process and never
// captures the wedged instance.
//
// This module mirrors every main-process console.* call (and uncaught
// errors, and renderer breadcrumbs forwarded over IPC) into a rotated
// file under the OS log dir (macOS: ~/Library/Logs/AVA/ava-main.log).
// It is initialized as the very first thing in main/index.ts so boot is
// captured too.
//
// Design notes:
//   - We KEEP the original console behavior (still writes to stdout) so
//     the terminal-launch developer affordance is unchanged.
//   - Writes are best-effort and never throw — a logging failure must
//     not take down the app.
//   - Size-based rotation (no timers): cheap, predictable, and survives
//     a process that gets SIGKILLed mid-write (which is exactly the
//     update-install / backstop case we care about).

import { app } from "electron";
import {
  appendFileSync,
  createWriteStream,
  existsSync,
  mkdirSync,
  readFileSync,
  renameSync,
  statSync,
  unlinkSync,
  writeFileSync,
  type WriteStream,
} from "node:fs";
import { join } from "node:path";

const MAX_BYTES = 8 * 1024 * 1024; // rotate at 8 MB
const MAX_FILES = 5; // keep ava-main.log + .1 … .4

const BASENAME = "ava-main.log";

// v0.1.340 — main-process liveness heartbeat.
//
// The macOS V8-Wake-Deadlock wedges the MAIN process so hard that not
// even the `[power] resume` log line gets written (confirmed in a real
// incident: the log ends at `[power] suspend` and goes silent — no
// resume, no crash, no new pid). When the whole JS event loop is frozen
// the file logger can't capture anything, because logging IS JS.
//
// The heartbeat is the workaround: a 2s timer truncates a tiny dedicated
// file with the current ISO timestamp + pid. When the event loop wedges,
// the timer stops firing, so the file's last value pinpoints the EXACT
// second main froze. On the next boot we read the previous instance's
// last heartbeat and log it — so the freeze timestamp lands in the new
// session's log even though the frozen instance couldn't write it.
const HEARTBEAT_BASENAME = "ava-heartbeat.txt";
const HEARTBEAT_INTERVAL_MS = 2_000;

let stream: WriteStream | null = null;
let logDir = "";
let logPath = "";
let heartbeatPath = "";
let heartbeatTimer: NodeJS.Timeout | null = null;
let bytesWritten = 0;
let initialized = false;
// v0.1.520 — Quit laeuft: Heartbeat traegt den " quit"-Marker, damit der
// Watchdog einen haengenden Quit kurz (8s) und OHNE Relaunch beendet.
let quitting = false;

// Captured before we monkey-patch, so our own writeLine can still reach
// the real stdout/stderr if it ever needs to (and so the patched
// console can call through to the originals).
const original = {
  log: console.log.bind(console),
  info: console.info.bind(console),
  warn: console.warn.bind(console),
  error: console.error.bind(console),
  debug: console.debug.bind(console),
};

function ts(): string {
  return new Date().toISOString();
}

function fmtArgs(args: unknown[]): string {
  return args
    .map((a) => {
      if (typeof a === "string") return a;
      if (a instanceof Error) return a.stack ?? `${a.name}: ${a.message}`;
      try {
        return JSON.stringify(a);
      } catch {
        return String(a);
      }
    })
    .join(" ");
}

function openStream(): void {
  try {
    stream = createWriteStream(logPath, { flags: "a" });
    bytesWritten = existsSync(logPath) ? statSync(logPath).size : 0;
  } catch {
    stream = null;
    bytesWritten = 0;
  }
}

function rotateIfNeeded(): void {
  if (bytesWritten < MAX_BYTES) return;
  try {
    stream?.end();
  } catch {
    /* ignore */
  }
  stream = null;
  // Shift ava-main.(N-1).log → ava-main.N.log, dropping the oldest.
  try {
    for (let i = MAX_FILES - 1; i >= 1; i--) {
      const from = i === 1 ? logPath : join(logDir, `ava-main.${i - 1}.log`);
      const to = join(logDir, `ava-main.${i}.log`);
      if (!existsSync(from)) continue;
      if (i === MAX_FILES - 1 && existsSync(to)) {
        try {
          unlinkSync(to);
        } catch {
          /* ignore */
        }
      }
      try {
        renameSync(from, to);
      } catch {
        /* ignore */
      }
    }
  } catch {
    /* ignore */
  }
  bytesWritten = 0;
  openStream();
}

function writeLine(level: string, line: string): void {
  if (!stream) return;
  const out = `${ts()} ${level} ${line}\n`;
  try {
    rotateIfNeeded();
    stream.write(out);
    bytesWritten += Buffer.byteLength(out);
  } catch {
    /* ignore — logging must never throw */
  }
}

/**
 * Patch console.* + install crash hooks + open the log file. Idempotent.
 * Call once, as early as possible in main/index.ts.
 */
export function initFileLogger(): void {
  if (initialized) return;
  initialized = true;

  try {
    // macOS → ~/Library/Logs/AVA ; Win → %APPDATA%/AVA/logs (userData
    // fallback if the "logs" path is unavailable pre-ready on some OSes).
    logDir = app.getPath("logs");
  } catch {
    logDir = join(app.getPath("userData"), "logs");
  }
  try {
    mkdirSync(logDir, { recursive: true });
  } catch {
    /* ignore */
  }
  logPath = join(logDir, BASENAME);
  openStream();

  console.log = (...a: unknown[]) => {
    original.log(...a);
    writeLine("INFO ", fmtArgs(a));
  };
  console.info = (...a: unknown[]) => {
    original.info(...a);
    writeLine("INFO ", fmtArgs(a));
  };
  console.warn = (...a: unknown[]) => {
    original.warn(...a);
    writeLine("WARN ", fmtArgs(a));
  };
  console.error = (...a: unknown[]) => {
    original.error(...a);
    writeLine("ERROR", fmtArgs(a));
  };
  console.debug = (...a: unknown[]) => {
    original.debug(...a);
    writeLine("DEBUG", fmtArgs(a));
  };

  // Last-resort capture. These often fire right before the process dies,
  // so flushing them to disk is the whole point of this module.
  process.on("uncaughtException", (err) => {
    writeLine("FATAL", `uncaughtException: ${err?.stack ?? String(err)}`);
  });
  process.on("unhandledRejection", (reason) => {
    writeLine(
      "FATAL",
      `unhandledRejection: ${reason instanceof Error ? reason.stack : String(reason)}`,
    );
  });

  writeLine(
    "INFO ",
    `=== file-logger started: AVA v${app.getVersion()} pid=${process.pid} platform=${process.platform} arch=${process.arch} ===`,
  );

  // Heartbeat. Read the PREVIOUS instance's last heartbeat first and log
  // it — if that instance wedged (V8-wake-deadlock), this is the only
  // record of the second it stopped ticking, surfaced into THIS boot's
  // log. Then start our own 2s tick.
  heartbeatPath = join(logDir, HEARTBEAT_BASENAME);
  try {
    if (existsSync(heartbeatPath)) {
      const prev = readFileSync(heartbeatPath, "utf8").trim();
      if (prev) {
        writeLine(
          "INFO ",
          `[heartbeat] previous instance last alive at: ${prev}`,
        );
      }
    }
  } catch {
    /* ignore */
  }
  // v0.1.485 — Event-Loop-Stall-Detektor huckepack auf dem Heartbeat:
  // feuert der 2s-Timer erst nach >10s, war der Main-Loop so lange
  // blockiert (oder das System schlief — dann steht direkt davor der
  // [power]-suspend-Log). Gibt Wedges eine Vorgeschichte im Log.
  let lastTickAt = Date.now();
  const tick = (): void => {
    const now = Date.now();
    const drift = now - lastTickAt - HEARTBEAT_INTERVAL_MS;
    lastTickAt = now;
    if (drift > 10_000) {
      writeLine("WARN ", `[heartbeat] event-loop stall: Tick kam ${drift}ms zu spaet`);
    }
    try {
      writeFileSync(
        heartbeatPath,
        `${ts()} pid=${process.pid} v${app.getVersion()}${quitting ? " quit" : ""}\n`,
      );
    } catch {
      /* best-effort — must never throw */
    }
  };
  tick();
  heartbeatTimer = setInterval(tick, HEARTBEAT_INTERVAL_MS);
  // v0.1.520 — FRUEHESTER before-quit-Handler (initFileLogger laeuft vor
  // allen anderen Registrierungen): Marker + synchrone Breadcrumb. Die
  // vier Wedges vom 1./2.9. lagen ALLE in der Quit-/Suspend-Kette, und
  // weil der normale Logger ueber einen gepufferten Stream schreibt,
  // gingen die letzten Zeilen vor dem SIGKILL verloren. Alles hier
  // schreibt deshalb SYNCHRON (appendFileSync).
  app.on("before-quit", () => {
    quitting = true;
    markHeartbeatQuit();
    writeLineSync("INFO ", `[quit] before-quit begin (v${app.getVersion()} pid=${process.pid})`);
  });
  app.on("will-quit", () => writeLineSync("INFO ", "[quit] will-quit"));
  app.on("quit", (_e, code) => writeLineSync("INFO ", `[quit] quit exitCode=${code}`));
  // Don't keep the event loop alive on quit just for the heartbeat.
  if (typeof heartbeatTimer.unref === "function") heartbeatTimer.unref();
}

/**
 * v0.1.485 — Schlaf-Marker in die Heartbeat-Datei schreiben. Der
 * powerMonitor-suspend-Handler ruft das SYNCHRON als allererstes auf:
 * macOS friert die Prozesse beim Einschlafen nicht gleichzeitig ein —
 * Main stand schon still, waehrend der Watchdog-Sidecar noch ~30s
 * weitertickte, den eingefrorenen Heartbeat als "wedged" wertete und
 * die App mitten im Einschlafen killte (Live-Befund 2026-08-31 14:29).
 * Der Watchdog pausiert die Stale-Zaehlung, solange der letzte
 * Heartbeat mit " suspend" endet.
 */
/** v0.1.520 — SYNCHRONE Log-Zeile (appendFileSync), fuer Breadcrumbs in
 *  Quit-/Suspend-Ketten, die ein Wedge sonst verschluckt. Sparsam nutzen. */
export function writeLineSync(level: string, line: string): void {
  if (!logPath) return;
  try {
    appendFileSync(logPath, `${ts()} ${level} ${line}\n`);
  } catch {
    /* best-effort */
  }
}

/**
 * v0.1.520 — Schritt der Quit-/Suspend-Kette mit synchronen Breadcrumbs
 * davor und danach (inkl. Dauer des SYNCHRONEN Anteils — bei async-
 * Funktionen also nur bis zum ersten await, und genau der Anteil kann
 * den Main-Thread blockieren). Fehler werden geloggt, nie geworfen:
 * ein kaputter Schritt darf die restliche Kette nicht abbrechen.
 */
export function traceStep(prefix: string, name: string, fn: () => unknown): void {
  writeLineSync("INFO ", `${prefix} > ${name}`);
  const t0 = Date.now();
  try {
    const r = fn();
    if (r && typeof (r as Promise<unknown>).catch === "function") {
      (r as Promise<unknown>).catch((err) =>
        writeLineSync("WARN ", `${prefix} ${name} async-fehler: ${err instanceof Error ? err.message : String(err)}`),
      );
    }
  } catch (err) {
    writeLineSync("WARN ", `${prefix} ${name} fehler: ${err instanceof Error ? err.message : String(err)}`);
  }
  writeLineSync("INFO ", `${prefix} < ${name} (${Date.now() - t0}ms sync)`);
}

export function quitStep(name: string, fn: () => unknown): void {
  traceStep("[quit]", name, fn);
}

/** v0.1.520 — Quit-Marker im Heartbeat (Zwilling zu markHeartbeatSuspend). */
export function markHeartbeatQuit(): void {
  if (!heartbeatPath) return;
  try {
    writeFileSync(
      heartbeatPath,
      `${ts()} pid=${process.pid} v${app.getVersion()} quit\n`,
    );
  } catch {
    /* best-effort — must never throw */
  }
}

export function markHeartbeatSuspend(): void {
  if (!heartbeatPath) return;
  try {
    writeFileSync(
      heartbeatPath,
      `${ts()} pid=${process.pid} v${app.getVersion()} suspend\n`,
    );
  } catch {
    /* best-effort — must never throw */
  }
}

/**
 * Append a line forwarded from the renderer process (console mirror over
 * IPC). Tagged `R/<level>` so renderer breadcrumbs are distinguishable
 * from main-process lines in the same file. Best-effort.
 */
export function logRendererLine(level: string, line: string): void {
  const tag = `R/${level.toUpperCase().slice(0, 4).padEnd(4)}`;
  writeLine(tag, line);
}

export function getLogDir(): string {
  return logDir;
}

export function getMainLogPath(): string {
  return logPath;
}

export function getHeartbeatPath(): string {
  return heartbeatPath;
}

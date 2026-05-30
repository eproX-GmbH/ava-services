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
  createWriteStream,
  existsSync,
  mkdirSync,
  renameSync,
  statSync,
  unlinkSync,
  type WriteStream,
} from "node:fs";
import { join } from "node:path";

const MAX_BYTES = 8 * 1024 * 1024; // rotate at 8 MB
const MAX_FILES = 5; // keep ava-main.log + .1 … .4

const BASENAME = "ava-main.log";

let stream: WriteStream | null = null;
let logDir = "";
let logPath = "";
let bytesWritten = 0;
let initialized = false;

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

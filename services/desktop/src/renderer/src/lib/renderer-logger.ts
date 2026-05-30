// Renderer-side breadcrumb mirror (v0.1.338).
//
// Why this exists: the macOS V8-Wake-Deadlock wedges the RENDERER event
// loop after the laptop lid opens. When that happens the renderer's
// console output (React errors, our own diagnostic logs, the last thing
// that ran before the freeze) is gone the moment the window is reloaded
// or the app is force-quit — DevTools isn't open on a normal launch and
// stdout from the renderer isn't captured anyway.
//
// This module mirrors every renderer console.* call, plus window
// `error` / `unhandledrejection`, over IPC into the persistent
// main-process log file (~/Library/Logs/AVA/ava-main.log). Lines land
// tagged `R/<level>` so they interleave with main-process lines in one
// timeline — exactly what you want when reconstructing "what was the app
// doing in the seconds before it froze".
//
// Design notes:
//   - We KEEP the original console behavior (DevTools still works).
//   - The forward is fire-and-forget (ipcRenderer.send, never invoke):
//     a wedged main process must not block the renderer, and a logging
//     failure must never throw into app code.
//   - Installed as the very first thing in main.tsx so boot is captured.

const MAX_LINE = 8192;

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

let installed = false;

/**
 * Patch console.* + install window error hooks. Idempotent. Call once,
 * as early as possible in main.tsx.
 */
export function initRendererLogger(): void {
  if (installed) return;
  installed = true;

  // `window.api.diag` is exposed by the preload bridge. Guard defensively
  // in case the preload failed to load — we must never break the app for
  // the sake of a log line.
  const diag = (
    window as unknown as {
      api?: { diag?: { logToFile?: (level: string, line: string) => void } };
    }
  ).api?.diag;
  const forward = (level: string, line: string): void => {
    try {
      diag?.logToFile?.(level, line.slice(0, MAX_LINE));
    } catch {
      /* ignore — logging must never throw */
    }
  };

  const original = {
    log: console.log.bind(console),
    info: console.info.bind(console),
    warn: console.warn.bind(console),
    error: console.error.bind(console),
    debug: console.debug.bind(console),
  };

  console.log = (...a: unknown[]) => {
    original.log(...a);
    forward("log", fmtArgs(a));
  };
  console.info = (...a: unknown[]) => {
    original.info(...a);
    forward("info", fmtArgs(a));
  };
  console.warn = (...a: unknown[]) => {
    original.warn(...a);
    forward("warn", fmtArgs(a));
  };
  console.error = (...a: unknown[]) => {
    original.error(...a);
    forward("error", fmtArgs(a));
  };
  console.debug = (...a: unknown[]) => {
    original.debug(...a);
    forward("debug", fmtArgs(a));
  };

  // Last-resort capture — these often fire right before a freeze/reload.
  window.addEventListener("error", (e) => {
    const err = e.error;
    forward(
      "error",
      `window.onerror: ${
        err instanceof Error ? (err.stack ?? err.message) : String(e.message)
      }`,
    );
  });
  window.addEventListener("unhandledrejection", (e) => {
    const reason = (e as PromiseRejectionEvent).reason;
    forward(
      "error",
      `unhandledrejection: ${
        reason instanceof Error ? (reason.stack ?? reason.message) : String(reason)
      }`,
    );
  });

  forward("info", `=== renderer-logger started: ${navigator.userAgent} ===`);
}

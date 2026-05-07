// v0.1.55 — runtime quarantine scrubber.
//
// macOS adds `com.apple.quarantine` to every file inside an .app bundle
// when the bundle is downloaded via Safari/Chrome (.dmg or .zip). The
// quarantine attribute also flags the EXECUTING PROCESS at exec time,
// which means files written by that process inherit quarantine. For
// AVA's OTA update flow that's fatal: electron-updater downloads the
// new .zip via HTTPS, ditto extracts it, every extracted file inherits
// quarantine — and Squirrel.Mac then can't scrub quarantine from
// hardened-runtime dylibs (libwhisper.dylib in particular returns
// EPERM on `removexattr`), so the install aborts after 3 retries.
//
// The build-time `strip-xattrs.mjs` afterPack hook already produces a
// clean .zip on the GitHub release. The remaining quarantine comes
// from the user's first .dmg install (Chrome attaches quarantine).
//
// This scrubber clears `com.apple.quarantine` from the running app's
// bundle on every launch + once more right before `quitAndInstall`.
// Note: the running PROCESS keeps its quarantine flag (kernel sets it
// at exec from the binary's xattrs at the time of exec), so the
// scrub here doesn't help THIS launch's OTA. It does help the NEXT
// launch's OTA — from v0.1.55 forward, manually-installed builds
// self-clean on first run, and subsequent OTAs go through cleanly
// because the new AVA process boots without quarantine.
//
// We target only `com.apple.quarantine`, not `xattr -cr`, because:
//   - cr would also try to strip `com.apple.cs.*` (codesign attrs)
//     which the kernel refuses on signed binaries → noisy errors
//   - quarantine alone removal is permitted on signed Mach-Os
//     (it's not part of the codesign seal).
//
// Best effort: failures are logged + ignored. Worst case is a
// status-quo OTA path; we never make things worse by trying.

import { spawn } from "node:child_process";
import { app } from "electron";
import { dirname } from "node:path";

/** Returns the path to the running .app bundle (parent of `.app/Contents`). */
function appBundlePath(): string {
  // process.execPath = `<bundle>/Contents/MacOS/<exe>`. Three levels up
  // → `<bundle>` (the .app dir itself). app.getAppPath() returns the
  // asar dir which is two levels deeper, so we use execPath.
  return dirname(dirname(dirname(process.execPath)));
}

/** Run `xattr -dr com.apple.quarantine <bundle>`. Returns when done.
 *  Never throws — exits silently on platform mismatch / errors. */
export async function scrubQuarantine(): Promise<void> {
  if (process.platform !== "darwin") return;
  if (!app.isPackaged) return;
  const bundle = appBundlePath();
  await new Promise<void>((resolve) => {
    const child = spawn("xattr", ["-dr", "com.apple.quarantine", bundle], {
      stdio: ["ignore", "ignore", "pipe"],
    });
    let stderr = "";
    child.stderr?.on("data", (chunk: Buffer) => {
      stderr += chunk.toString();
    });
    child.on("error", (err) => {
      // eslint-disable-next-line no-console
      console.warn("[scrub-quarantine] spawn failed:", err);
      resolve();
    });
    child.on("exit", (code) => {
      if (code === 0) {
        // eslint-disable-next-line no-console
        console.log(`[scrub-quarantine] cleared from ${bundle}`);
      } else {
        // eslint-disable-next-line no-console
        console.warn(
          `[scrub-quarantine] xattr exited ${code} (best-effort): ${stderr.slice(0, 200)}`,
        );
      }
      resolve();
    });
  });
}

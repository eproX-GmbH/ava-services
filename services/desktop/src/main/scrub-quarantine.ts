// v0.1.57 — runtime quarantine scrubber (revised after v0.1.55+v0.1.56 logs).
//
// macOS adds `com.apple.quarantine` to every file inside an .app bundle
// when the bundle is downloaded via Safari/Chrome (.dmg or .zip). The
// quarantine attribute also flags the EXECUTING PROCESS at exec time,
// which means files written by that process inherit quarantine.
//
// The OTA failure chain (from real Squirrel.Mac logs):
//   1. User installs AVA via Chrome-downloaded .dmg → bundle quarantined.
//   2. AVA launches → kernel reads bundle's xattrs at exec → process is
//      quarantine-flagged.
//   3. AVA writes the OTA-downloaded .zip into
//      `~/Library/Caches/com.ava.desktop.ShipIt/update.<X>/` → that .zip
//      inherits quarantine.
//   4. ShipIt forks, ditto-extracts the .zip → ditto preserves the
//      quarantine xattr onto every extracted file.
//   5. ShipIt calls `removexattr("com.apple.quarantine")` on each. The
//      libwhisper.dylib (hardened runtime + library validation) returns
//      EPERM. ShipIt aborts the install.
//
// v0.1.55 fixed step 1 by scrubbing the bundle on boot. But that didn't
// fix THIS launch's process flag (kernel-level state, can't change
// retroactively), and didn't touch the cache dir. Logs from a v0.1.55 →
// v0.1.56 OTA confirmed: the bundle on disk had no quarantine, but the
// staged extract STILL had it.
//
// v0.1.57 fix: scrub three places:
//   (a) The .app bundle on disk (existing).
//   (b) `~/Library/Caches/com.ava.desktop.ShipIt/` — where the OTA .zip
//       lives between download and extraction. Stripping quarantine here
//       breaks the propagation chain into ditto.
//   (c) `<userData>/pending/` — electron-updater's general staging dir.
//
// Targets only `com.apple.quarantine`, not `xattr -cr`. cr would also try
// to strip `com.apple.cs.*` (codesign attrs) which the kernel refuses on
// signed binaries; quarantine alone removal is permitted.

import { spawn } from "node:child_process";
import { app } from "electron";
import { existsSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";

/** Path to the running .app bundle (`<bundle>.app`). */
function appBundlePath(): string {
  // process.execPath = `<bundle>/Contents/MacOS/<exe>`. Three levels up
  // → `<bundle>` (the .app dir itself).
  return dirname(dirname(dirname(process.execPath)));
}

/** Squirrel.Mac's per-app cache dir. Holds the downloaded OTA .zip
 *  between download and extraction. The bundle id is fixed at
 *  electron-builder.yml's `appId`. */
function shipItCachePath(): string {
  return join(homedir(), "Library", "Caches", "com.ava.desktop.ShipIt");
}

/** electron-updater's generic staging dir. Some flows write the .zip
 *  here before handing it off to Squirrel.Mac. */
function pendingUpdatePath(): string {
  return join(app.getPath("userData"), "pending");
}

/** Run `xattr -dr com.apple.quarantine <path>`. Returns when done.
 *  Never throws — exits silently on platform mismatch / missing path
 *  / xattr failures. */
async function scrubPath(path: string): Promise<void> {
  if (!existsSync(path)) return;
  await new Promise<void>((resolve) => {
    const child = spawn("xattr", ["-dr", "com.apple.quarantine", path], {
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
        console.log(`[scrub-quarantine] cleared from ${path}`);
      } else {
        // eslint-disable-next-line no-console
        console.warn(
          `[scrub-quarantine] xattr exited ${code} on ${path}: ${stderr.slice(0, 200)}`,
        );
      }
      resolve();
    });
  });
}

/**
 * Clear `com.apple.quarantine` from every place that could feed
 * quarantine into the OTA install pipeline. Best-effort, never throws.
 *
 * Call sites:
 *   - Boot (main/index.ts → app.whenReady) — clean bundle for next launch.
 *   - Pre-quitAndInstall (updater.ts) — clean cache so Squirrel's ditto
 *     extract doesn't propagate quarantine into the staged bundle.
 */
export async function scrubQuarantine(): Promise<void> {
  if (process.platform !== "darwin") return;
  if (!app.isPackaged) return;
  await Promise.all([
    scrubPath(appBundlePath()),
    scrubPath(shipItCachePath()),
    scrubPath(pendingUpdatePath()),
  ]);
}

/**
 * v0.1.155 — Strip quarantine from a single explicit file path. Used
 * from updater.ts's `update-downloaded` handler against
 * `UpdateInfo.downloadedFile`, the only timing where we know the
 * artifact is on disk AND Squirrel hasn't touched it yet.
 *
 * The earlier scrubQuarantine() call ran against directory paths that
 * frequently didn't yet contain the artifact at the timing we invoked
 * it (pre-quitAndInstall — by which point electron-updater had already
 * staged the file in a sibling location we weren't covering).
 */
export async function scrubPathExplicit(path: string): Promise<void> {
  if (process.platform !== "darwin") return;
  if (!app.isPackaged) return;
  await scrubPath(path);
}

/**
 * v0.1.162 — Targeted scrub for the bundled whisper resources tree.
 * Called proactively at boot (alongside the main bundle scrub) and
 * reactively from the whisper-sidecar when transcribe crashes with a
 * native-crash signature ("main + <addr>") — the typical sign that
 * `dlopen()` of a sibling libwhisper.dylib failed because of
 * quarantine that library-validation refuses to remove.
 *
 * `xattr -dr` on the directory walks every file. Signed dylibs with
 * hardened-runtime + library-validation refuse the xattr removal on
 * THEMSELVES (returns EPERM), but they don't NEED to be scrubbed —
 * what matters is that NO file in the tree has com.apple.quarantine
 * when `dlopen` walks the directory. xattr's recursive scrub clears
 * the unsigned siblings + parent dirs; the signed dylib stays signed
 * with whatever xattrs were sealed at codesign time, which are NOT
 * quarantine.
 */
export async function scrubWhisperBundle(): Promise<void> {
  if (process.platform !== "darwin") return;
  if (!app.isPackaged) return;
  // Packaged path: <bundle>/Contents/Resources/whisper/
  const packaged = join(process.resourcesPath, "whisper");
  await scrubPath(packaged);
}

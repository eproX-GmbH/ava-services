#!/usr/bin/env node
// electron-builder afterPack hook (v0.1.51).
//
// macOS auto-update via Squirrel.Mac fails on this app with
//
//   Installation error: NSPOSIXErrorDomain Code=13 "Permission denied"
//   Couldn't remove quarantine attribute from
//   ".../whisper/darwin-arm64/libwhisper.X.Y.Z.dylib"
//   This most likely means the file is read-only.
//
// Squirrel.Mac is trying to clear `com.apple.quarantine` from the
// staged update bundle before swapping it into /Applications. It
// fails on signed dylibs because their xattrs are sealed.
//
// Root cause: the .zip electron-builder uploads to the GitHub
// release inherits a quarantine attr at user-download time; ditto/
// unzip propagates that to every extracted file inside the new
// .app bundle. By the time Squirrel sees them they're already
// codesigned, so xattr removal is denied → install retries fail →
// Squirrel relaunches the OLD app.
//
// Fix: BEFORE codesigning, recursively strip every xattr from the
// produced .app. Resulting bundle has no xattrs to "remove" later;
// Squirrel's clear-quarantine step becomes a no-op and the install
// completes.
//
// `xattr -cr` is the BSD-supported recursive-clear flag; works on
// any macOS runner. No-op on non-macOS platforms (Linux/Windows
// builds skip this hook entirely via the `electronPlatformName`
// check below).

import { spawn } from "node:child_process";

export default async function afterPack({ appOutDir, electronPlatformName }) {
  if (electronPlatformName !== "darwin" && electronPlatformName !== "mas") {
    return;
  }
  await run("xattr", ["-cr", appOutDir]);
  // eslint-disable-next-line no-console
  console.log(`[strip-xattrs] cleared all extended attrs in ${appOutDir}`);
}

function run(cmd, args) {
  return new Promise((resolve, reject) => {
    const child = spawn(cmd, args, { stdio: "inherit" });
    child.on("error", reject);
    child.on("exit", (code) => {
      if (code === 0) resolve();
      else reject(new Error(`${cmd} exited with ${code}`));
    });
  });
}

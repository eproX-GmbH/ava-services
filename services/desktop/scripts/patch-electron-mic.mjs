#!/usr/bin/env node
// Patch the dev Electron binary's Info.plist + re-sign (Phase 8.n2).
//
// Why this exists:
//   In `pnpm dev` we run the prebuilt binary at
//   `node_modules/electron/dist/Electron.app`. macOS gates microphone
//   access via TCC, which requires `NSMicrophoneUsageDescription` in
//   the bundle's Info.plist. The vanilla Electron prebuild doesn't
//   ship that key — so `systemPreferences.askForMediaAccess()`
//   silently returns false, no prompt appears, and the app never
//   shows up in System Settings → Privacy → Microphone.
//
//   This script adds (or updates) the key via PlistBuddy. Modifying
//   Info.plist invalidates the existing signature, so we re-sign
//   ad-hoc afterwards — required since macOS Catalina for TCC to
//   accept the bundle.
//
// Idempotent: safe to run repeatedly. Wired into `postinstall` so a
// fresh `pnpm install` (and any Electron version bump) re-applies
// automatically. macOS-only — early-exits on every other platform.
//
// In production (`electron-builder` packaging) the same key lands via
// the `mac.extendInfo.NSMicrophoneUsageDescription` block in
// electron-builder.yml, so packaged builds need no postinstall step.

import { existsSync } from "node:fs";
import { execFileSync, spawnSync } from "node:child_process";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

if (process.platform !== "darwin") {
  // Linux / Windows have no equivalent gate; nothing to do.
  process.exit(0);
}

const __dirname = dirname(fileURLToPath(import.meta.url));

// pnpm in monorepos hoists `electron` either into this service's
// `node_modules/electron` OR into a workspace-root `node_modules`
// further up the tree. Walk upward from the script and pick the
// first `Electron.app` we find.
function locateElectronApp() {
  let cur = join(__dirname, "..");
  for (let depth = 0; depth < 6; depth++) {
    const candidate = join(
      cur,
      "node_modules",
      "electron",
      "dist",
      "Electron.app",
    );
    if (existsSync(join(candidate, "Contents", "Info.plist"))) {
      return candidate;
    }
    const parent = dirname(cur);
    if (parent === cur) break;
    cur = parent;
  }
  return null;
}

const electronApp = locateElectronApp();
if (!electronApp) {
  console.log(
    "[patch-electron-mic] skipping: electron's Electron.app not found in any parent node_modules",
  );
  process.exit(0);
}
const plistPath = join(electronApp, "Contents", "Info.plist");

const usageString =
  "AVA Dev: Mikrofon-Zugriff für lokale Spracherkennung (Transkription via Whisper).";

const PLIST_BUDDY = "/usr/libexec/PlistBuddy";

function plistGet(key) {
  const r = spawnSync(PLIST_BUDDY, ["-c", `Print :${key}`, plistPath], {
    encoding: "utf8",
  });
  if (r.status === 0) return r.stdout.trim();
  return null;
}

function plistSet(key, value) {
  const existing = plistGet(key);
  if (existing === value) return false;
  const action = existing === null ? "Add" : "Set";
  const type = action === "Add" ? "string " : "";
  execFileSync(
    PLIST_BUDDY,
    ["-c", `${action} :${key} ${type}${escapeForBuddy(value)}`, plistPath],
    { stdio: "inherit" },
  );
  return true;
}

function escapeForBuddy(s) {
  // PlistBuddy `Set`/`Add` takes the value verbatim after the type
  // token; quoting + escaping double quotes is enough for our usage.
  return `"${s.replace(/"/g, '\\"')}"`;
}

let changed = false;
try {
  if (plistSet("NSMicrophoneUsageDescription", usageString)) changed = true;
  // Optional: speech-recognition + audio-input entitlements aren't
  // strictly required for whisper.cpp (we read raw mic, no
  // SFSpeechRecognizer), but adding them now means future Apple-stack
  // additions don't trigger another patch round.
} catch (err) {
  console.error("[patch-electron-mic] PlistBuddy failed:", err.message);
  process.exit(1);
}

// Always verify the signature is intact, even when the plist was
// already correct — a previous patcher run that crashed mid-resign
// would otherwise leave a permanently-broken bundle that no
// "everything's fine" early return could detect.
const verify = spawnSync(
  "codesign",
  ["--verify", "--no-strict", electronApp],
  { stdio: "ignore" },
);
if (!changed && verify.status === 0) {
  console.log(
    "[patch-electron-mic] Info.plist already patched, signature valid.",
  );
  process.exit(0);
}
if (!changed) {
  console.log(
    "[patch-electron-mic] Info.plist patched but signature invalid; re-signing …",
  );
}

// Modifying Info.plist invalidates the existing signature. Re-sign
// ad-hoc (`-`) so TCC accepts the bundle.
//
// We DON'T use --deep here: a few of Electron's bundled frameworks
// (Mantle, Squirrel, ReactiveObjC) have ambiguous bundle layouts
// that codesign rejects with "bundle format is ambiguous (could be
// app or framework)". Since we only modified the OUTER Info.plist,
// signing just the main bundle is enough — the framework
// signatures are untouched and stay valid. If a future patch needs
// to modify any framework Info.plist we'll have to per-framework
// sign in dependency order.
console.log("[patch-electron-mic] Patched Info.plist; re-signing …");
try {
  execFileSync("codesign", ["--force", "--sign", "-", electronApp], {
    stdio: "inherit",
  });
} catch (err) {
  console.error(
    "[patch-electron-mic] codesign failed — TCC may reject the bundle.",
    err.message,
  );
  process.exit(1);
}

// Optional cleanup: clear any leftover TCC state for the Electron
// bundle id. Without this, macOS sometimes remembers a "denied"
// decision against a now-differently-signed binary and refuses to
// re-prompt. tccutil exits non-zero when there's nothing to reset,
// so we ignore the status.
spawnSync("tccutil", ["reset", "Microphone", "com.github.Electron"], {
  stdio: "ignore",
});

console.log(
  "[patch-electron-mic] Done. Restart `pnpm dev` and AVA's mic prompt should now fire.",
);

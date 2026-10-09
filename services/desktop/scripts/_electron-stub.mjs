// Phase A1 — Pre-import shim that injects `app` + `safeStorage` stubs
// into Node's CJS require cache for the "electron" module BEFORE the
// provider store ESM-imports it. The store's
// `import { app, safeStorage } from "electron"` then resolves through
// the cjs-to-esm interop and sees our stubs.

import { tmpdir } from "node:os";
import { join } from "node:path";
import { mkdtempSync } from "node:fs";
import { Buffer } from "node:buffer";
import { createRequire } from "node:module";

const userDataDir = mkdtempSync(join(tmpdir(), "ava-electron-stub-"));
// R1 (docs/PLAN_AVA_CLOUD.md §12): Module lesen Pfade und Geheimnisse über
// src/core/platform.ts; ohne gesetzte Plattform gilt die Node-Fassung, die
// AVA_DATA_DIR und AVA_SECRETS_KEY auswertet. Beides zeigt auf dasselbe
// Temp-Verzeichnis bzw. einen festen Testschlüssel, damit Stores und
// Schlüsselbund-Rückfälle im Test wie bisher laufen.
process.env.AVA_DATA_DIR = userDataDir;
process.env.AVA_SECRETS_KEY = "0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef";
const stubApp = {
  getPath: () => userDataDir,
};
const stubSafeStorage = {
  isEncryptionAvailable: () => true,
  encryptString: (s) => Buffer.from("STUB:" + s, "utf8"),
  decryptString: (buf) => {
    const s = Buffer.from(buf).toString("utf8");
    if (!s.startsWith("STUB:")) throw new Error("bad stub blob");
    return s.slice(5);
  },
};

const require = createRequire(import.meta.url);
// Resolve electron's CJS entry path so we can poke the cache at the
// same key Node will look up.
const electronPath = require.resolve("electron");
// eslint-disable-next-line @typescript-eslint/no-require-imports
require("module"); // ensure module cache is initialised
const Module = require("module");
const cached = Module._cache[electronPath];
const stubExports = {
  app: stubApp,
  safeStorage: stubSafeStorage,
  // default export covers tsx's CJS-interop wrap of `import x from 'electron'`
  default: { app: stubApp, safeStorage: stubSafeStorage },
};
if (cached) {
  cached.exports = stubExports;
} else {
  // Seed the cache before electron's own CJS main runs.
  Module._cache[electronPath] = {
    id: electronPath,
    filename: electronPath,
    loaded: true,
    exports: stubExports,
  };
}

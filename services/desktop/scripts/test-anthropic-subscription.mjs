#!/usr/bin/env node
// Phase A1 — Smoke test for the Anthropic-subscription token storage
// path in ProviderConfigStore.
//
// Spawns the inner runner via the tsx ESM loader so it can import the
// TypeScript source directly (mirrors the existing test:skills:* scripts).

import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { createRequire } from "node:module";
import { Buffer } from "node:buffer";

const here = dirname(fileURLToPath(import.meta.url));
const root = join(here, "..");
const inner = join(here, "_test-anthropic-subscription.inner.mjs");
const require = createRequire(import.meta.url);
try {
  require.resolve("tsx");
} catch (err) {
  console.error(
    "[test:anthropic-subscription] 'tsx' nicht auflösbar — bitte `pnpm install` im Repo-Root ausführen",
  );
  console.error(err instanceof Error ? err.message : String(err));
  process.exit(1);
}

// The stub poke the CJS require-cache for "electron" with in-memory
// `app` + `safeStorage` shims before tsx loads the store.
const stubUrl = `file://${join(here, "_electron-stub.mjs")}`;
const res = spawnSync(
  process.execPath,
  ["--import", "tsx", "--import", stubUrl, inner],
  { stdio: "inherit", cwd: root },
);

process.exit(res.status ?? 1);

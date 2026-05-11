#!/usr/bin/env node
// S4 — Wrapper for the trust-store smoke test. Spawns the inner
// runner under `node --import tsx` so it can import the TS source.

import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { createRequire } from "node:module";

const here = dirname(fileURLToPath(import.meta.url));
const root = join(here, "..");
const inner = join(here, "_test-skills-trust.inner.mjs");
const require = createRequire(import.meta.url);
try {
  require.resolve("tsx");
} catch (err) {
  console.error(
    "[test:skills:trust] 'tsx' nicht auflösbar — bitte `pnpm install` im Repo-Root ausführen",
  );
  console.error(err instanceof Error ? err.message : String(err));
  process.exit(1);
}

const res = spawnSync(process.execPath, ["--import", "tsx", inner], {
  stdio: "inherit",
  cwd: root,
});
process.exit(res.status ?? 1);

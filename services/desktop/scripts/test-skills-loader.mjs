#!/usr/bin/env node
// S1 — Standalone smoke test for the skills loader.
//
// AVA does not yet have a unit-test runner. This script invokes Node
// with the `tsx` ESM loader (hoisted from the workspace root) so we
// can import the TypeScript source directly without a build step.
// Asserts the six fixture skills behave as expected:
//   - 2 valid skills loaded with correct fields + hash
//   - 4 skills skipped with German error logs (missing-scope,
//     bad-scope, invalid YAML, gated-needs-hubspot)

import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { createRequire } from "node:module";

const here = dirname(fileURLToPath(import.meta.url));
const root = join(here, "..");
const inner = join(here, "_test-skills-loader.inner.mjs");
const require = createRequire(import.meta.url);
// `--import tsx` resolves the workspace-hoisted tsx CLI shim and
// registers its ESM loader; works whether tsx is hoisted to the
// repo root or installed directly under services/desktop.
try {
  require.resolve("tsx");
} catch (err) {
  console.error(
    "[test:skills] 'tsx' nicht auflösbar — bitte `pnpm install` im Repo-Root ausführen",
  );
  console.error(err instanceof Error ? err.message : String(err));
  process.exit(1);
}

const res = spawnSync(
  process.execPath,
  ["--import", "tsx", inner],
  { stdio: "inherit", cwd: root },
);

process.exit(res.status ?? 1);

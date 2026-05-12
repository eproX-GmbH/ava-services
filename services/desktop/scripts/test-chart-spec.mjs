#!/usr/bin/env node
// C4 — Wrapper für die Chart-Spec-Tests (6 valid + 6 invalid + 8KB-Cap).

import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { createRequire } from "node:module";

const here = dirname(fileURLToPath(import.meta.url));
const root = join(here, "..");
const inner = join(here, "_test-chart-spec.inner.mjs");
const require = createRequire(import.meta.url);
try {
  require.resolve("tsx");
} catch (err) {
  console.error(
    "[test:chart] 'tsx' nicht auflösbar — bitte `pnpm install` im Repo-Root ausführen",
  );
  console.error(err instanceof Error ? err.message : String(err));
  process.exit(1);
}

const res = spawnSync(process.execPath, ["--import", "tsx", inner], {
  stdio: "inherit",
  cwd: root,
});
process.exit(res.status ?? 1);

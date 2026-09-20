#!/usr/bin/env node
// Prueft die Relevanz-Erkennung aus Werkzeugaufrufen (docs/PLAN_RELEVANZ.md).
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
const here = dirname(fileURLToPath(import.meta.url));
const res = spawnSync(
  process.execPath,
  ["--import", "tsx", join(here, "_test-relevanz.inner.mjs")],
  { stdio: "inherit", cwd: join(here, "..") },
);
process.exit(res.status ?? 1);

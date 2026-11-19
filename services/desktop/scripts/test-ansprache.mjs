#!/usr/bin/env node
// Prueft die Erstansprache: Aufhaenger und Entwurfspruefung (docs/PLAN_ERSTANSPRACHE.md).
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
const here = dirname(fileURLToPath(import.meta.url));
const res = spawnSync(
  process.execPath,
  ["--import", "tsx", join(here, "_test-ansprache.inner.mjs")],
  { stdio: "inherit", cwd: join(here, "..") },
);
process.exit(res.status ?? 1);

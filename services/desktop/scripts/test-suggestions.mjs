#!/usr/bin/env node
// v0.1.646 — Tests fuer Chat-Vorschlaege V1: Faehigkeitsgruppen decken alle
// Tools ab; Nutzerstand aus Fixture-Deps.
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
const here = dirname(fileURLToPath(import.meta.url));
const r = spawnSync(process.execPath, ["--import", "tsx", join(here, "_test-suggestions.inner.mjs")], { stdio: "inherit", cwd: join(here, "..") });
process.exit(r.status ?? 1);

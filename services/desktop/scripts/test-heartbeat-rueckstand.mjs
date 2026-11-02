#!/usr/bin/env node
// Heartbeat-Rueckstand (src/main/agent/heartbeat.ts): Runner fuer _test-heartbeat-rueckstand.inner.mjs mit tsx.
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
const here = dirname(fileURLToPath(import.meta.url));
const res = spawnSync(process.execPath, ["--import", "tsx", join(here, "_test-heartbeat-rueckstand.inner.mjs")], { stdio: "inherit", cwd: join(here, "..") });
process.exit(res.status ?? 1);

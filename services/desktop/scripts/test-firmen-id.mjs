#!/usr/bin/env node
// Prueft die Erkennung von Firmen-IDs im Import (src/main/agent/firmen-id.ts).
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
const here = dirname(fileURLToPath(import.meta.url));
const res = spawnSync(process.execPath, ["--import", "tsx", join(here, "_test-firmen-id.inner.mjs")], { stdio: "inherit", cwd: join(here, "..") });
process.exit(res.status ?? 1);

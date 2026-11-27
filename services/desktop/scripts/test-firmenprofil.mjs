#!/usr/bin/env node
// Prueft die Daten des Chat-Bausteins Firmenprofil (src/renderer/src/components/chat/gen-ui/firmenprofil-daten.ts).
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
const here = dirname(fileURLToPath(import.meta.url));
const res = spawnSync(process.execPath, ["--import", "tsx", join(here, "_test-firmenprofil.inner.mjs")], { stdio: "inherit", cwd: join(here, "..") });
process.exit(res.status ?? 1);

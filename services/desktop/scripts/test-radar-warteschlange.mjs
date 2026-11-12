#!/usr/bin/env node
// 2026-11-12 — Tests fuer die Radar-Warteschlange (Importieren/Ignorieren je Zeile, sofort weg).
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
const here = dirname(fileURLToPath(import.meta.url));
const r = spawnSync(process.execPath, ["--import", "tsx", join(here, "_test-radar-warteschlange.inner.mjs")], { stdio: "inherit", cwd: join(here, "..") });
process.exit(r.status ?? 1);

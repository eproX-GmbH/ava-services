#!/usr/bin/env node
// Postanschrift fuer Anzeige und Karte (src/shared/adresse.ts): Runner fuer _test-adresse.inner.mjs mit tsx.
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
const here = dirname(fileURLToPath(import.meta.url));
const res = spawnSync(process.execPath, ["--import", "tsx", join(here, "_test-adresse.inner.mjs")], { stdio: "inherit", cwd: join(here, "..") });
process.exit(res.status ?? 1);

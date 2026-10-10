#!/usr/bin/env node
// Umzug (docs/PLAN_AVA_CLOUD.md §13.3): Quelle packt mit Schlüssel A, Ziel spielt
// mit Schlüssel B ein — zwei Prozesse, zwei Datenverzeichnisse, echte PGlite.
import { spawnSync } from "node:child_process";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { randomBytes } from "node:crypto";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const root = join(here, "..");
const basis = mkdtempSync(join(tmpdir(), "ava-umzug-test-"));
const paket = join(basis, "paket.bin");
const lauf = (skript, daten, key) =>
  spawnSync(process.execPath, ["--import", "tsx", join(here, skript)], {
    stdio: "inherit",
    cwd: root,
    env: { ...process.env, AVA_DATA_DIR: daten, AVA_SECRETS_KEY: key, UMZUG_PAKET: paket },
  }).status ?? 1;
if (lauf("_test-umzug-packen.inner.mjs", join(basis, "quelle"), randomBytes(32).toString("hex")) !== 0) process.exit(1);
process.exit(lauf("_test-umzug-einspielen.inner.mjs", join(basis, "ziel"), randomBytes(32).toString("hex")));

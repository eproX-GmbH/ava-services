#!/usr/bin/env node
// Website-Walker (docs/PLAN_WEBSITE_WALKER.md): kanonische Quelle
// packages/website-walker/src → vendorierte Kopie in den Producern unter
// src/infrastructure/walker/ (nur graph.ts, bloecke.ts, signale.ts; die
// Stufen wie stellen.ts bleiben Producer-eigen). Read-only-Abgleich macht
// scripts/check-vendor-drift.mjs. Aufruf: node scripts/walker-sync.mjs
import { copyFileSync, existsSync, mkdirSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
export const WALKER_DATEIEN = ["graph.ts", "bloecke.ts", "signale.ts"];
export const WALKER_PRODUCER = ["website", "company-contact", "company-profile"];

for (const p of WALKER_PRODUCER) {
  const ziel = join(REPO_ROOT, p, "src/infrastructure/walker");
  if (!existsSync(join(REPO_ROOT, p, "src"))) continue;
  mkdirSync(ziel, { recursive: true });
  for (const d of WALKER_DATEIEN) copyFileSync(join(REPO_ROOT, "packages/website-walker/src", d), join(ziel, d));
  console.log(`walker-sync: ${p} ← ${WALKER_DATEIEN.join(", ")}`);
}
console.log("walker-sync: fertig — Submodule committen und Parent-Pointer bumpen.");

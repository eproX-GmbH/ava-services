#!/usr/bin/env node
// Rollt eine Version auf alle Kunden-Instanzen aus (docs/PLAN_AVA_CLOUD.md §14).
// Jede Instanz behält ihre eigene Konfiguration (fly config save), nur das Image wechselt.
//
//   node scripts/instanzen-aktualisieren.mjs [--version 0.1.797] [--nur zimmer-gmbh,mueller]
//        [--auch headless-ava] [--org personal] [--trocken]
//
// Vorher einmal: node scripts/instanz-image.mjs --version <v>

import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { alleApps, APP_PREFIX, appName, args, desktopVersion, fly, imageRef } from "./lib/instanz-fly.mjs";

const a = args();
try {
  const version = String(a.version || desktopVersion()).replace(/^v/, "");
  const org = String(a.org || "personal");
  const nur = a.nur ? String(a.nur).split(",").map((s) => appName(s.trim())) : null;
  const auch = a.auch ? String(a.auch).split(",").map((s) => s.trim()) : [];
  const apps = [
    ...alleApps(org).map((x) => x.name).filter((n) => n.startsWith(APP_PREFIX) && !n.endsWith("-ollama")).filter((n) => !nur || nur.includes(n)),
    ...auch,
  ];
  if (!apps.length) throw new Error("Keine Instanzen gefunden.");
  console.log(`${imageRef(version)} → ${apps.length} Instanz(en): ${apps.join(", ")}`);
  if (a.trocken) process.exit(0);

  const fehler = [];
  for (const app of apps) {
    console.log(`\n→ ${app}`);
    try {
      const dir = mkdtempSync(join(tmpdir(), "ava-instanz-"));
      const toml = join(dir, "fly.toml");
      fly(["config", "save", "-a", app, "-c", toml, "-y"], { still: true });
      fly(["deploy", dir, "-c", toml, "-a", app, "--image", imageRef(version), "--now", "--yes"]);
    } catch (err) {
      console.error(`  ✗ ${err.message}`);
      fehler.push(app);
    }
  }
  if (fehler.length) {
    console.error(`\n✗ Nicht aktualisiert: ${fehler.join(", ")}`);
    process.exit(1);
  }
  console.log(`\n✓ Alle ${apps.length} Instanz(en) auf v${version}.`);
} catch (err) {
  console.error(`\n✗ ${err.message}`);
  process.exit(1);
}

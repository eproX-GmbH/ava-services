#!/usr/bin/env node
// Entfernt eine Kunden-Instanz samt Volume und eigenem Sidecar (docs/PLAN_AVA_CLOUD.md §14).
// Unwiderruflich: alle Daten der Instanz sind danach weg. Vorher bei Bedarf den Stand
// per Umzug auf die Desktop-App des Kunden holen (Einstellungen → Konto → Deine AVAs).
//
//   node scripts/instanz-entfernen.mjs --name zimmer-gmbh --bestaetigen zimmer-gmbh

import { existsSync, renameSync } from "node:fs";
import { join } from "node:path";
import { appExistiert, appName, args, fly, NOTIZEN, ollamaApp, slugPruefen } from "./lib/instanz-fly.mjs";

const a = args();
try {
  const slug = slugPruefen(String(a.name || ""));
  const ziele = [appName(slug), ollamaApp(slug)].filter(appExistiert);
  if (!ziele.length) throw new Error(`Zu ${slug} gibt es keine Apps.`);
  if (a.bestaetigen !== slug) {
    console.log(`Würde unwiderruflich löschen (inkl. Volumes): ${ziele.join(", ")}\nZum Ausführen: --bestaetigen ${slug}`);
    process.exit(2);
  }
  for (const app of ziele) {
    console.log(`→ ${app} löschen`);
    fly(["apps", "destroy", app, "--yes"]);
  }
  const notiz = join(NOTIZEN, `${slug}.json`);
  if (existsSync(notiz)) renameSync(notiz, join(NOTIZEN, `${slug}.entfernt-${new Date().toISOString().slice(0, 10)}.json`));
  console.log(`✓ ${slug} entfernt.`);
} catch (err) {
  console.error(`\n✗ ${err.message}`);
  process.exit(1);
}

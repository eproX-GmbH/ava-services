#!/usr/bin/env node
// R1 (docs/PLAN_AVA_CLOUD.md §12): Wächter für die Plattform-Schicht.
//
// Regel: Unter src/core/ wird `electron` nie importiert. Unter src/main/ darf
// es nur, wer in der Ausnahmeliste steht, mit Grund und dem Schritt, der die
// Ausnahme ablöst. Alles andere läuft über src/core/platform.ts. Der Lauf ist
// Teil von `build:typecheck` und bricht den Build, damit die Kopplung nicht
// wieder zusammenwächst.
//
// Wer eine Ausnahme braucht, trägt sie hier ein und schreibt dazu, warum sie
// nicht über die Plattform-Schicht geht. Die Liste soll mit R2 und R4 kürzer
// werden, nicht länger.

import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = fileURLToPath(new URL("..", import.meta.url));

/** Pfad relativ zu src/main → Grund. */
const AUSNAHMEN = new Map([
  ["index.ts", "Electron-Einstieg; wird mit R2 (bootstrapCore) dünn"],
  ["platform-electron.ts", "die Electron-Umsetzung der Plattform-Schicht selbst"],
  ["account-space.ts", "Konto-Spaces setzen app.setPath vor dem Start (R2)"],
  ["file-logger.ts", "Beenden-Spuren über app-/Fenster-Ereignisse (R2)"],
  ["billing.ts", "ava://-Protokoll, open-url, second-instance (R2)"],
  ["updater.ts", "electron-updater, Neustart-Dialog; im Server ersetzt docker pull den Updater"],
  ["download-guard.ts", "will-download-Sperre für Electron-Sessions"],
  ["externe-links.ts", "Link-Umleitung aus Fenstern heraus"],
  ["producer-screenshots.ts", "protocol.handle für ava-screenshot (R2)"],
  ["auth.ts", "Keycloak-Login-Fenster (R4: Device Flow im Server)"],
  ["auth/siwc-oauth-flow.ts", "Sign-in-with-ChatGPT-Fenster (Stufe 3: Node)"],
  ["agent/tools/linkedin.ts", "öffnet das LinkedIn-Fenster (Stufe 3: Node)"],
  ["discovery/profiler.ts", "verstecktes Fenster als Crawl-Rückfall (R4: Selenium oder fetch)"],
  ["link-monitor/browser.ts", "verstecktes Fenster für die Link-Überwachung (R4)"],
  ["link-monitor/interstitial.ts", "Typ BrowserWindow für link-monitor/browser.ts (R4)"],
  ["telegram/audio.ts", "OGG→WAV über WebAudio-Fenster (R4: ffmpeg)"],
  ["linkedin/index.ts", "LinkedIn-Modul: Fenster, ipcMain (bleibt außerhalb des Servers, Stufe 3)"],
  ["linkedin/image-extractor.ts", "nativeImage (LinkedIn-Modul)"],
  ["linkedin/login-window.ts", "LinkedIn-Login-Fenster (LinkedIn-Modul)"],
  ["linkedin/media-protocol.ts", "protocol.handle für ava-linkedin-media (LinkedIn-Modul)"],
  ["linkedin/runs.ts", "Typ BrowserWindow (LinkedIn-Modul)"],
  ["linkedin/scraper-window.ts", "verstecktes Scraper-Fenster (LinkedIn-Modul)"],
  ["linkedin/scraper.ts", "Fenster, net.fetch (LinkedIn-Modul)"],
]);

function walk(dir, out = []) {
  for (const e of readdirSync(dir)) {
    const p = join(dir, e);
    if (statSync(p).isDirectory()) walk(p, out);
    else if (p.endsWith(".ts")) out.push(p);
  }
  return out;
}

const MUSTER = /(from\s+["']electron["']|require\(\s*["']electron["']\s*\))/;

function importiertElectron(file) {
  const src = readFileSync(file, "utf8");
  return src.split("\n").some((zeile) => {
    const t = zeile.trim();
    if (t.startsWith("//") || t.startsWith("*") || t.startsWith("/*")) return false;
    return MUSTER.test(t);
  });
}

const fehler = [];
const coreDir = join(ROOT, "src", "core");
for (const f of walk(coreDir)) {
  if (importiertElectron(f)) fehler.push(`${relative(ROOT, f)}: importiert electron; unter src/core ist das nie erlaubt`);
}

const mainDir = join(ROOT, "src", "main");
const gesehen = new Set();
for (const f of walk(mainDir)) {
  const rel = relative(mainDir, f).split("\\").join("/");
  if (importiertElectron(f)) {
    gesehen.add(rel);
    if (!AUSNAHMEN.has(rel)) {
      fehler.push(`src/main/${rel}: importiert electron ohne Eintrag in scripts/check-electron-imports.mjs; bitte über src/core/platform.ts gehen oder Ausnahme mit Grund eintragen`);
    }
  }
}
for (const rel of AUSNAHMEN.keys()) {
  if (!gesehen.has(rel)) fehler.push(`Ausnahme ohne Treffer: src/main/${rel} importiert electron nicht mehr; Eintrag entfernen`);
}

if (fehler.length > 0) {
  console.error("[check-electron-imports] FEHLER:");
  for (const z of fehler) console.error("  " + z);
  process.exit(1);
}
console.log(`[check-electron-imports] ok: ${AUSNAHMEN.size} Ausnahmen unter src/main, keine unter src/core`);

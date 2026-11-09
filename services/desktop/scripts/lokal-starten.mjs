#!/usr/bin/env node
// Arbeitsstand der Desktop-App lokal gegen die PRODUKTIVSYSTEME starten (Joyce
// 2026-11-09: Aenderungen erst lokal pruefen, nicht auf den GitHub-Build warten).
//
//   pnpm -F @ava/desktop start:lokal            baut und startet
//   pnpm -F @ava/desktop start:lokal --ohne-build
//
// - Laeuft die installierte AVA noch, bricht das Skript ab: beide teilen Daten-
//   verzeichnis, Producer-Ports und Telegram-Empfang.
// - Ohne die AVA_*-Werte unten spraeche ein unverpackter Build mit dem lokalen
//   Entwickler-Keycloak (src/shared/config.ts, DEV_DEFAULTS) und verwuerfe das
//   gespeicherte Anmelde-Token.
// - macOS fragt beim ersten Start, ob "Electron" den Schluessel "Safe Storage"
//   lesen darf; bis zur Antwort wartet die App.
// - Port 9333 erlaubt das Pruefen der Seiten per DevTools-Protokoll.

import { spawn, spawnSync } from "node:child_process";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const desktop = join(dirname(fileURLToPath(import.meta.url)), "..");
const electron = join(desktop, "..", "..", "node_modules", ".bin", process.platform === "win32" ? "electron.cmd" : "electron");

function avaLaeuft() {
  if (process.platform === "darwin") return spawnSync("pgrep", ["-f", "AVA.app/Contents/MacOS/AVA"]).status === 0;
  if (process.platform === "win32") return /AVA\.exe/i.test(spawnSync("tasklist", ["/FI", "IMAGENAME eq AVA.exe"], { encoding: "utf8" }).stdout ?? "");
  return false;
}

if (avaLaeuft()) {
  console.error("Die installierte AVA läuft noch. Bitte erst beenden (AVA → Beenden), dann erneut starten.");
  process.exit(1);
}

if (!process.argv.includes("--ohne-build")) {
  const b = spawnSync("npx", ["electron-vite", "build"], { cwd: desktop, stdio: "inherit", shell: process.platform === "win32" });
  if (b.status !== 0) process.exit(b.status ?? 1);
}

const env = {
  ...process.env,
  AVA_GATEWAY_URL: "https://ava-db-gateway.fly.dev",
  AVA_AUTH_ISSUER: "https://fly-keycloak-broken-bird-3701.fly.dev/realms/ava",
  AVA_AUTH_CLIENT_ID: "ava-desktop",
  AVA_UPDATE_CHANNEL: "latest",
};
console.log("Starte den Arbeitsstand gegen die Produktivsysteme (DevTools-Port 9333) …");
const kind = spawn(electron, [".", "--remote-debugging-port=9333"], { cwd: desktop, env, stdio: "inherit", shell: process.platform === "win32" });
kind.on("exit", (code) => process.exit(code ?? 0));

import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync, mkdirSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Module } from "node:module";

// Der KeyStore zieht `electron` fuer den Standardpfad und die
// Schluessel-Ablage. Im Test wird ein eigenes Verzeichnis uebergeben und
// electron durch eine Attrappe ersetzt.
const echt = Module._load;
Module._load = function (anfrage, ...rest) {
  if (anfrage === "electron") {
    return {
      app: { getPath: () => tmpdir() },
      safeStorage: { isEncryptionAvailable: () => false, encryptString: () => Buffer.from(""), decryptString: () => "" },
    };
  }
  return echt.call(this, anfrage, ...rest);
};

const { WatchlistKeyStore } = await import("../src/main/linkedin/watchlist/key-store.ts");

const mitDatei = (inhalt) => {
  const dir = mkdtempSync(join(tmpdir(), "ava-wl-"));
  mkdirSync(dir, { recursive: true });
  if (inhalt) writeFileSync(join(dir, "watchlist-config.json"), JSON.stringify(inhalt), "utf8");
  return dir;
};

// 1. Bestandsinstallation auf den alten Voreinstellungen wird nachgezogen.
{
  const dir = mitDatei({ companyWindow: 100, profilModus: "kurz", intervalHours: 24 });
  const cfg = new WatchlistKeyStore(dir).getConfig();
  assert.equal(cfg.companyWindow, 50, "Fenster muss auf 50 gehoben werden");
  assert.equal(cfg.profilModus, "voll", "Profiltiefe muss auf voll gehoben werden");
  const datei = JSON.parse(readFileSync(join(dir, "watchlist-config.json"), "utf8"));
  assert.equal(datei.companyWindow, 50, "und auch geschrieben werden");
  assert.equal(datei.konfigStand, 1);
  console.log("  ok   Bestandsinstallation wird einmalig nachgezogen");
}

// 2. Wer selbst etwas gewaehlt hat, behaelt es. Das ist der Kern: die
//    Migration darf keine bewusste Entscheidung ueberschreiben.
{
  const dir = mitDatei({ companyWindow: 300, profilModus: "kurz" });
  const cfg = new WatchlistKeyStore(dir).getConfig();
  assert.equal(cfg.companyWindow, 300, "eigenes Fenster bleibt");
  assert.equal(cfg.profilModus, "kurz", "eigene Profiltiefe bleibt");
  console.log("  ok   eigene Einstellungen bleiben unangetastet");
}

// 3. Bereits nachgezogen: nichts passiert mehr, auch wenn jemand danach
//    wieder auf die alten Werte stellt.
{
  const dir = mitDatei({ companyWindow: 100, profilModus: "kurz", konfigStand: 1 });
  const cfg = new WatchlistKeyStore(dir).getConfig();
  assert.equal(cfg.companyWindow, 100, "nach dem Nachziehen gilt die Wahl des Nutzers");
  assert.equal(cfg.profilModus, "kurz");
  console.log("  ok   die Migration laeuft nur ein einziges Mal");
}

// 4. Frische Installation ohne Datei.
{
  const cfg = new WatchlistKeyStore(mitDatei(null)).getConfig();
  assert.equal(cfg.companyWindow, 50);
  assert.equal(cfg.profilModus, "voll");
  console.log("  ok   frische Installation startet mit den neuen Werten");
}

// 5. Die Kosten-Leitplanke bleibt.
{
  const ks = new WatchlistKeyStore(mitDatei(null));
  assert.equal(ks.setConfig({ companyWindow: 5 }).companyWindow, 25, "Untergrenze 25");
  assert.equal(ks.setConfig({ companyWindow: 99999 }).companyWindow, 1000, "Obergrenze 1000");
  console.log("  ok   Suchfenster bleibt auf 25..1000 begrenzt");
}

console.log("Watchlist-Migrations-Tests ok");

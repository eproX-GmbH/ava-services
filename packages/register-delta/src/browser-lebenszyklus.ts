// Lebenszyklus der Hintergrund-Browser (docs/ANALYSE_CHROME_PROZESSE.md).
//
// Ausgangslage: Chrome ist ein Urenkel der App — Desktop-App startet den
// Producer, der Producer startet chromedriver, chromedriver startet Chrome.
// Stirbt der Producer, raeumt macOS und Linux die Enkel nicht mit auf. Bis
// 2026-09-18 behandelte kein Producer ein Beendigungssignal: Node endete
// sofort, der Aufraeumzweig mit `quit()` lief nie, und chromedriver und Chrome
// blieben als Waisen stehen. Beim Herunterfahren wartet macOS dann auf sie,
// weil sie dieselbe Programmkennung tragen wie der Browser der Nutzerin oder
// des Nutzers.
//
// Dieses Modul haelt drei Zusagen:
//
//   1. Jeder Browser bekommt ein eigenes Profilverzeichnis unterhalb des
//      AVA-Ordners. Damit ist er zweifelsfrei als AVA-Browser erkennbar, und
//      das Profil der Person wird nie angefasst — keine geteilten Cookies,
//      keine Sitzungskonflikte, keine Meldung "Chrome wurde nicht ordnungsgemäß
//      beendet".
//   2. Jeder gebaute Browser ist bekannt. Kommt ein Beendigungssignal, werden
//      alle offenen Browser geschlossen, bevor der Prozess endet.
//   3. Ein haengendes Schliessen wird nach einer Frist aufgegeben, damit ein
//      stummer chromedriver das Beenden nicht blockiert. Danach wird der
//      Browser hart beendet.
//
// Die Datei ist in allen Producern und im Register-Delta-Worker inhaltlich
// gleich. Sie ist bewusst ohne Abhaengigkeiten ausser Node und Selenium, damit
// sie sich unveraendert kopieren laesst.

import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

/** Praefix der Profilverzeichnisse von AVA. */
export const AVA_PROFIL_PRAEFIX = "ava-chrome-";

/**
 * Eindeutiger Schalter an jedem von AVA gestarteten Browser. Chrome ignoriert
 * unbekannte Schalter, der Aufraeumer der Desktop-App erkennt uns daran
 * (services/desktop/src/main/browser-sweep.ts) — der Wert darf sich nur
 * zusammen mit ihm aendern.
 *
 * Bewusst ein eigener Schalter und nicht das Profilverzeichnis: Ein Pfad ist
 * kein sicheres Merkmal. Startet die Person ihren eigenen Chrome mit einem
 * Profil, dessen Pfad zufaellig aehnlich heisst, duerfte er nie erfasst werden.
 */
export const AVA_BROWSER_SCHALTER = "--ava-browser";

/** Hoechstzeit fuer ein einzelnes `quit()`. */
const SCHLIESS_FRIST_MS = 8000;
/** Hoechstzeit fuer alle offenen Browser zusammen beim Beendigungssignal. */
const GESAMT_FRIST_MS = 12_000;

type Schliessbar = { quit(): Promise<void>; getSession?: () => Promise<{ getId(): string } | undefined> };
type Eintrag = { driver: Schliessbar; profil: string | null };

const offen = new Set<Eintrag>();
let signaleVerdrahtet = false;
let protokoll: (zeile: string) => void = () => {};

/** Protokollfunktion setzen (Producer-Logger); ohne sie bleibt das Modul still. */
export function browserProtokoll(log: (zeile: string) => void): void {
  protokoll = log;
}

/** Anzahl offener Browser dieses Prozesses (Diagnose, Tests). */
export function offeneBrowser(): number {
  return offen.size;
}

/** Legt ein frisches, leeres Profilverzeichnis an und liefert seinen Pfad. */
export function neuesProfilVerzeichnis(): string {
  return mkdtempSync(join(tmpdir(), AVA_PROFIL_PRAEFIX));
}

/**
 * Argumente, die jeder von AVA gestartete Chrome tragen muss: eigenes Profil
 * und die Kennung des Besitzerprozesses. Beides zusammen macht den Browser
 * eindeutig einem laufenden AVA-Prozess zuordenbar.
 */
export function profilArgumente(profil: string): string[] {
  return [AVA_BROWSER_SCHALTER, `--ava-owner=${process.pid}`, `--user-data-dir=${profil}`];
}

/**
 * Einen gebauten Browser in die Obhut dieses Moduls geben. `quit()` wird dabei
 * so umhuellt, dass es eine Frist hat, das Profilverzeichnis entfernt und den
 * Eintrag austraegt. Der Aufrufer ruft `quit()` weiterhin wie bisher.
 */
export function ueberwache<T extends Schliessbar>(driver: T, profil: string | null): T {
  const eintrag: Eintrag = { driver, profil };
  offen.add(eintrag);
  verdrahteSignale();

  const original = driver.quit.bind(driver);
  driver.quit = async () => {
    offen.delete(eintrag);
    try {
      await mitFrist(original(), SCHLIESS_FRIST_MS);
    } catch (err) {
      protokoll(`[browser] quit fehlgeschlagen oder ueberfaellig: ${fehlertext(err)}`);
    } finally {
      raeumeProfil(profil);
    }
  };
  return driver;
}

/**
 * Alle offenen Browser dieses Prozesses schliessen. Wird beim Beendigungssignal
 * gerufen und kann auch von Hand benutzt werden. Fehler einzelner Browser
 * halten die uebrigen nicht auf.
 */
export async function schliesseAlleBrowser(): Promise<number> {
  const alle = [...offen];
  if (alle.length === 0) return 0;
  protokoll(`[browser] schliesse ${alle.length} offene Browser`);
  await mitFrist(
    Promise.all(
      alle.map(async (e) => {
        offen.delete(e);
        try {
          await mitFrist(e.driver.quit(), SCHLIESS_FRIST_MS);
        } catch (err) {
          protokoll(`[browser] quit fehlgeschlagen: ${fehlertext(err)}`);
        } finally {
          raeumeProfil(e.profil);
        }
      }),
    ),
    GESAMT_FRIST_MS,
  ).catch(() => {
    protokoll("[browser] Gesamtfrist beim Schliessen ueberschritten");
  });
  return alle.length;
}

/**
 * Beendigungssignale behandeln. Ohne das endet Node sofort und laesst
 * chromedriver und Chrome als Waisen zurueck — die Ursache der verwaisten
 * Prozesse auf den Rechnern der Nutzer.
 *
 * Der Handler ist gegen Mehrfachaufruf gesichert: Kommt waehrend des
 * Aufraeumens ein zweites Signal, wird sofort beendet.
 */
function verdrahteSignale(): void {
  if (signaleVerdrahtet) return;
  signaleVerdrahtet = true;
  let laeuft = false;
  const behandle = (signal: NodeJS.Signals) => {
    if (laeuft) {
      process.exit(1);
      return;
    }
    laeuft = true;
    protokoll(`[browser] ${signal} empfangen — schliesse Browser vor dem Beenden`);
    void schliesseAlleBrowser()
      .catch(() => undefined)
      .finally(() => {
        process.exit(0);
      });
  };
  for (const signal of ["SIGTERM", "SIGINT", "SIGHUP"] as NodeJS.Signals[]) {
    try {
      process.on(signal, () => behandle(signal));
    } catch {
      /* Signal auf dieser Plattform nicht verfuegbar */
    }
  }
  // Letzte Gelegenheit bei einem regulaeren Ende: synchron laesst sich der
  // Browser nicht mehr schliessen, aber das Profil kann weg.
  process.on("exit", () => {
    for (const e of offen) raeumeProfil(e.profil);
  });
}

function raeumeProfil(profil: string | null): void {
  if (!profil) return;
  try {
    rmSync(profil, { recursive: true, force: true });
  } catch {
    /* Aufraeumen ist Komfort, kein Muss */
  }
}

function mitFrist<T>(p: Promise<T>, ms: number): Promise<T> {
  let zeiger: NodeJS.Timeout | undefined;
  return Promise.race([
    p,
    new Promise<never>((_, ab) => {
      zeiger = setTimeout(() => ab(new Error(`Frist von ${ms} ms ueberschritten`)), ms);
      zeiger.unref?.();
    }),
  ]).finally(() => {
    if (zeiger) clearTimeout(zeiger);
  }) as Promise<T>;
}

function fehlertext(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

// Warteschlange fuer Relevanz-Signale (docs/PLAN_RELEVANZ.md, 4.3).
//
// Ein Netzaufruf je Klick waere dreifach falsch: Er haengt die Oberflaeche
// an die Netzverbindung, erzeugt Last fuer Daten, die in dieser Sekunde
// niemand braucht, und macht AVA ohne Netz stumpf. Signale gehen deshalb
// erst hierher und werden gebuendelt uebertragen.
//
// Das ist ein Puffer, KEIN zweiter Speicher: Uebertragenes wird geloescht.
// Was hier liegen bleibt, ist ausschliesslich das, was noch nicht
// angekommen ist.

import { app } from "electron";
import { mkdirSync, readFileSync, writeFileSync, renameSync } from "node:fs";
import { join } from "node:path";
import { randomUUID } from "node:crypto";

export interface AusgangSignal {
  /** Vom Geraet vergeben. Macht einen zweiten Versuch folgenlos. */
  geraetRef: string;
  zielArt: "firma" | "person";
  zielId: string;
  firmaId?: string | null;
  art: string;
  punkte: number;
  halbwertT: number;
  zeitpunkt: string;
  gewicht?: number;
}

/** Mehr passt nicht hinein; Aelteste fallen heraus. */
const DECKEL = 5000;

let geladen = false;
let eintraege: AusgangSignal[] = [];

function pfad(): string {
  const dir = join(app.getPath("userData"), "relevanz");
  mkdirSync(dir, { recursive: true });
  return join(dir, "ausgang.json");
}

function lade(): void {
  if (geladen) return;
  geladen = true;
  try {
    const roh = JSON.parse(readFileSync(pfad(), "utf8")) as unknown;
    eintraege = Array.isArray(roh) ? (roh as AusgangSignal[]).filter(istGueltig) : [];
  } catch {
    // Keine Datei, oder sie ist unlesbar. Beides ist kein Grund, den Start
    // zu stoeren — verlorene Signale sind verschmerzbar, ein Absturz nicht.
    eintraege = [];
  }
}

function istGueltig(e: unknown): e is AusgangSignal {
  if (typeof e !== "object" || e === null) return false;
  const s = e as Partial<AusgangSignal>;
  return (
    typeof s.geraetRef === "string" &&
    (s.zielArt === "firma" || s.zielArt === "person") &&
    typeof s.zielId === "string" && s.zielId.length > 0 &&
    typeof s.art === "string" &&
    typeof s.punkte === "number" && Number.isFinite(s.punkte) &&
    typeof s.halbwertT === "number" && Number.isFinite(s.halbwertT) &&
    typeof s.zeitpunkt === "string"
  );
}

function schreibe(): void {
  try {
    // Ueber eine Nebendatei, damit ein Absturz mitten im Schreiben nicht
    // die ganze Warteschlange zerlegt.
    const ziel = pfad();
    const temp = `${ziel}.neu`;
    writeFileSync(temp, JSON.stringify(eintraege), { mode: 0o600 });
    renameSync(temp, ziel);
  } catch {
    /* Ein misslungenes Speichern kostet Signale, nicht mehr. */
  }
}

export function neueKennung(): string {
  return randomUUID();
}

export function anhaengen(signal: Omit<AusgangSignal, "geraetRef">): void {
  lade();
  eintraege.push({ ...signal, geraetRef: neueKennung() });
  if (eintraege.length > DECKEL) eintraege = eintraege.slice(-DECKEL);
  schreibe();
}

export function anzahl(): number {
  lade();
  return eintraege.length;
}

/** Die naechsten `n` Eintraege, ohne sie zu entfernen. */
export function naechste(n: number): AusgangSignal[] {
  lade();
  return eintraege.slice(0, n);
}

/** Nach erfolgreicher Uebertragung: genau diese Eintraege streichen. */
export function bestaetigen(uebertragen: AusgangSignal[]): void {
  lade();
  const weg = new Set(uebertragen.map((e) => e.geraetRef));
  eintraege = eintraege.filter((e) => !weg.has(e.geraetRef));
  schreibe();
}

/** Beim Abschalten der Funktion: alles Unversandte verwerfen. */
export function leeren(): void {
  lade();
  eintraege = [];
  schreibe();
}

// Die Tageszusammenfassung (docs/PLAN_RELEVANZ.md, Abschnitt 6).
//
// Meldungen zu lauwarmen Firmen sollen nicht einzeln stoeren, aber auch
// nicht verschwinden. Sie sammeln sich hier und gehen einmal taeglich als
// EINE Meldung raus: "7 Funde bei 5 Firmen, die du im Blick hast."
//
// Der Unterschied zum Wegwerfen ist der ganze Punkt. Wer eine Firma
// lauwarm hat, will nicht bei jedem Positionswechsel aufschrecken — aber
// er will am Abend sehen, dass es ihn gab.

import { app } from "electron";
import { mkdirSync, readFileSync, writeFileSync, renameSync } from "node:fs";
import { join } from "node:path";
import type { AlertKind, AlertSeverity } from "../../shared/types";

export interface GesammelteMeldung {
  companyId: string;
  companyName: string;
  kind: AlertKind;
  severity: AlertSeverity;
  headline: string;
  sourceRef: string;
  occurredAt: string;
  gesammeltAm: string;
}

/** Aelteres faellt weg: Was eine Woche liegt, ist keine Neuigkeit mehr. */
const HOECHSTALTER_TAGE = 7;
/** Deckel gegen Auswuchern, falls die Zusammenfassung lange nicht lief. */
const DECKEL = 500;

interface Datei {
  meldungen: GesammelteMeldung[];
  /** Tag der letzten Zusammenfassung, als YYYY-MM-TT. */
  letzteAm: string | null;
}

let geladen: Datei | null = null;

function pfad(): string {
  const dir = join(app.getPath("userData"), "relevanz");
  mkdirSync(dir, { recursive: true });
  return join(dir, "sammlung.json");
}

function lade(): Datei {
  if (geladen) return geladen;
  try {
    const roh = JSON.parse(readFileSync(pfad(), "utf8")) as Partial<Datei>;
    geladen = {
      meldungen: Array.isArray(roh.meldungen) ? roh.meldungen : [],
      letzteAm: typeof roh.letzteAm === "string" ? roh.letzteAm : null,
    };
  } catch {
    geladen = { meldungen: [], letzteAm: null };
  }
  return geladen;
}

function schreibe(): void {
  if (!geladen) return;
  try {
    const ziel = pfad();
    const temp = `${ziel}.neu`;
    writeFileSync(temp, JSON.stringify(geladen), { mode: 0o600 });
    renameSync(temp, ziel);
  } catch {
    /* Verlorene Sammlung kostet eine Zusammenfassung, nicht mehr. */
  }
}

export function sammle(m: Omit<GesammelteMeldung, "gesammeltAm">): void {
  const d = lade();
  // Derselbe Fund nicht zweimal: Der sourceRef ist dieselbe Kennung, mit
  // der auch die Alarmliste entdoppelt.
  if (d.meldungen.some((x) => x.sourceRef === m.sourceRef)) return;
  d.meldungen.push({ ...m, gesammeltAm: new Date().toISOString() });
  if (d.meldungen.length > DECKEL) d.meldungen = d.meldungen.slice(-DECKEL);
  schreibe();
}

export function anzahlGesammelt(): number {
  return lade().meldungen.length;
}

/** Steht heute eine Zusammenfassung an, und gibt es etwas zu sagen? */
export function faelligkeit(jetzt: Date): boolean {
  const d = lade();
  const heute = jetzt.toISOString().slice(0, 10);
  if (d.letzteAm === heute) return false;
  return frische(d.meldungen, jetzt).length > 0;
}

function frische(m: GesammelteMeldung[], jetzt: Date): GesammelteMeldung[] {
  const grenze = jetzt.getTime() - HOECHSTALTER_TAGE * 86_400_000;
  return m.filter((x) => new Date(x.gesammeltAm).getTime() >= grenze);
}

export interface Zusammenfassung {
  headline: string;
  rationale: string;
  /** Die staerkste Stufe unter den gesammelten Meldungen. */
  severity: AlertSeverity;
  sourceRef: string;
  anzahl: number;
}

/**
 * Die Sammlung zu einer Meldung zusammenziehen und leeren.
 *
 * Gibt null, wenn nichts ansteht. Der Text nennt Firmen beim Namen, nicht
 * nur Zahlen: "5 Funde bei Zimmer Group, Mueller KG und 2 weiteren" sagt
 * einem Menschen etwas, "5 Funde" nicht.
 */
export function zusammenfassen(jetzt: Date): Zusammenfassung | null {
  const d = lade();
  const heute = jetzt.toISOString().slice(0, 10);
  const m = frische(d.meldungen, jetzt);

  // Auch ohne Inhalt aufraeumen: Abgelaufenes soll nicht ewig liegen.
  d.meldungen = [];
  d.letzteAm = heute;
  schreibe();
  if (m.length === 0) return null;

  const firmen = Array.from(new Set(m.map((x) => x.companyName).filter(Boolean)));
  const genannt = firmen.slice(0, 2).join(" und ");
  const weitere = firmen.length - Math.min(2, firmen.length);
  const wo =
    firmen.length === 0
      ? ""
      : weitere > 0
        ? ` bei ${genannt} und ${weitere} weiteren`
        : ` bei ${genannt}`;

  const severity: AlertSeverity = m.some((x) => x.severity === "warn") ? "warn" : "info";

  return {
    headline:
      m.length === 1
        ? `Ein Fund${wo}`
        : `${m.length} Funde${wo}`,
    rationale:
      `Gesammelt, weil diese Firmen derzeit nicht im Vordergrund stehen. ` +
      `Im Einzelnen:\n` +
      m.slice(0, 20).map((x) => `- ${x.companyName}: ${x.headline}`).join("\n") +
      (m.length > 20 ? `\n- … und ${m.length - 20} weitere` : ""),
    severity,
    // Eine Kennung je Tag: Ein zweiter Lauf am selben Tag erzeugt keine
    // zweite Meldung.
    sourceRef: `relevanz:tageszusammenfassung:${heute}`,
    anzahl: m.length,
  };
}

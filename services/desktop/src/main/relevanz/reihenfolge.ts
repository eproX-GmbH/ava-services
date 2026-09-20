// In welcher Reihenfolge der Heartbeat arbeitet (docs/PLAN_RELEVANZ.md, 5.3/6).
//
// Der knappe Stoff ist nicht die Zeit, sondern die Zahl der Urteile je
// Durchgang: Jeder Kandidat kostet einen LLM-Aufruf, und was hinten
// abgeschnitten wird, sieht der Nutzer nie. Diese Datei entscheidet
// deshalb, WAS abgeschnitten wird.
//
// Zwei Spuren, und die zweite ist der eigentliche Punkt:
//
//   Hauptspur      nach Rang, heiss zuerst.
//   Entdeckungsspur jeder vierte Platz, fuer Ziele mit hohem Gewicht und
//                   niedriger Naehe — sachlich passende Firmen, die der
//                   Nutzer noch nie angesehen hat.
//
// Ohne die zweite Spur baut sich eine Rueckkopplung auf: beurteilt wird,
// was warm ist; warm wird, was gemeldet wurde; gemeldet wird, was beurteilt
// wurde. Nach ein paar Wochen ist AVA blind fuer alles, was der Nutzer in
// der ersten Woche nicht angeklickt hat. Wenn an diesem Modul gespart
// wird, dann nicht hier.

import { GEWICHT_BEACHTLICH } from "./gewicht";

/** Jeder wievielte Platz gehoert der Entdeckungsspur. */
export const SPUR_JEDER = 4;
/** Bis zu dieser Naehe gilt ein Ziel als "noch nicht entdeckt". */
export const KALT_BIS = 3;
/** Ohne Wert: weder heiss noch bekannt. Mitte, damit Neues nicht untergeht. */
const OHNE_WERT = 3.5;

export interface Bewertet {
  /** Rang aus Naehe und Gewicht. */
  rang: number;
  naehe: number;
  gewicht: number;
}

/**
 * Alterung: Was lange nicht beobachtet wurde, steigt langsam.
 *
 * Ohne sie bliebe ein Ziel mit mittlerem Wert fuer immer hinter den heissen
 * liegen und wuerde nie wieder angesehen. Gedeckelt bei +3, damit blosses
 * Altern nichts an die Spitze traegt.
 */
export function alterung(tageSeitBeobachtung: number | null): number {
  if (tageSeitBeobachtung === null || tageSeitBeobachtung <= 30) return 0;
  return Math.min(3, (tageSeitBeobachtung - 30) / 30);
}

/** Gehoert das Ziel in die Entdeckungsspur? */
export function istEntdeckung(w: Bewertet | undefined): boolean {
  if (!w) return false;
  return w.naehe <= KALT_BIS && w.gewicht >= GEWICHT_BEACHTLICH;
}

/**
 * Kandidaten in Arbeitsreihenfolge bringen.
 *
 * `wertFuer` liefert den bekannten Wert eines Kandidaten, oder undefined,
 * wenn es noch keinen gibt. Unbekannte landen in der Mitte: Sie sind weder
 * nachweislich wichtig noch nachweislich unwichtig, und sie ganz nach hinten
 * zu stellen hiesse, jeden neuen Fund zu verschlucken.
 */
export function reihenfolge<T>(
  kandidaten: T[],
  wertFuer: (k: T) => Bewertet | undefined,
  tageSeitBeobachtungFuer: (k: T) => number | null = () => null,
): T[] {
  const mitRang = kandidaten.map((k, i) => {
    const w = wertFuer(k);
    const basis = w ? w.rang : OHNE_WERT;
    return {
      k,
      i, // stabile Reihenfolge bei Gleichstand
      rang: basis + alterung(tageSeitBeobachtungFuer(k)),
      entdeckung: istEntdeckung(w),
    };
  });

  const nachRang = (a: typeof mitRang[number], b: typeof mitRang[number]) =>
    b.rang - a.rang || a.i - b.i;

  const haupt = [...mitRang].sort(nachRang);
  const spur = mitRang.filter((x) => x.entdeckung).sort(nachRang);

  // Verschraenken: Jeder SPUR_JEDER-te Platz geht an die Entdeckungsspur,
  // solange es dort etwas gibt. Faellt sie leer aus, ruecken die anderen
  // auf — eine reservierte Luecke waere verschenkte Arbeit.
  const ergebnis: T[] = [];
  const vergeben = new Set<number>();
  let hIdx = 0;
  let sIdx = 0;

  for (let platz = 1; ergebnis.length < mitRang.length; platz++) {
    const ausSpur = platz % SPUR_JEDER === 0;
    let genommen = false;

    if (ausSpur) {
      while (sIdx < spur.length) {
        const x = spur[sIdx++];
        if (!x || vergeben.has(x.i)) continue;
        vergeben.add(x.i);
        ergebnis.push(x.k);
        genommen = true;
        break;
      }
    }
    if (genommen) continue;

    while (hIdx < haupt.length) {
      const x = haupt[hIdx++];
      if (!x || vergeben.has(x.i)) continue;
      vergeben.add(x.i);
      ergebnis.push(x.k);
      genommen = true;
      break;
    }
    if (!genommen) break; // nichts mehr uebrig
  }

  return ergebnis;
}

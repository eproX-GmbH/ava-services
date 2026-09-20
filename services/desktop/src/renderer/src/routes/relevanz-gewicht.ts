// Das Gewicht einer Firma, im Fenster gebildet (docs/PLAN_RELEVANZ.md, 5.2).
//
// Spiegelt main/relevanz/gewicht.ts. Die Verdopplung ist Absicht: Der
// Renderer darf nicht in den Hauptprozess hineingreifen, und das Gewicht
// entsteht dort, wo die Firmendaten ohnehin liegen. Wer eine Seite aendert,
// aendert auch die andere — deshalb stehen beide Zahlen hier und dort.
//
// Warum es das ueberhaupt gibt: Die Naehe misst Aufmerksamkeit. Eine Firma,
// die noch nie jemand angesehen hat, kann trotzdem die wichtigste im
// Bestand sein. Das Gewicht ist der Wert, der OHNE Verhalten zustande
// kommt — und damit das Gegengewicht zur Rueckkopplung.

export interface GewichtMerkmale {
  /** ICP-Treffer 0..100, falls bekannt. */
  icpScore?: number | null;
  /** Insolvenz, Loeschung, Liquidation. */
  statusWarnung?: boolean;
  /** In "Meine Firmen" uebernommen. */
  meineFirma?: boolean;
  crmVerknuepft?: boolean;
  groesseImKorridor?: boolean;
}

/** 1 bis 10. Ohne Merkmale 1 — unbekannt, nicht schlecht. */
export function gewichtFuer(m: GewichtMerkmale): number {
  let summe = 1;
  if (typeof m.icpScore === "number" && Number.isFinite(m.icpScore)) {
    summe += Math.max(0, Math.min(4, (m.icpScore / 100) * 4));
  }
  if (m.statusWarnung) summe += 3;
  if (m.meineFirma) summe += 2;
  if (m.crmVerknuepft) summe += 2;
  if (m.groesseImKorridor) summe += 1;
  return Math.round(Math.max(1, Math.min(10, summe)) * 10) / 10;
}

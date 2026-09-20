// Das Gewicht: sachliche Passung einer Firma (docs/PLAN_RELEVANZ.md, 5.2).
//
// Die zweite der beiden Groessen, und der Grund, warum der Heartbeat nicht
// im Kreis laeuft. Die Naehe misst Aufmerksamkeit — beobachtet wird, was
// angesehen wurde; angesehen wird, was gemeldet wurde. Ohne einen Wert, der
// OHNE Verhalten zustande kommt, entstuende daraus ein blinder Fleck genau
// in der Groesse des Bestands, den der Nutzer in der ersten Woche nicht
// angeklickt hat.
//
// Deshalb: kein Verhalten, kein Verfall. Nur Sachlage.

export interface GewichtMerkmale {
  /** ICP-Treffer 0..100, falls bekannt (lokaler Match, privat). */
  icpScore?: number | null;
  /** Insolvenz, Loeschung, Liquidation — etwas ist im Gange. */
  statusWarnung?: boolean;
  /** In "Meine Firmen" uebernommen. */
  meineFirma?: boolean;
  /** Mit einem CRM-Datensatz verknuepft. */
  crmVerknuepft?: boolean;
  /** Groesse oder Umsatz im Zielkorridor des ICP. */
  groesseImKorridor?: boolean;
}

/**
 * 1 bis 10. Ohne jedes Merkmal: 1 — unbekannt, nicht schlecht.
 *
 * Eine Firma ohne Merkmale ist keine schlechte Firma, sondern eine, ueber
 * die AVA nichts weiss. Genau die soll die Entdeckungsspur des Heartbeats
 * gelegentlich ansehen, damit sich das aendert.
 */
export function gewichtFuer(m: GewichtMerkmale): number {
  let summe = 1;

  // ICP: 0..100 auf 0..4. Der groesste einzelne Beitrag — die Passung zum
  // Idealkundenprofil ist das einzige Merkmal, das etwas ueber den WERT
  // einer Firma sagt und nicht nur ueber ihren Zustand.
  if (typeof m.icpScore === "number" && Number.isFinite(m.icpScore)) {
    summe += Math.max(0, Math.min(4, (m.icpScore / 100) * 4));
  }

  // Statuswarnung: Bei einer Insolvenz oder Loeschung ist etwas im Gange,
  // das den Nutzer angeht — auch dann, wenn er die Firma nie angesehen hat.
  if (m.statusWarnung) summe += 3;
  if (m.meineFirma) summe += 2;
  if (m.crmVerknuepft) summe += 2;
  if (m.groesseImKorridor) summe += 1;

  return Math.round(Math.max(1, Math.min(10, summe)) * 10) / 10;
}

/** Ab diesem Gewicht ist eine Firma sachlich interessant genug fuer die
 *  Entdeckungsspur, auch ohne dass jemand sie je angesehen hat. */
export const GEWICHT_BEACHTLICH = 6;

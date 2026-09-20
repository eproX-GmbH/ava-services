// BC4 (docs/PLAN_BUYING_CENTER.md, Abschnitt 6) — Hervorhebung einer Person
// auf der Firmenwebsite. Der company-contact-Producer zaehlt je Seite durch
// (Platz, Anzahl, Foto, Zitat); hier wird daraus EIN Fakt je Person und
// Seite, dessen Wert lesbar bleibt UND sich zurueckparsen laesst:
//
//   "Platz 1 von 12, mit Foto, mit Zitat"
//
// Lesbar, weil der Wert im Herkunftsnachweis (Art. 15) und in der
// Belegkette des Buying Centers auftaucht. Parsbar, weil das Buying Center
// daraus einen Einfluss-Vorschlag ableitet (lib/buying-center-vorschlag.ts).
// Die Seite selbst steht in Observation.evidenceUrl.

export const HERVORHEBUNG_FELD = "websiteHervorhebung";

export interface Hervorhebung {
  /** 1-basiert, Position auf der Seite von oben. */
  platz: number;
  /** Personen auf der Seite insgesamt. */
  von: number;
  foto: boolean;
  zitat: boolean;
}

export function hervorhebungAlsWert(h: Hervorhebung): string {
  const teile = [`Platz ${h.platz} von ${h.von}`];
  if (h.foto) teile.push("mit Foto");
  if (h.zitat) teile.push("mit Zitat");
  return teile.join(", ");
}

/** Gegenstueck zu hervorhebungAlsWert; null fuer alles, was nicht daraus stammt. */
export function hervorhebungAusWert(v: string | null | undefined): Hervorhebung | null {
  const m = /^Platz (\d+) von (\d+)((?:, mit (?:Foto|Zitat))*)$/.exec((v ?? "").trim());
  if (!m) return null;
  const platz = Number(m[1]);
  const von = Number(m[2]);
  if (!Number.isInteger(platz) || !Number.isInteger(von) || platz < 1 || von < platz) return null;
  return { platz, von, foto: m[3].includes("mit Foto"), zitat: m[3].includes("mit Zitat") };
}

// Wie wichtig ein Ansprechpartner ist — fuer die Reihenfolge der Karten.
//
// Die Bewertung gab es bisher nur im Kontakt-Producer, und zwar nur, um aus
// den ueber Apify gefundenen Profilen die besten auszuwaehlen. Danach war
// sie weg: In der Firmenansicht standen Geschaeftsfuehrer, Support und
// Namen ohne Rolle gleichrangig nebeneinander.
//
// Deshalb wird sie hier erneut bestimmt, aus dem gespeicherten Titel. Das
// hat zwei Vorteile gegenueber einem mitgespeicherten Rang: Es gilt fuer
// ALLE Quellen (auch fuer Kontakte von der Firmenwebsite und aus der
// Websuche, die nie bewertet wurden) und rueckwirkend fuer den Bestand.
//
// Die Muster sind ein Zwilling zu rangFuerTitel in
// company-contact/src/infrastructure/contact-extraction/apify-company.ts —
// bei Aenderungen beide anpassen.

/** 3 = Geschaeftsleitung, 2 = Leitungsebene, 1 = vertrieblich oder
 *  kaufmaennisch, 0 = alles uebrige (auch: kein Titel bekannt). */
export function rangFuerTitel(titel: string | null | undefined): number {
  if (!titel) return 0;
  const t = titel.toLowerCase();
  if (
    /gesch(ä|ae)ftsf|managing director|\bceo\b|\bcfo\b|\bcto\b|\bcoo\b|founder|gr(ü|ue)nder|inhaber|\bowner\b|vorstand|prokurist/.test(t)
  )
    return 3;
  if (/leit|\bhead\b|direktor|director|bereichs/.test(t)) return 2;
  if (/vertrieb|\bsales\b|eink(a|ä|ae)uf|purchas|business development|marketing|key account/.test(t)) return 1;
  return 0;
}

/** Wort zum Rang, fuer die Zwischenueberschriften der Liste. */
export const RANG_TITEL: Record<number, string> = {
  3: "Geschäftsleitung",
  2: "Leitung",
  1: "Vertrieb und Einkauf",
  0: "Weitere",
};

/**
 * Personen nach Rang, dann nach Namen.
 *
 * Innerhalb eines Rangs alphabetisch, damit die Reihenfolge zwischen zwei
 * Aufrufen gleich bleibt — sonst springen die Karten, sobald eine Angabe
 * dazukommt.
 */
export function sortiereNachRang<T>(
  eintraege: T[],
  titelVon: (e: T) => string | null | undefined,
  nameVon: (e: T) => string,
): T[] {
  return [...eintraege].sort((a, b) => {
    const d = rangFuerTitel(titelVon(b)) - rangFuerTitel(titelVon(a));
    return d !== 0 ? d : nameVon(a).localeCompare(nameVon(b), "de");
  });
}

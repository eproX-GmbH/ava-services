// Register-Delta — companyId-Regel des Bestands (master-data), gespiegelt aus
// scripts/de/register_delta.ipynb: Gerichtsname in Grossbuchstaben, Umlaute
// aufgeloest, alles ausser A-Z0-9 entfernt (auch Leerzeichen), dann
// _ART_NUMMER, Zusatz direkt angehaengt. Blaetter frueherer Gerichte mit
// derselben Nummer bekommen _F<ALTGERICHT>.
//   Bad Oeynhausen HRB 2400            → BADOEYNHAUSEN_HRB_2400
//   Flensburg HRA 100 FL               → FLENSBURG_HRA_100FL
//   Bad Oeynhausen HRB 2400 (Herford)  → BADOEYNHAUSEN_HRB_2400_FHERFORD

export function idTeil(text: string): string {
  return text
    .trim()
    .toUpperCase()
    .replace(/Ä/g, "AE")
    .replace(/Ö/g, "OE")
    .replace(/Ü/g, "UE")
    .replace(/ß/g, "SS")
    .replace(/[^A-Z0-9]/g, "");
}

/** Zusatz-Schreibweise des Bestands, wo das Portal heute anders anzeigt (Original-Scraper 2023). */
export const ZUSATZ_ALIASE: Record<string, Record<string, string>> = {
  Bremen: { BHV: "BREMERHAVEN" },
};

export function zusatzBestand(gericht: string, zusatz: string): string {
  const z = (zusatz || "").toUpperCase();
  return ZUSATZ_ALIASE[gericht]?.[z] ?? z;
}

/**
 * Original-Regel: GERICHT_ART_NUMMERZUSATZ. Blaetter frueherer Gerichte tragen
 * die reine Nummer (wie im Bestand von 2023); nur wenn der Worker meldet, dass
 * zur Nummer auch ein aktuelles Blatt existiert (`mitFrueherSuffix`), kommt
 * `_F<ALTGERICHT>` dazu. Muss identisch bleiben zu packages/register-delta/src/ids.ts.
 */
export function companyIdAus(gericht: string, art: string, nummer: number | string, zusatz = "", frueher = "", mitFrueherSuffix = false): string {
  let id = `${idTeil(gericht)}_${art.toUpperCase()}_${String(nummer)}${zusatzBestand(gericht, zusatz)}`;
  if (frueher && mitFrueherSuffix) id += `_F${idTeil(frueher)}`;
  return id;
}

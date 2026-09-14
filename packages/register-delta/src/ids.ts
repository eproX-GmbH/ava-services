// companyId-Regel des Bestands (master-data), identisch zu
// services/db-gateway/src/lib/register-ids.ts und dem Notebook
// master-data/scripts/de/register_delta.ipynb.

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

/** Zusatz-Schreibweise des Bestands (Original-Scraper 2023), wo das Portal heute anders anzeigt. */
export const ZUSATZ_ALIASE: Record<string, Record<string, string>> = {
  Bremen: { BHV: "BREMERHAVEN" },
};

export function zusatzBestand(gericht: string, zusatz: string): string {
  const z = (zusatz || "").toUpperCase();
  return ZUSATZ_ALIASE[gericht]?.[z] ?? z;
}

/**
 * Original-Regel (scraper_unternehmensregister.ipynb): GERICHT_ART_NUMMERZUSATZ,
 * Zusatz ohne Leerzeichen, Umlaute im Zusatz bleiben (LUEBECK_HRB_264MÖ).
 * Blaetter frueherer Gerichte hatten im Original dieselbe Id wie die reine
 * Nummer; `mitFrueherSuffix` haengt nur dann `_F<ALTGERICHT>` an, wenn zur
 * selben Nummer auch ein aktuelles Blatt existiert (sonst Kollision).
 */
export function companyIdAus(gericht: string, art: string, nummer: number | string, zusatz = "", frueher = "", mitFrueherSuffix = false): string {
  let id = `${idTeil(gericht)}_${art.toUpperCase()}_${String(nummer)}${zusatzBestand(gericht, zusatz)}`;
  if (frueher && mitFrueherSuffix) id += `_F${idTeil(frueher)}`;
  return id;
}

/** Bestand → Anzeigename im Portal-Select. Abweichungen hier pflegen. */
export const GERICHT_ALIASE: Record<string, string> = {
  "Frankfurt/Oder": "Frankfurt (Oder)",
};

export function portalGericht(bestandGericht: string): string {
  return GERICHT_ALIASE[bestandGericht] ?? bestandGericht;
}

/** Portal-Schreibweise (Kopfzeile) → Bestand-Schreibweise, damit die companyId stabil bleibt. */
export function bestandGericht(portalName: string): string {
  for (const [bestand, portal] of Object.entries(GERICHT_ALIASE)) if (portal === portalName) return bestand;
  return portalName;
}

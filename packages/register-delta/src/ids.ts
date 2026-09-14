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

export function companyIdAus(gericht: string, art: string, nummer: number | string, zusatz = "", frueher = ""): string {
  let id = `${idTeil(gericht)}_${art.toUpperCase()}_${String(nummer)}${(zusatz || "").toUpperCase()}`;
  if (frueher) id += `_F${idTeil(frueher)}`;
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

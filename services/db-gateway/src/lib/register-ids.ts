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

export function companyIdAus(gericht: string, art: string, nummer: number | string, zusatz = "", frueher = ""): string {
  let id = `${idTeil(gericht)}_${art.toUpperCase()}_${String(nummer)}${(zusatz || "").toUpperCase()}`;
  if (frueher) id += `_F${idTeil(frueher)}`;
  return id;
}

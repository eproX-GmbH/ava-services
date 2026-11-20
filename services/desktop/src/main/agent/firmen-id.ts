// Firmen-IDs erkennen (2026-11-20, Befund Demo-Konto ChatGPT-Pruefung).
//
// Nutzer fuegen Firmen-IDs direkt in den Chat ein („Importiere OSNABRUECK_HRB_120444, …“).
// Das Modell hielt sie fuer Registerangaben, gab sie als Namen weiter bzw. suchte sie in
// der Live-Registersuche und importierte nichts. Diese Erkennung hebt solche Zeilen im
// Import-Werkzeug in `companyIds` (Sicherheitsnetz unabhaengig vom Modell).
//
// Formen: Deutschland <GERICHT>_<HRA|HRB|GNR|PR|VR|GSR>_<Nummer>[Zusatz]
// (z. B. OSNABRUECK_HRB_120444, BREMEN_HRB_2514BHV, HAMBURG_HRB_1_FALTONA),
// Oesterreich AT_FN…, Schweiz CH_CHE…, UK_…, NO_…, FI_…, Firmen ohne Register WEB_<DOMAIN>.

const DE = /^[A-Z][A-Z0-9]*(?:_[A-Z0-9]+)*_(?:HRA|HRB|GNR|PR|VR|GSR)_\d+[A-Z0-9_]*$/;
const AUSLAND = /^(?:AT_FN\d+[A-Z]?|CH_CHE\d{9}|UK_[A-Z0-9]{6,10}|NO_\d{9}|FI_\d{7}-?\d|WEB_[A-Z0-9][A-Z0-9._-]*)$/;

export function istFirmenId(s: unknown): s is string {
  if (typeof s !== "string") return false;
  const t = s.trim();
  return t.length >= 6 && t.length <= 64 && (DE.test(t) || AUSLAND.test(t));
}

/**
 * Argumente von import_companies vor der Pruefung: Zeilen in `companies`, die in Wahrheit
 * Firmen-IDs sind (als Name, als blanker Text, ohne Ort), wandern nach `companyIds`.
 * Alles andere bleibt unveraendert.
 */
export function firmenIdsAusZeilen<T>(v: T): T {
  if (!v || typeof v !== "object") return v;
  const a = v as Record<string, unknown>;
  if (!Array.isArray(a.companies)) return v;
  const ids = Array.isArray(a.companyIds) ? a.companyIds.filter((x): x is string => typeof x === "string") : [];
  const rest: unknown[] = [];
  let verschoben = 0;
  for (const z of a.companies) {
    const kandidat = typeof z === "string" ? z : z && typeof z === "object" ? (z as { name?: unknown }).name : undefined;
    if (istFirmenId(kandidat) && !(z && typeof z === "object" && (z as { crm?: unknown }).crm)) {
      ids.push(kandidat.trim());
      verschoben++;
    } else rest.push(z);
  }
  if (verschoben === 0) return v;
  const out: Record<string, unknown> = { ...a, companyIds: [...new Set(ids)] };
  if (rest.length > 0) out.companies = rest;
  else delete out.companies;
  return out as T;
}

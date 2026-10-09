// Firmen-Radar fuer mehrere Laender (docs/PLAN_RADAR_LAENDER.md, L1/L4).
//
// Das Land haengt am Suchgebiet: ein ICP-Ort darf das Kuerzel tragen
// ("Wien (AT)", "Manchester (UK)"), ohne Kuerzel gilt Deutschland. Je Land
// gibt es ein Profil fuer die Google-Places-Suche (Domain, Land, Sprache,
// Ortsangabe) und die Sprache der geplanten Suchanfragen.

export type RadarLand = "DE" | "AT" | "UK";
export const RADAR_LAENDER: readonly RadarLand[] = ["DE", "AT", "UK"];

export interface LandProfil {
  land: RadarLand;
  name: string;
  /** valueserp: google_domain / gl / hl / location (nur Places). */
  serp: { google_domain: string; gl: string; hl: string; location: string };
  /** Sprache der Suchanfragen des Planners und des Branche-Ort-Rueckfalls. */
  sprache: "de" | "en";
}

export const LAND_PROFILE: Record<RadarLand, LandProfil> = {
  DE: { land: "DE", name: "Deutschland", serp: { google_domain: "google.de", gl: "de", hl: "de", location: "Germany" }, sprache: "de" },
  AT: { land: "AT", name: "Österreich", serp: { google_domain: "google.at", gl: "at", hl: "de", location: "Austria" }, sprache: "de" },
  UK: { land: "UK", name: "Vereinigtes Königreich", serp: { google_domain: "google.co.uk", gl: "uk", hl: "en", location: "United Kingdom" }, sprache: "en" },
};

/** "Wien (AT)" → { ort: "Wien", land: "AT" }; ohne Kuerzel DE. */
export function ortMitLand(eingabe: string): { ort: string; land: RadarLand } {
  const m = /^(.*?)\s*\((DE|AT|UK|GB)\)\s*$/i.exec(eingabe.trim());
  if (!m) return { ort: eingabe.trim(), land: "DE" };
  const code = m[2]!.toUpperCase();
  return { ort: m[1]!.trim(), land: code === "GB" ? "UK" : (code as RadarLand) };
}

export function ortMitLandText(ort: string, land: RadarLand): string {
  return land === "DE" ? ort : `${ort} (${land})`;
}

/** Adresse eines Places-Treffers → PLZ und Ort je Land. */
export function parseAdresse(address: string | undefined, land: RadarLand): { plz: string | null; city: string | null } {
  if (!address) return { plz: null, city: null };
  if (land === "DE") {
    const m = /(\b\d{5}\b)\s+([^,]+)/.exec(address);
    if (m?.[1] && m[2]) return { plz: m[1], city: m[2].trim() };
  } else if (land === "AT") {
    const m = /(\b\d{4}\b)\s+([^,]+)/.exec(address);
    if (m?.[1] && m[2]) return { plz: m[1], city: m[2].trim() };
  } else {
    // "12 High St, Manchester M1 2AB, United Kingdom": Ort vor dem Postcode.
    const m = /([^,]+?)\s+([A-Z]{1,2}\d[A-Z\d]?\s*\d[A-Z]{2})\b/i.exec(address);
    if (m?.[1] && m[2]) return { plz: m[2].toUpperCase().replace(/\s+/g, " "), city: m[1].trim() };
  }
  const parts = address.split(",").map((p) => p.trim()).filter(Boolean);
  // Letztes Element ist oft das Land ("Deutschland", "United Kingdom"); davor der Ort.
  const ohneLand = parts.filter((p) => !/^(deutschland|germany|österreich|austria|united kingdom|uk|great britain)$/i.test(p));
  const last = ohneLand[ohneLand.length - 1];
  return { plz: null, city: last && last.length <= 60 ? last : null };
}

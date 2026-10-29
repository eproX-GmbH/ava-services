// Firmen-Radar fuer mehrere Laender (docs/PLAN_RADAR_LAENDER.md, L1/L4).
//
// Das Land haengt am Suchgebiet: ein ICP-Ort darf das Kuerzel tragen
// ("Wien (AT)", "Manchester (UK)"), ohne Kuerzel gilt Deutschland. Je Land
// gibt es ein Profil fuer die Google-Places-Suche (Domain, Land, Sprache,
// Ortsangabe) und die Sprache der geplanten Suchanfragen.

export type RadarLand = "DE" | "AT" | "CH" | "UK" | "NO" | "FI";
export const RADAR_LAENDER: readonly RadarLand[] = ["DE", "AT", "CH", "UK", "NO", "FI"];

export interface LandProfil {
  land: RadarLand;
  name: string;
  /** valueserp: google_domain / gl / hl / location (nur Places). */
  serp: { google_domain: string; gl: string; hl: string; location: string };
  /** Sprache der Suchanfragen des Planners und des Branche-Ort-Rueckfalls (ISO-639-1). */
  sprache: "de" | "en" | "nb" | "fi" | "sv" | "da";
}

/** Name der Suchsprache fuer den Planner-Prompt. */
export const SPRACHE_NAME: Record<LandProfil["sprache"], string> = { de: "Deutsch", en: "Englisch", nb: "Norwegisch (Bokmål)", fi: "Finnisch", sv: "Schwedisch", da: "Dänisch" };

export const LAND_PROFILE: Record<RadarLand, LandProfil> = {
  DE: { land: "DE", name: "Deutschland", serp: { google_domain: "google.de", gl: "de", hl: "de", location: "Germany" }, sprache: "de" },
  AT: { land: "AT", name: "Österreich", serp: { google_domain: "google.at", gl: "at", hl: "de", location: "Austria" }, sprache: "de" },
  // Deutschsprachig geplant; Places liefert in der Romandie und im Tessin trotzdem die lokalen Namen.
  CH: { land: "CH", name: "Schweiz", serp: { google_domain: "google.ch", gl: "ch", hl: "de", location: "Switzerland" }, sprache: "de" },
  UK: { land: "UK", name: "Vereinigtes Königreich", serp: { google_domain: "google.co.uk", gl: "uk", hl: "en", location: "United Kingdom" }, sprache: "en" },
  NO: { land: "NO", name: "Norwegen", serp: { google_domain: "google.no", gl: "no", hl: "no", location: "Norway" }, sprache: "nb" },
  FI: { land: "FI", name: "Finnland", serp: { google_domain: "google.fi", gl: "fi", hl: "fi", location: "Finland" }, sprache: "fi" },
};

/** "Wien (AT)", "Zürich (CH)" → { ort, land }; ohne Kuerzel DE. */
export function ortMitLand(eingabe: string): { ort: string; land: RadarLand } {
  const m = /^(.*?)\s*\((DE|AT|CH|UK|GB|NO|FI)\)\s*$/i.exec(eingabe.trim());
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
  } else if (land === "AT" || land === "CH" || land === "NO") {
    const m = /(\b\d{4}\b)\s+([^,]+)/.exec(address);
    if (m?.[1] && m[2]) return { plz: m[1], city: m[2].trim() };
  } else if (land === "FI") {
    // Vierstellige PLZ vor dem Ort ("Bahnhofstrasse 1, 8001 Zürich, Schweiz").
    const m = /(\b\d{4}\b)\s+([^,]+)/.exec(address);
    if (m?.[1] && m[2]) return { plz: m[1], city: m[2].trim() };
  } else {
    // "12 High St, Manchester M1 2AB, United Kingdom": Ort vor dem Postcode.
    const m = /([^,]+?)\s+([A-Z]{1,2}\d[A-Z\d]?\s*\d[A-Z]{2})\b/i.exec(address);
    if (m?.[1] && m[2]) return { plz: m[2].toUpperCase().replace(/\s+/g, " "), city: m[1].trim() };
  }
  const parts = address.split(",").map((p) => p.trim()).filter(Boolean);
  // Letztes Element ist oft das Land ("Deutschland", "United Kingdom"); davor der Ort.
  const ohneLand = parts.filter((p) => !/^(deutschland|germany|österreich|austria|schweiz|switzerland|suisse|svizzera|united kingdom|uk|great britain|norwegen|norway|norge|finnland|finland|suomi)$/i.test(p));
  const last = ohneLand[ohneLand.length - 1];
  return { plz: null, city: last && last.length <= 60 ? last : null };
}

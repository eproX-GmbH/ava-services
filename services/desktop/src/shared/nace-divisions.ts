// v0.1.331 — NACE Rev. 2 / WZ 2008 Abteilungen (2-stellige Codes).
//
// Offizielle Klassifikation der Wirtschaftszweige (WZ 2008) des
// Statistischen Bundesamts (Destatis), basierend auf der EU-Verordnung
// (EG) Nr. 1893/2006. 88 Abteilungen, gegliedert in 21 Abschnitte (A–U).
//
// Quelle: https://www.destatis.de/DE/Methoden/Klassifikationen/
//         Gueter-Wirtschaftsklassifikationen/klassifikation-wz-2008.html
//
// Diese Datei ist die Single Source of Truth für AVA. Producer +
// Frontend importieren von hier; das LLM bekommt die Liste als
// Constraint im Klassifikations-Prompt.

/** Code (2-stellig, als String wegen führender Null bei 01–09) →
 *  offizieller deutscher Display-Name aus WZ 2008. */
export const NACE_DIVISIONS: Record<string, string> = {
  // A — Land- und Forstwirtschaft, Fischerei
  "01": "Landwirtschaft, Jagd und damit verbundene Tätigkeiten",
  "02": "Forstwirtschaft und Holzeinschlag",
  "03": "Fischerei und Aquakultur",
  // B — Bergbau und Gewinnung von Steinen und Erden
  "05": "Kohlenbergbau",
  "06": "Gewinnung von Erdöl und Erdgas",
  "07": "Erzbergbau",
  "08": "Gewinnung von Steinen und Erden, sonstiger Bergbau",
  "09": "Erbringung von Dienstleistungen für den Bergbau und für die Gewinnung von Steinen und Erden",
  // C — Verarbeitendes Gewerbe
  "10": "Herstellung von Nahrungs- und Futtermitteln",
  "11": "Getränkeherstellung",
  "12": "Tabakverarbeitung",
  "13": "Herstellung von Textilien",
  "14": "Herstellung von Bekleidung",
  "15": "Herstellung von Leder, Lederwaren und Schuhen",
  "16": "Herstellung von Holz-, Flecht-, Korb- und Korkwaren (ohne Möbel)",
  "17": "Herstellung von Papier, Pappe und Waren daraus",
  "18": "Herstellung von Druckerzeugnissen; Vervielfältigung von bespielten Ton-, Bild- und Datenträgern",
  "19": "Kokerei und Mineralölverarbeitung",
  "20": "Herstellung von chemischen Erzeugnissen",
  "21": "Herstellung von pharmazeutischen Erzeugnissen",
  "22": "Herstellung von Gummi- und Kunststoffwaren",
  "23": "Herstellung von Glas und Glaswaren, Keramik, Verarbeitung von Steinen und Erden",
  "24": "Metallerzeugung und -bearbeitung",
  "25": "Herstellung von Metallerzeugnissen",
  "26": "Herstellung von Datenverarbeitungsgeräten, elektronischen und optischen Erzeugnissen",
  "27": "Herstellung von elektrischen Ausrüstungen",
  "28": "Maschinenbau",
  "29": "Herstellung von Kraftwagen und Kraftwagenteilen",
  "30": "Sonstiger Fahrzeugbau",
  "31": "Herstellung von Möbeln",
  "32": "Herstellung von sonstigen Waren",
  "33": "Reparatur und Installation von Maschinen und Ausrüstungen",
  // D — Energieversorgung
  "35": "Energieversorgung",
  // E — Wasserversorgung; Abwasser- und Abfallentsorgung
  "36": "Wasserversorgung",
  "37": "Abwasserentsorgung",
  "38": "Sammlung, Behandlung und Beseitigung von Abfällen; Rückgewinnung",
  "39": "Beseitigung von Umweltverschmutzungen und sonstige Entsorgung",
  // F — Baugewerbe
  "41": "Hochbau",
  "42": "Tiefbau",
  "43": "Vorbereitende Baustellenarbeiten, Bauinstallation und sonstiges Ausbaugewerbe",
  // G — Handel; Instandhaltung und Reparatur von Kraftfahrzeugen
  "45": "Handel mit Kraftfahrzeugen; Instandhaltung und Reparatur von Kraftfahrzeugen",
  "46": "Großhandel (ohne Handel mit Kraftfahrzeugen)",
  "47": "Einzelhandel (ohne Handel mit Kraftfahrzeugen)",
  // H — Verkehr und Lagerei
  "49": "Landverkehr und Transport in Rohrfernleitungen",
  "50": "Schifffahrt",
  "51": "Luftfahrt",
  "52": "Lagerei sowie Erbringung von sonstigen Dienstleistungen für den Verkehr",
  "53": "Post-, Kurier- und Expressdienste",
  // I — Gastgewerbe
  "55": "Beherbergung",
  "56": "Gastronomie",
  // J — Information und Kommunikation
  "58": "Verlagswesen",
  "59": "Herstellung, Verleih und Vertrieb von Filmen und Fernsehprogrammen; Kinos; Tonstudios und Verlegen von Musik",
  "60": "Rundfunkveranstalter",
  "61": "Telekommunikation",
  "62": "Erbringung von Dienstleistungen der Informationstechnologie",
  "63": "Informationsdienstleistungen",
  // K — Finanz- und Versicherungsdienstleistungen
  "64": "Erbringung von Finanzdienstleistungen",
  "65": "Versicherungen, Rückversicherungen und Pensionskassen (ohne Sozialversicherung)",
  "66": "Mit Finanz- und Versicherungsdienstleistungen verbundene Tätigkeiten",
  // L — Grundstücks- und Wohnungswesen
  "68": "Grundstücks- und Wohnungswesen",
  // M — Erbringung von freiberuflichen, wissenschaftlichen und technischen Dienstleistungen
  "69": "Rechts- und Steuerberatung, Wirtschaftsprüfung",
  "70": "Verwaltung und Führung von Unternehmen und Betrieben; Unternehmensberatung",
  "71": "Architektur- und Ingenieurbüros; technische, physikalische und chemische Untersuchung",
  "72": "Forschung und Entwicklung",
  "73": "Werbung und Marktforschung",
  "74": "Sonstige freiberufliche, wissenschaftliche und technische Tätigkeiten",
  "75": "Veterinärwesen",
  // N — Erbringung von sonstigen wirtschaftlichen Dienstleistungen
  "77": "Vermietung von beweglichen Sachen",
  "78": "Vermittlung und Überlassung von Arbeitskräften",
  "79": "Reisebüros, Reiseveranstalter und Erbringung sonstiger Reservierungsdienstleistungen",
  "80": "Wach- und Sicherheitsdienste sowie Detekteien",
  "81": "Gebäudebetreuung; Garten- und Landschaftsbau",
  "82": "Erbringung von wirtschaftlichen Dienstleistungen für Unternehmen und Privatpersonen a. n. g.",
  // O — Öffentliche Verwaltung, Verteidigung; Sozialversicherung
  "84": "Öffentliche Verwaltung, Verteidigung; Sozialversicherung",
  // P — Erziehung und Unterricht
  "85": "Erziehung und Unterricht",
  // Q — Gesundheits- und Sozialwesen
  "86": "Gesundheitswesen",
  "87": "Heime (ohne Erholungs- und Ferienheime)",
  "88": "Sozialwesen (ohne Heime)",
  // R — Kunst, Unterhaltung und Erholung
  "90": "Kreative, künstlerische und unterhaltende Tätigkeiten",
  "91": "Bibliotheken, Archive, Museen, botanische und zoologische Gärten",
  "92": "Spiel-, Wett- und Lotteriewesen",
  "93": "Erbringung von Dienstleistungen des Sports, der Unterhaltung und der Erholung",
  // S — Erbringung von sonstigen Dienstleistungen
  "94": "Interessenvertretungen sowie kirchliche und sonstige religiöse Vereinigungen (ohne Sozialwesen und Sport)",
  "95": "Reparatur von Datenverarbeitungsgeräten und Gebrauchsgütern",
  "96": "Erbringung von sonstigen überwiegend persönlichen Dienstleistungen",
  // T — Private Haushalte mit Hauspersonal; Herstellung von Waren und
  //     Erbringung von Dienstleistungen durch private Haushalte für den
  //     Eigenbedarf ohne ausgeprägten Schwerpunkt
  "97": "Private Haushalte mit Hauspersonal",
  "98": "Herstellung von Waren und Erbringung von Dienstleistungen durch private Haushalte für den Eigenbedarf ohne ausgeprägten Schwerpunkt",
  // U — Exterritoriale Organisationen und Körperschaften
  "99": "Exterritoriale Organisationen und Körperschaften",
};

/** Set aller gültigen NACE-Codes für yup/Validation-Zwecke. */
export const NACE_CODES = Object.keys(NACE_DIVISIONS);

/**
 * Liefert den Display-Name zu einem NACE-Code, oder null wenn der Code
 * nicht in der offiziellen Liste ist (z. B. wenn das LLM was anderes
 * geliefert hat oder das Feld leer ist).
 */
export function naceDisplayName(code: string | null | undefined): string | null {
  if (!code) return null;
  const trimmed = code.trim();
  return NACE_DIVISIONS[trimmed] ?? null;
}

/**
 * Parsed eine NACE-Branche aus dem Markdown-Profil-Text. Erwartetes
 * Format am Anfang des Profils (siehe company-profile producer prompt):
 *
 *   **NACE-Branche:** 62 (Erbringung von Dienstleistungen der Informationstechnologie)
 *
 * Wir tolerieren auch:
 *   - mit oder ohne führende Null beim Code (z. B. "1" → "01")
 *   - mit oder ohne Klammer-Annotation
 *   - Variable Whitespace
 *
 * Returnt { code, name } wenn ein gültiger Code matched, sonst null.
 */
export function parseNaceFromProfile(
  profile: string | null | undefined,
): { code: string; name: string } | null {
  if (!profile) return null;
  // Regex: erfasst ein- oder zweistellige Zahl direkt nach "NACE-Branche:"
  const match = profile.match(
    /\*\*NACE-Branche:\*\*\s*(\d{1,2})\b/i,
  );
  if (!match) return null;
  const raw = match[1] ?? "";
  const code = raw.length === 1 ? "0" + raw : raw;
  const name = NACE_DIVISIONS[code];
  if (!name) return null;
  return { code, name };
}

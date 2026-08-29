// Kategorie-Sanitizing fuer Discovery-Kandidaten.
//
// Quellen liefern rohe Tags: OSM office=yes/company (aussagelos),
// office=estate_agent, craft:electrician, Google-Places-Kategorien wie
// construction_company/advertising_agency (englisch, snake_case).
// Dieses Modul macht daraus deutsche Anzeige-Labels — angewandt beim
// INGEST (scan.ts, neue Kandidaten speichern sauber) UND beim LESEN
// (list.ts, damit Bestandsdaten mit Roh-Tags ebenfalls sauber
// erscheinen — der COALESCE-Upsert ueberschreibt Altwerte nicht).
//
// Die deutschen Labels sind zugleich die Match-Basis fuer die
// Profiling-Priorisierung (ICP-Branche "Immobilien" trifft
// "Immobilienmakler" per Substring).

const JUNK = new Set([
  "yes",
  "no",
  "company",
  "unknown",
  "vacant",
  "fixme",
  "point_of_interest",
  "establishment",
]);

const MAP: Record<string, string> = {
  estate_agent: "Immobilienmakler",
  real_estate_agency: "Immobilienmakler",
  real_estate_agent: "Immobilienmakler",
  property_management: "Hausverwaltung",
  property_management_company: "Hausverwaltung",
  lawyer: "Rechtsanwaltskanzlei",
  attorney: "Rechtsanwaltskanzlei",
  law_firm: "Rechtsanwaltskanzlei",
  notary: "Notariat",
  notary_public: "Notariat",
  accountant: "Steuer-/Buchhaltungsbuero",
  accounting: "Steuer-/Buchhaltungsbuero",
  tax_advisor: "Steuerberatung",
  tax_consultant: "Steuerberatung",
  financial_advisor: "Finanzberatung",
  financial: "Finanzdienstleister",
  insurance: "Versicherung",
  insurance_agency: "Versicherung",
  insurance_company: "Versicherung",
  bank: "Bank",
  architect: "Architekturbuero",
  architecture_firm: "Architekturbuero",
  engineer: "Ingenieurbuero",
  engineering: "Ingenieurbuero",
  engineering_consultant: "Ingenieurbuero",
  surveyor: "Vermessungsbuero",
  it: "IT-Dienstleister",
  software_company: "Softwareunternehmen",
  computer_consultant: "IT-Beratung",
  web_design: "Webdesign",
  telecommunication: "Telekommunikation",
  consulting: "Unternehmensberatung",
  management_consultant: "Unternehmensberatung",
  business_management_consultant: "Unternehmensberatung",
  advertising_agency: "Werbeagentur",
  marketing_agency: "Marketingagentur",
  graphic_designer: "Grafikdesign",
  construction_company: "Bauunternehmen",
  general_contractor: "Bauunternehmen",
  building_company: "Bauunternehmen",
  logistics: "Logistik",
  moving_company: "Umzugsunternehmen",
  transport: "Transport/Logistik",
  employment_agency: "Personalvermittlung",
  recruiter: "Personalvermittlung",
  travel_agent: "Reisebuero",
  travel_agency: "Reisebuero",
  publisher: "Verlag",
  research: "Forschung",
  educational_institution: "Bildungseinrichtung",
  energy_supplier: "Energieversorger",
  manufacturer: "Hersteller",
  wholesale: "Grosshandel",
  wholesaler: "Grosshandel",
};

/** Roh-Tag → deutsches Anzeige-Label. null = aussagelos (nicht zeigen). */
export function sanitizeCategory(raw: string | null | undefined): string | null {
  if (!raw) return null;
  let v = raw.trim().toLowerCase();
  if (!v) return null;
  let prefix = "";
  if (v.startsWith("craft:")) {
    prefix = "Handwerk: ";
    v = v.slice(6);
  }
  if (JUNK.has(v)) return prefix ? "Handwerk" : null;
  const mapped = MAP[v];
  if (mapped) return prefix ? `${prefix}${mapped}` : mapped;
  // Fallback: snake_case → lesbar ("metal_construction" → "Metal construction").
  const pretty = v
    .replace(/_/g, " ")
    .replace(/\s+/g, " ")
    .trim();
  if (pretty.length < 2) return null;
  const label = pretty.charAt(0).toUpperCase() + pretty.slice(1);
  return `${prefix}${label}`.slice(0, 120);
}

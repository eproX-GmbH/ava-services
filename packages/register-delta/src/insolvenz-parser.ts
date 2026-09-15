// Insolvenz-Delta I3 — reine Parser fuer das Insolvenzportal
// (neu.insolvenzbekanntmachungen.de). Referenz: master-data/scripts/de/insolvenz_delta.ipynb.

import { companyIdAus, idTeil } from "./ids";

export type InsolvenzGegenstand =
  | "EROEFFNUNG"
  | "ABWEISUNG_MANGELS_MASSE"
  | "SICHERUNGSMASSNAHME"
  | "AUFHEBUNG"
  | "EINSTELLUNG"
  | "ENTSCHEIDUNG"
  | "VERTEILUNG"
  | "INSOLVENZPLAN"
  | "SONSTIGES";

/** Insolvenzportal-Schreibweise des Registergerichts → Bestand (districtCourt). */
export const INSOLVENZ_GERICHT_ALIASE: Record<string, string> = {
  Berlin: "Berlin (Charlottenburg)",
  "Münster (Westfalen)": "Münster",
  "Freiburg im Breisgau": "Freiburg",
  "Friedberg (Hessen)": "Friedberg",
  "Königstein im Taunus": "Königstein",
  "Landau in der Pfalz": "Landau",
  "Limburg a.d. Lahn": "Limburg",
  "Ludwigshafen am Rhein": "Ludwigshafen a.Rhein (Ludwigshafen)",
  "Bad Homburg v.d. Höhe": "Bad Homburg v.d.H.",
  "Frankfurt (Oder)": "Frankfurt/Oder",
  "Weiden i.d. OPf": "Weiden i. d. OPf.",
  "Jena - Handels-, Genossenschafts- und Partnerschaftsregister": "Jena",
  "St. Ingbert": "St. Ingbert (St Ingbert)",
  "St. Wendel": "St. Wendel (St Wendel)",
};
for (const g of ["Altenburg", "Apolda", "Arnstadt", "Arnstadt - Zweigstelle Ilmenau", "Bad Salzungen", "Eisenach", "Erfurt", "Gera", "Gotha", "Greiz", "Heilbad Heiligenstadt", "Hildburghausen", "Meiningen", "Mühlhausen", "Nordhausen", "Pößneck", "Pößneck - Zweigstelle Bad Lobenstein", "Rudolstadt", "Sömmerda", "Sondershausen", "Sonneberg", "Stadtroda", "Weimar"]) {
  INSOLVENZ_GERICHT_ALIASE[g] = "Jena"; // historische Registergerichte Thueringen
}
for (const g of ["Merzig", "Neunkirchen", "Ottweiler", "Saarlouis", "Völklingen", "Wadern"]) INSOLVENZ_GERICHT_ALIASE[g] = "Saarbrücken";

const BESTAND_ZU_PORTAL = new Map<string, string>();
for (const [portal, bestand] of Object.entries(INSOLVENZ_GERICHT_ALIASE)) if (bestand !== "Jena" && bestand !== "Saarbrücken") BESTAND_ZU_PORTAL.set(bestand, portal);

/** Bestandsschreibweise → Anzeigename im Registergericht-Select des Insolvenzportals. */
export function insolvenzPortalGericht(bestand: string): string {
  return BESTAND_ZU_PORTAL.get(bestand) ?? bestand;
}

export function insolvenzBestandGericht(portal: string): string {
  return INSOLVENZ_GERICHT_ALIASE[portal] ?? portal;
}

export const INSOLVENZ_REGISTER_RE = /^(?<gericht>.+?), (?<art>HRA|HRB|GnR|GsR|PR|VR) (?<nummer>\d+)(?: (?<zusatz>[A-ZÄÖÜ]{1,3}))?$/u;

export type Registereintrag = { gericht: string; art: string; nummer: number; zusatz: string; companyId: string };

/** "Hamburg, HRA 90794" → Registereintrag mit companyId (Bestandsregel). */
export function parseRegistereintrag(text: string | null | undefined): Registereintrag | null {
  const m = INSOLVENZ_REGISTER_RE.exec((text ?? "").replace(/\s+/g, " ").trim());
  if (!m?.groups) return null;
  const gericht = insolvenzBestandGericht(m.groups.gericht);
  const zusatz = m.groups.zusatz ?? "";
  return { gericht, art: m.groups.art, nummer: Number(m.groups.nummer), zusatz, companyId: companyIdAus(gericht, m.groups.art, m.groups.nummer, zusatz) };
}

/** Rohzeile der Trefferliste (6 Zellen), wie das In-Page-Skript sie liefert. */
export type InsolvenzRohZeile = { index: number; zellen: string[] };

export type InsolvenzZeile = {
  index: number;
  datum: string; // TT.MM.JJJJ
  datumIso: string; // JJJJ-MM-TT
  aktenzeichen: string;
  insolvenzgericht: string;
  name: string;
  sitz: string;
  register: string;
  registereintrag: Registereintrag | null;
};

function isoAus(datum: string): string {
  const m = /^(\d{2})\.(\d{2})\.(\d{4})$/.exec(datum.trim());
  return m ? `${m[3]}-${m[2]}-${m[1]}` : datum;
}

export function parseTrefferliste(zeilen: InsolvenzRohZeile[]): InsolvenzZeile[] {
  const out: InsolvenzZeile[] = [];
  for (const z of zeilen) {
    const c = z.zellen.map((x) => x.replace(/\s+/g, " ").trim());
    if (c.length < 6) continue;
    out.push({ index: z.index, datum: c[0], datumIso: isoAus(c[0]), aktenzeichen: c[1], insolvenzgericht: c[2], name: c[3], sitz: c[4], register: c[5], registereintrag: parseRegistereintrag(c[5]) });
  }
  return out;
}

/** Kategorie einer Veroeffentlichung aus dem Text (Portal-Gegenstand ist ohne Filtersuche nicht bekannt). */
export function kategorieAusText(text: string): InsolvenzGegenstand {
  const t = text.toLowerCase().replace(/\s+/g, " ");
  if (/mangels masse abgewiesen|mangels einer .{0,60}masse/.test(t)) return "ABWEISUNG_MANGELS_MASSE";
  if (/wird aufgehoben|ist aufgehoben|aufhebung des insolvenzverfahrens/.test(t)) return "AUFHEBUNG";
  if (/wird eingestellt|einstellung des insolvenzverfahrens/.test(t)) return "EINSTELLUNG";
  if (/insolvenzplan/.test(t) && /überwach|bestätigt/.test(t)) return "INSOLVENZPLAN";
  if (/verteilungsverzeichnis|schlussverzeichnis/.test(t)) return "VERTEILUNG";
  if (/(wird|wurde) .{0,80}das insolvenzverfahren .{0,80}eröffnet|insolvenzverfahren .{0,40}eröffnet\b|eröffnung des insolvenzverfahrens/.test(t)) return "EROEFFNUNG";
  if (/vorläufige[rn]? insolvenzverwalter|sicherungsmaßnahme|allgemeines verfügungsverbot|vorläufige[rn]? sachwalter/.test(t)) return "SICHERUNGSMASSNAHME";
  return "ENTSCHEIDUNG";
}

/** Textstueck fuer Hash und Anzeige: Leerraum gebuendelt, HTML entfernt. */
export function bereinigeText(html: string): string {
  return html
    .replace(/<br\s*\/?>/gi, "\n")
    .replace(/<\/p>/gi, "\n")
    .replace(/<[^>]+>/g, " ")
    .replace(/&nbsp;/g, " ")
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/[ \t]+/g, " ")
    .replace(/\s*\n\s*/g, "\n")
    .trim();
}

export { idTeil };

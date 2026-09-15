// Oesterreich: Insolvenzdatei (Ediktsdatei, edikte.justiz.gv.at) je
// Firmenbuchnummer (Notebook scripts/at/firmenbuch_delta.ipynb §7).
//
//   FN-Suche  suchedi?SearchView&subf=f&...&query=([FN]=(588123m))
//             Pruefbuchstabe Pflicht (ohne → 0 Treffer), Gross/Klein egal.
//   Detail    0/<docId>!OpenDocument: eine Seite je Verfahren mit allen
//             Bekanntmachungen chronologisch ("Bekannt gemacht am ..."),
//             Felder als <dt>/<dd>; FN im Span Schuldner-Firmenbuchnummer.
// Kein Login, keine Session, plain GET. Takt 1 je Sekunde ohne Sperre gemessen.

import type { InsolvenzMeldung } from "./gateway-client";
import { companyIdAt } from "./at-firmenbuch";

export const EDIKTE_BASIS = "https://edikte.justiz.gv.at/edikte/id/idedi8.nsf";
export const EDIKTE_ABFRAGEN_JE_STUNDE = 3600;

export type EdikteEintrag = { docId: string; gericht: string; aktenzeichen: string; schuldner: string; ort: string };
export type EdikteAbschnitt = { datumIso: string | null; felder: Array<[string, string]> };
export type EdikteVerfahren = {
  docId: string;
  gericht: string;
  aktenzeichen: string;
  verfahren: string;
  schuldner: string;
  fn: string | null;
  abschnitte: EdikteAbschnitt[];
};

function entHtml(s: string): string {
  return s
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#39;|&apos;/g, "'")
    .replace(/&nbsp;/g, " ")
    .replace(/&#(\d+);/g, (_, n: string) => String.fromCodePoint(Number(n)))
    .replace(/&ouml;/g, "ö")
    .replace(/&auml;/g, "ä")
    .replace(/&uuml;/g, "ü")
    .replace(/&Ouml;/g, "Ö")
    .replace(/&Auml;/g, "Ä")
    .replace(/&Uuml;/g, "Ü")
    .replace(/&szlig;/g, "ß");
}

function ohneTags(s: string): string {
  return entHtml(s.replace(/<br\s*\/?>/gi, " / ").replace(/<[^>]+>/g, ""))
    .replace(/\s+/g, " ")
    .replace(/^[\s/]+|[\s/]+$/g, "");
}

/** Ergebnisliste (FN-Suche oder Tagesliste) → Eintraege. */
export function parseEdikteListe(html: string): { anzahl: number; eintraege: EdikteEintrag[] } {
  const eintraege: EdikteEintrag[] = [];
  const zeilen = html.match(/<tr>[\s\S]*?<\/tr>/g) ?? [];
  for (const z of zeilen) {
    const m = /href="0\/([0-9a-f]+)!OpenDocument"[^>]*>([^<]*)<\/a><\/td><td>([\s\S]*?)<\/td>/.exec(z);
    if (!m) continue;
    const az = entHtml(m[2]).trim();
    const komma = az.indexOf(", ");
    const teile = m[3].split(/<br\s*\/?>/i).map((t) => ohneTags(t));
    eintraege.push({
      docId: m[1],
      gericht: komma > 0 ? az.slice(0, komma) : az,
      aktenzeichen: komma > 0 ? az.slice(komma + 2) : "",
      schuldner: teile[0] ?? "",
      ort: teile[1] ?? "",
    });
  }
  const n = /hat\s+(\d+)\s+Eintr/.exec(html);
  return { anzahl: n ? Number(n[1]) : eintraege.length, eintraege };
}

const MONATE: Record<string, number> = {
  jänner: 1, januar: 1, februar: 2, märz: 3, april: 4, mai: 5, juni: 6, juli: 7, august: 8, september: 9, oktober: 10, november: 11, dezember: 12,
};

export function datumLang(s: string): string | null {
  const m = /(\d{1,2})\.\s*([A-Za-zÄÖÜäöü]+)\s+(\d{4})/.exec(s);
  if (!m) return null;
  const monat = MONATE[m[2].toLowerCase()];
  if (!monat) return null;
  return `${m[3]}-${String(monat).padStart(2, "0")}-${m[1].padStart(2, "0")}`;
}

function span(html: string, id: string): string | null {
  const m = new RegExp(`id="${id}">([^<]*)<`).exec(html);
  return m ? entHtml(m[1]).trim() || null : null;
}

/** Detailseite eines Verfahrens → Kopf und Abschnitte je Bekanntmachung. */
export function parseEdikteVerfahren(html: string, docId: string): EdikteVerfahren {
  const start = html.indexOf('<div class="anwcss">');
  const body = start >= 0 ? html.slice(start) : html;
  const abschnitte: EdikteAbschnitt[] = [];
  const teile = body.split('<div class="zeilehead">');
  for (const p of teile.slice(1)) {
    const ende = p.indexOf("</div>");
    const kopf = entHtml(p.slice(0, ende)).trim();
    if (!kopf.startsWith("Bekannt gemacht")) continue;
    const rest = p.slice(ende + 6);
    const felder: Array<[string, string]> = [];
    const re = /<dt>([\s\S]*?)<\/dt>\s*<dd>([\s\S]*?)<\/dd>/g;
    let m: RegExpExecArray | null;
    while ((m = re.exec(rest))) felder.push([ohneTags(m[1]).replace(/:$/, ""), ohneTags(m[2])]);
    abschnitte.push({ datumIso: datumLang(kopf), felder });
  }
  return {
    docId,
    gericht: span(html, "Dienststelle") ?? "",
    aktenzeichen: span(html, "Aktenzeichen") ?? "",
    verfahren: span(html, "Verfahren") ?? "",
    schuldner: span(html, "Schuldner") ?? "",
    fn: span(html, "Schuldner-Firmenbuchnummer"),
    abschnitte,
  };
}

/** Abbildung auf die Kategorien aus master-data (status-ableitung.ts). Keine Sicherungsmassnahmen in Oesterreich. */
export function kategorieAt(felder: Array<[string, string]>): InsolvenzMeldung["gegenstand"] {
  const keys = new Set(felder.map(([k]) => k));
  const text = felder.map(([, v]) => v).join(" ").toLowerCase();
  if (keys.has("Kostendeckung") || /mangels kostendeckung nicht eröffnet/.test(text)) return "ABWEISUNG_MANGELS_MASSE";
  if (keys.has("Aufhebung") || /\baufgehoben\b/.test(text)) return "AUFHEBUNG";
  if (keys.has("Einstellung") || /\beingestellt\b/.test(text)) return "EINSTELLUNG";
  if (keys.has("Eröffnung")) return "EROEFFNUNG";
  if (keys.has("Sanierungsplan") || keys.has("Zahlungsplan")) return "INSOLVENZPLAN";
  if (keys.has("Verteilung") || keys.has("Schlussverteilung")) return "VERTEILUNG";
  return "SONSTIGES";
}

const OHNE_TEXT = new Set(["Firmenbuchnummer", "Schuldner", "Masseverwalter", "Masseverwalterstellvertreter", "Text", "Vorname"]);

/** Verfahren → Meldungen (eine je Bekanntmachung), Text = uebrige Felder. */
export function meldungenAusVerfahren(v: EdikteVerfahren, companyId: string): InsolvenzMeldung[] {
  const out: InsolvenzMeldung[] = [];
  for (const a of v.abschnitte) {
    if (!a.datumIso) continue;
    const text = a.felder
      .filter(([k]) => !OHNE_TEXT.has(k))
      .map(([k, w]) => `${k}: ${w}`)
      .join("; ");
    out.push({
      companyId,
      aktenzeichen: v.aktenzeichen.slice(0, 60),
      insolvenzgericht: v.gericht.slice(0, 80),
      datum: a.datumIso,
      gegenstand: kategorieAt(a.felder),
      text: `${v.verfahren}. ${text}`.slice(0, 50_000),
      quelle: "ediktsdatei",
    });
  }
  return out;
}

export type EdikteOptionen = { fetchImpl?: typeof fetch; log?: (zeile: string) => void };

export class EdikteClient {
  private readonly f: typeof fetch;
  constructor(private readonly o: EdikteOptionen = {}) {
    this.f = o.fetchImpl ?? fetch;
  }

  private async get(url: string): Promise<{ status: number; text: string }> {
    const res = await this.f(url, { headers: { "user-agent": "AVA-Recherche (Kontakt: joyce@quikk.de)" } });
    return { status: res.status, text: res.ok ? await res.text() : "" };
  }

  /** Ergebnisliste zur FN (Pruefbuchstabe Pflicht). gesperrt bei 429/403. */
  async fnSuche(fnr: string): Promise<{ eintraege: EdikteEintrag[]; gesperrt: boolean }> {
    const fn = fnr.trim().toLowerCase().replace(/^fn\s*/, "");
    const q = encodeURIComponent(`([FN]=(${fn}))`);
    const r = await this.get(`${EDIKTE_BASIS}/suchedi?SearchView&subf=f&SearchOrder=4&SearchMax=4999&ftquery=&query=${q}`);
    if (r.status === 429 || r.status === 403) return { eintraege: [], gesperrt: true };
    if (r.status !== 200) throw new Error(`edikte suche ${r.status}`);
    return { eintraege: parseEdikteListe(r.text).eintraege, gesperrt: false };
  }

  async verfahren(docId: string): Promise<{ verfahren: EdikteVerfahren | null; gesperrt: boolean }> {
    if (!/^[0-9a-f]{32}$/.test(docId)) throw new Error(`edikte docId ungueltig: ${docId}`);
    const r = await this.get(`${EDIKTE_BASIS}/0/${docId}!OpenDocument`);
    if (r.status === 429 || r.status === 403) return { verfahren: null, gesperrt: true };
    if (r.status === 404) return { verfahren: null, gesperrt: false };
    if (r.status !== 200) throw new Error(`edikte detail ${r.status}`);
    return { verfahren: parseEdikteVerfahren(r.text, docId), gesperrt: false };
  }
}

/** Hilfe fuer Tests und Notebook: companyId der FN eines Verfahrens. */
export function companyIdAusVerfahren(v: EdikteVerfahren): string | null {
  try {
    return v.fn ? companyIdAt(v.fn) : null;
  } catch {
    return null;
  }
}

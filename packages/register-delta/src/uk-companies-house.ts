// Vereinigtes Koenigreich (docs/PLAN_UK.md): Companies House.
//
//   Bulk     download.companieshouse.gov.uk/en_output.html → monatlicher
//            Vollabzug aller lebenden Firmen als CSV in 7 Teil-ZIPs (kostenlos).
//   Web      find-and-update.company-information.service.gov.uk, ohne Login:
//            /company/<Nr> (Status, Rechtsform, Gruendung, Aufloesung, SIC, Sitz),
//            /company/<Nr>/insolvency (Faelle; 500 = keine Faelle).
//   Gazette  thegazette.co.uk Atom-Feed, Volltextsuche nach der Nummer.
// Rechtslage: "Companies House imposes no rules or requirements on how the
// information on the public register is used." Kein Browser, plain GET.

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { pipeline } from "node:stream/promises";
import { Readable } from "node:stream";
import yauzl from "yauzl";
import type { InsolvenzMeldung } from "./gateway-client";
import type { InsolvenzGegenstand } from "./insolvenz-parser";

export const CH_DOWNLOAD = "https://download.companieshouse.gov.uk";
export const CH_WEB = "https://find-and-update.company-information.service.gov.uk";
export const GAZETTE = "https://www.thegazette.co.uk";
/** Orientierung an der API-Grenze (600 je 5 min); im Web 0,5 je Sekunde. */
export const UK_ABFRAGEN_JE_STUNDE = 1800;
const UA = "AVA-Recherche (Kontakt: joyce@quikk.de)";

// ---- companyId ---------------------------------------------------------------

const NUMMER_RE = /^([A-Z]{0,2})([0-9]{1,8})([A-Z]{0,3})$/;

/** UK_ + 8 Zeichen: Praefix, Ziffern mit fuehrenden Nullen, Suffix (00077570 → UK_00077570, SC123456, IP12345R). */
export function companyIdUk(nummer: string): string {
  const n = nummer.trim().toUpperCase();
  const m = NUMMER_RE.exec(n);
  if (!m) throw new Error(`ungueltige Companies-House-Nummer: ${nummer}`);
  const [, p, z, s] = m;
  if (p.length + z.length + s.length > 8) throw new Error(`ungueltige Companies-House-Nummer: ${nummer}`);
  return `UK_${p}${z.padStart(8 - p.length - s.length, "0")}${s}`;
}

/** Registerbehoerde und Landesteil aus dem Nummernkreis. */
export function registrarUk(nummer: string): { behoerde: string; landesteil: string } {
  const p = (NUMMER_RE.exec(nummer.trim().toUpperCase())?.[1] ?? "") as string;
  if (/^(SC|SO|SL|SF|SA|SP|SR|CS|SI|SE)$/.test(p)) return { behoerde: "Companies House Edinburgh", landesteil: "Scotland" };
  if (/^(NI|NC|NL|NF|NP|NR|NO|NV)$/.test(p)) return { behoerde: "Companies House Belfast", landesteil: "Northern Ireland" };
  return { behoerde: "Companies House Cardiff", landesteil: "England and Wales" };
}

// ---- Abbildung ----------------------------------------------------------------

export type TrefferUk = {
  nummer: string;
  name: string;
  sitz: string;
  behoerde: string;
  landesteil: string;
  status: "ACTIVE" | "CLOSED" | "LOESCHUNG_ANGEKUENDIGT";
  insolvenz: "NONE" | "VERDACHT" | "EROEFFNET";
  legalForm?: string | null;
  street?: string | null;
  zipCode?: string | null;
  incorporatedAt?: string | null;
  sicCodes?: string[];
  /** fruehere Namen, aelteste zuerst */
  fruehereNamen?: string[];
};

const REGISTER_STATUS: Record<string, TrefferUk["status"]> = { "Active - Proposal to Strike off": "LOESCHUNG_ANGEKUENDIGT", Dissolved: "CLOSED" };
const INSOLVENZ_STATUS: Record<string, TrefferUk["insolvenz"]> = {
  Liquidation: "EROEFFNET",
  "In Administration": "EROEFFNET",
  "In Administration/Administrative Receiver": "EROEFFNET",
  "In Administration/Receiver Manager": "EROEFFNET",
  "ADMINISTRATIVE RECEIVER": "EROEFFNET",
  RECEIVERSHIP: "EROEFFNET",
  "ADMINISTRATION ORDER": "EROEFFNET",
  "Voluntary Arrangement": "EROEFFNET",
  "Live but Receiver Manager on at least one charge": "VERDACHT",
};

/** "LYTHAM ST ANNES" → "Lytham St Annes". */
export function titel(s: string): string {
  return s
    .trim()
    .replace(/[A-Za-z]+/g, (w) => (w.length <= 2 && /^[A-Z]+$/.test(w) && w !== "ST" && w !== "OF" ? w : w.charAt(0).toUpperCase() + w.slice(1).toLowerCase()));
}

function datumUk(s: string): string | null {
  const m = /^(\d{2})\/(\d{2})\/(\d{4})$/.exec(s.trim());
  return m ? `${m[3]}-${m[2]}-${m[1]}` : null;
}

/** Eine CSV-Zeile des Bulk-Abzugs (Spaltennamen ohne fuehrende Leerzeichen) → Treffer. */
export function bulkZeileZuTreffer(z: Record<string, string>): TrefferUk | null {
  const nummer = (z.CompanyNumber ?? "").trim().toUpperCase();
  const name = (z.CompanyName ?? "").trim();
  if (!nummer || !name) return null;
  try {
    companyIdUk(nummer);
  } catch {
    return null;
  }
  const { behoerde, landesteil } = registrarUk(nummer);
  const status = z.CompanyStatus ?? "";
  const frueher: Array<{ name: string; datum: string }> = [];
  for (let i = 1; i <= 10; i++) {
    const n = (z[`PreviousName_${i}.CompanyName`] ?? "").trim();
    if (n) frueher.push({ name: n, datum: datumUk(z[`PreviousName_${i}.CONDATE`] ?? "") ?? "" });
  }
  frueher.sort((a, b) => a.datum.localeCompare(b.datum));
  const sic = [1, 2, 3, 4].map((i) => (z[`SICCode.SicText_${i}`] ?? "").split(" - ")[0].trim()).filter((c) => /^\d{4,5}$/.test(c));
  const strasse = [z["RegAddress.AddressLine1"], z["RegAddress.AddressLine2"]].map((x) => (x ?? "").trim()).filter(Boolean).join(", ");
  return {
    nummer,
    name,
    sitz: titel(z["RegAddress.PostTown"] || z["RegAddress.County"] || ""),
    behoerde,
    landesteil: landesteil === "England and Wales" && z["RegAddress.Country"]?.trim().toUpperCase() === "WALES" ? "England and Wales" : landesteil,
    status: REGISTER_STATUS[status] ?? "ACTIVE",
    insolvenz: INSOLVENZ_STATUS[status] ?? "NONE",
    legalForm: (z.CompanyCategory ?? "").trim() || null,
    street: strasse ? titel(strasse) : null,
    zipCode: (z["RegAddress.PostCode"] ?? "").trim() || null,
    incorporatedAt: datumUk(z.IncorporationDate ?? ""),
    sicCodes: sic,
    fruehereNamen: frueher.map((f) => f.name),
  };
}

// ---- CSV (RFC 4180, Streaming) -------------------------------------------------

/** Zeilenweiser CSV-Parser fuer einen Text-Stream; ruft je Datensatz `zeile` mit den Spaltennamen der Kopfzeile. */
export async function parseCsvStream(quelle: AsyncIterable<Buffer | string>, zeile: (z: Record<string, string>) => Promise<void> | void): Promise<number> {
  let kopf: string[] | null = null;
  let feld = "";
  let felder: string[] = [];
  let inAnf = false;
  let n = 0;
  let rest = "";
  const abschluss = async () => {
    felder.push(feld);
    feld = "";
    if (!kopf) kopf = felder.map((k) => k.trim());
    else if (felder.length > 1 || felder[0] !== "") {
      const z: Record<string, string> = {};
      for (let i = 0; i < kopf.length; i++) z[kopf[i]] = felder[i] ?? "";
      n++;
      await zeile(z);
    }
    felder = [];
  };
  const decoder = new TextDecoder("utf-8");
  for await (const chunk of quelle) {
    const text = rest + (typeof chunk === "string" ? chunk : decoder.decode(chunk, { stream: true }));
    rest = "";
    for (let i = 0; i < text.length; i++) {
      const c = text[i];
      if (inAnf) {
        if (c === '"') {
          if (text[i + 1] === '"') {
            feld += '"';
            i++;
          } else if (i + 1 >= text.length) {
            // Anfuehrungszeichen am Chunk-Ende: Entscheidung im naechsten Chunk
            rest = '"';
          } else inAnf = false;
        } else feld += c;
        continue;
      }
      if (c === '"') inAnf = true;
      else if (c === ",") {
        felder.push(feld);
        feld = "";
      } else if (c === "\n") await abschluss();
      else if (c !== "\r") feld += c;
    }
    if (rest === '"') {
      // Nur moeglich, wenn das letzte Zeichen ein Anfuehrungszeichen innerhalb eines Felds war
      inAnf = true;
    }
  }
  if (feld !== "" || felder.length > 0) await abschluss();
  return n;
}

// ---- Bulk-Abzug -----------------------------------------------------------------

export type BulkTeil = { url: string; datum: string; teil: number; teile: number };

/** Download-Seite → Teil-Dateien des aktuellen Abzugs. */
export function parseBulkSeite(html: string): BulkTeil[] {
  const out: BulkTeil[] = [];
  const re = /href="(BasicCompanyData-(\d{4}-\d{2}-\d{2})-part(\d+)_(\d+)\.zip)"/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(html))) out.push({ url: `${CH_DOWNLOAD}/${m[1]}`, datum: m[2], teil: Number(m[3]), teile: Number(m[4]) });
  return out.sort((a, b) => a.teil - b.teil);
}

export type UkOptionen = { fetchImpl?: typeof fetch; log?: (zeile: string) => void; tmpDir?: string };

export class CompaniesHouseClient {
  private readonly f: typeof fetch;
  constructor(private readonly o: UkOptionen = {}) {
    this.f = o.fetchImpl ?? fetch;
  }

  private async get(url: string): Promise<{ status: number; text: string }> {
    const res = await this.f(url, { headers: { "user-agent": UA } });
    return { status: res.status, text: res.ok ? await res.text() : "" };
  }

  async bulkTeile(): Promise<BulkTeil[]> {
    const r = await this.get(`${CH_DOWNLOAD}/en_output.html`);
    if (r.status !== 200) throw new Error(`companieshouse download-seite ${r.status}`);
    return parseBulkSeite(r.text);
  }

  /**
   * Einen Teil-ZIP auf Platte laden, die CSV darin streamen und je Zeile
   * `zeile` rufen. Die Datei wird danach geloescht. Rueckgabe: Zeilenzahl.
   */
  async bulkTeilLesen(url: string, zeile: (t: TrefferUk) => Promise<void> | void): Promise<number> {
    const datei = path.join(this.o.tmpDir ?? os.tmpdir(), `ava-uk-${Date.now()}-${path.basename(url)}`);
    const res = await this.f(url, { headers: { "user-agent": UA } });
    if (!res.ok || !res.body) throw new Error(`companieshouse bulk ${res.status}`);
    await pipeline(Readable.fromWeb(res.body as never), fs.createWriteStream(datei));
    try {
      return await zipCsvLesen(datei, async (z) => {
        const t = bulkZeileZuTreffer(z);
        if (t) await zeile(t);
      });
    } finally {
      fs.rmSync(datei, { force: true });
    }
  }

  /** Firmenseite (ohne Login). null = unbekannt (404). */
  async firma(nummer: string): Promise<{ firma: FirmaUk | null; gesperrt: boolean }> {
    const r = await this.get(`${CH_WEB}/company/${encodeURIComponent(nummer.trim().toUpperCase())}`);
    if (r.status === 429 || r.status === 403) return { firma: null, gesperrt: true };
    if (r.status === 404) return { firma: null, gesperrt: false };
    if (r.status !== 200) throw new Error(`companieshouse firma ${r.status}`);
    return { firma: parseFirmaUk(r.text, nummer), gesperrt: false };
  }

  /** Insolvenzseite; antwortet mit 500, wenn es keine Faelle gibt. */
  async insolvenz(nummer: string): Promise<{ faelle: InsolvenzFallUk[]; gesperrt: boolean }> {
    const r = await this.get(`${CH_WEB}/company/${encodeURIComponent(nummer.trim().toUpperCase())}/insolvency`);
    if (r.status === 429 || r.status === 403) return { faelle: [], gesperrt: true };
    if (r.status !== 200) return { faelle: [], gesperrt: false };
    return { faelle: parseInsolvenzUk(r.text), gesperrt: false };
  }

  /** Gazette-Bekanntmachungen zur Nummer (Atom-Feed, Volltextsuche). */
  async gazette(nummer: string): Promise<{ eintraege: GazetteEintrag[]; gesperrt: boolean }> {
    const r = await this.get(`${GAZETTE}/insolvency/notice/data.feed?text=${encodeURIComponent(nummer.trim().toUpperCase())}&results-page-size=50`);
    if (r.status === 429 || r.status === 403) return { eintraege: [], gesperrt: true };
    if (r.status !== 200) return { eintraege: [], gesperrt: false };
    return { eintraege: parseGazetteFeed(r.text, nummer), gesperrt: false };
  }
}

async function zipCsvLesen(datei: string, zeile: (z: Record<string, string>) => Promise<void>): Promise<number> {
  return new Promise((resolve, reject) => {
    yauzl.open(datei, { lazyEntries: true }, (err, zip) => {
      if (err || !zip) return reject(err ?? new Error("zip"));
      let n = 0;
      zip.on("entry", (entry: yauzl.Entry) => {
        if (!/\.csv$/i.test(entry.fileName)) return zip.readEntry();
        zip.openReadStream(entry, (e2, stream) => {
          if (e2 || !stream) return reject(e2 ?? new Error("zip entry"));
          parseCsvStream(stream as AsyncIterable<Buffer>, zeile)
            .then((k) => {
              n += k;
              zip.readEntry();
            })
            .catch(reject);
        });
      });
      zip.on("end", () => resolve(n));
      zip.on("error", reject);
      zip.readEntry();
    });
  });
}

// ---- Firmenseite ------------------------------------------------------------------

export type FirmaUk = {
  nummer: string;
  name: string;
  status: string;
  rechtsform: string;
  gegruendet: string | null;
  aufgeloest: string | null;
  sitz: string;
  sic: string[];
};

function entHtml(s: string): string {
  return s
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#39;|&apos;/g, "'")
    .replace(/&nbsp;/g, " ")
    .replace(/&mdash;/g, "—")
    .replace(/&ndash;/g, "–")
    .replace(/&#(\d+);/g, (_, n: string) => String.fromCodePoint(Number(n)));
}
function ohneTags(s: string): string {
  return entHtml(s.replace(/<[^>]+>/g, " ")).replace(/\s+/g, " ").trim();
}

const MONATE_EN: Record<string, number> = { january: 1, february: 2, march: 3, april: 4, may: 5, june: 6, july: 7, august: 8, september: 9, october: 10, november: 11, december: 12 };
/** "8 February 2006" → 2006-02-08 */
export function datumEn(s: string): string | null {
  const m = /(\d{1,2})\s+([A-Za-z]+)\s+(\d{4})/.exec(s);
  if (!m) return null;
  const monat = MONATE_EN[m[2].toLowerCase()];
  return monat ? `${m[3]}-${String(monat).padStart(2, "0")}-${m[1].padStart(2, "0")}` : null;
}

function dlFelder(html: string): Record<string, string> {
  const out: Record<string, string> = {};
  const re = /<dt[^>]*>([\s\S]*?)<\/dt>\s*<dd[^>]*>([\s\S]*?)<\/dd>/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(html))) {
    const k = ohneTags(m[1].replace(/<span[^>]*>[\s\S]*?<\/span>/g, ""));
    if (!(k in out)) out[k] = ohneTags(m[2]);
  }
  return out;
}

export function parseFirmaUk(html: string, nummer: string): FirmaUk {
  const f = dlFelder(html);
  const h1 = /<h1 class="heading-xlarge"[^>]*>([\s\S]*?)<\/h1>/.exec(html);
  const sic = [...html.matchAll(/<span id="sic\d+">([\s\S]*?)<\/span>/g)].map((m) => ohneTags(m[1]).split(" - ")[0].trim()).filter((c) => /^\d{4,5}$/.test(c));
  return {
    nummer: nummer.trim().toUpperCase(),
    name: h1 ? ohneTags(h1[1]) : "",
    status: f["Company status"] ?? "",
    rechtsform: f["Company type"] ?? "",
    gegruendet: datumEn(f["Incorporated on"] ?? ""),
    aufgeloest: datumEn(f["Dissolved on"] ?? ""),
    sitz: f["Registered office address"] ?? "",
    sic,
  };
}

/** Firmenseite → Treffer (Refresh). Status "Dissolved" → CLOSED. */
export function firmaZuTreffer(fi: FirmaUk): TrefferUk | null {
  if (!fi.name) return null;
  const { behoerde, landesteil } = registrarUk(fi.nummer);
  const teile = fi.sitz.split(",").map((t) => t.trim()).filter(Boolean);
  const plz = teile.length > 1 && /^[A-Z]{1,2}\d[A-Z\d]?\s*\d[A-Z]{2}$/i.test(teile[teile.length - 1]) ? teile.pop() : null;
  const st = fi.status;
  return {
    nummer: fi.nummer,
    name: fi.name,
    sitz: teile.length > 1 ? teile[teile.length - 1] : "",
    behoerde,
    landesteil,
    status: st === "Dissolved" ? "CLOSED" : REGISTER_STATUS[st] ?? "ACTIVE",
    insolvenz: INSOLVENZ_STATUS[st] ?? "NONE",
    legalForm: fi.rechtsform || null,
    street: teile.length > 1 ? teile.slice(0, -1).join(", ") : teile[0] ?? null,
    zipCode: plz ?? null,
    incorporatedAt: fi.gegruendet,
    sicCodes: fi.sic,
  };
}

// ---- Insolvenzseite ---------------------------------------------------------------

export type InsolvenzFallUk = { fall: string; art: string; daten: Record<string, string>; verwalter: string[] };

export function parseInsolvenzUk(html: string): InsolvenzFallUk[] {
  const out: InsolvenzFallUk[] = [];
  for (const block of html.split(/<p class="heading-medium\s*" id="case-\d+">/).slice(1)) {
    const kopf = ohneTags(block.split("</p>")[0]);
    const daten: Record<string, string> = {};
    for (const m of block.matchAll(/<dt id="([a-z-]+)_title_\d+">[\s\S]*?<\/dt>\s*<dd[^>]*>([\s\S]*?)<\/dd>/g)) daten[m[1]] = ohneTags(m[2]);
    const verwalter = [...block.matchAll(/<dd id="case_\d+_practitioner_\d+_name"[^>]*>([\s\S]*?)<\/dd>/g)].map((m) => ohneTags(m[1].split("<br")[0]));
    out.push({ fall: kopf.split("—")[0].trim(), art: kopf.split("—").slice(1).join("—").trim(), daten, verwalter });
  }
  return out;
}

/** Faelle → Meldungen (Eroeffnung, Abschluss), quelle companieshouse. */
export function meldungenAusFaellen(faelle: InsolvenzFallUk[], companyId: string): InsolvenzMeldung[] {
  const out: InsolvenzMeldung[] = [];
  for (const f of faelle) {
    const az = `${f.fall}${f.art ? ` (${f.art})` : ""}`.slice(0, 60);
    const beginn = datumEn(f.daten["wound-up-on"] ?? f.daten["administration-started-on"] ?? f.daten["petitioned-on"] ?? "");
    const ende = datumEn(f.daten["concluded-winding-up-on"] ?? f.daten["administration-ended-on"] ?? f.daten["dissolved-on"] ?? "");
    const text = `${f.art}. ${Object.entries(f.daten)
      .map(([k, v]) => `${k}: ${v}`)
      .join("; ")}${f.verwalter.length ? `; Practitioner: ${f.verwalter.join(", ")}` : ""}`.slice(0, 50_000);
    if (beginn) out.push({ companyId, aktenzeichen: az, insolvenzgericht: "Companies House", datum: beginn, gegenstand: "EROEFFNUNG", text, quelle: "companieshouse" });
    if (ende) out.push({ companyId, aktenzeichen: az, insolvenzgericht: "Companies House", datum: ende, gegenstand: "AUFHEBUNG", text, quelle: "companieshouse" });
  }
  return out;
}

// ---- Gazette ---------------------------------------------------------------------------

export type GazetteEintrag = { id: string; titel: string; kategorie: string; datum: string; text: string };

export function parseGazetteFeed(xml: string, nummer: string): GazetteEintrag[] {
  const out: GazetteEintrag[] = [];
  const n = nummer.trim().toUpperCase();
  for (const e of xml.match(/<entry>[\s\S]*?<\/entry>/g) ?? []) {
    const g = (tag: string) => ohneTags(new RegExp(`<${tag}[^>]*>([\\s\\S]*?)</${tag}>`).exec(e)?.[1] ?? "");
    const kat = /<category[^>]*term="([^"]+)"/.exec(e)?.[1] ?? g("category");
    const text = g("content") || g("summary");
    // Volltextsuche: nur Eintraege, die die Nummer wirklich nennen.
    if (!new RegExp(`\\b${n}\\b`).test(`${text} ${g("title")}`)) continue;
    const id = /<id>([^<]+)<\/id>/.exec(e)?.[1] ?? "";
    out.push({ id, titel: g("title"), kategorie: entHtml(kat), datum: g("published").slice(0, 10) || g("updated").slice(0, 10), text: text.slice(0, 5000) });
  }
  return out;
}

const GAZETTE_KATEGORIE: Array<[RegExp, InsolvenzGegenstand]> = [
  [/winding-up order|appointment of (liquidator|administrator)|resolution.*winding|administration order|notice of.*administrat/i, "EROEFFNUNG"],
  [/petition/i, "SONSTIGES"],
  [/dividend|distribution/i, "VERTEILUNG"],
  [/final meeting|final account|dissolution|release of liquidator|notice of intended dividend/i, "AUFHEBUNG"],
  [/voluntary arrangement|moratorium/i, "INSOLVENZPLAN"],
];
export function kategorieGazette(titel: string, kategorie: string): InsolvenzGegenstand {
  const t = `${kategorie} ${titel}`;
  for (const [re, k] of GAZETTE_KATEGORIE) if (re.test(t)) return k;
  return "SONSTIGES";
}

export function meldungenAusGazette(eintraege: GazetteEintrag[], companyId: string): InsolvenzMeldung[] {
  return eintraege
    .filter((e) => /^\d{4}-\d{2}-\d{2}$/.test(e.datum))
    .map((e) => ({
      companyId,
      aktenzeichen: (e.id.split("/").pop() ?? e.id).slice(0, 60),
      insolvenzgericht: "The Gazette",
      datum: e.datum,
      gegenstand: kategorieGazette(e.titel, e.kategorie),
      text: `${e.kategorie || e.titel}. ${e.text}`.slice(0, 50_000),
      quelle: "gazette" as const,
    }));
}

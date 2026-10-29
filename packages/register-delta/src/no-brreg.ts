// Norwegen (docs/PLAN_SKANDINAVIEN.md §3): Enhetsregisteret der
// Brønnøysundregistrene, offene REST-API ohne Schluessel.
//
//   * Gesamtdownload: GET /enheter/lastned (gzip, JSON-Array, ~1,1 Mio.
//     Einheiten, pretty-printed) — als Stream gelesen, nie ganz im Speicher.
//   * Aenderungsfeed: GET /oppdateringer/enheter?dato=…&page=&size= liefert
//     Orgnr und Aenderungsart (Ny, Endring, Sletting, Ukjent); das Detail
//     kommt je Orgnr ueber GET /enheter/{orgnr}.
//   * Rollen: GET /enheter/{orgnr}/roller (Daglig leder, Styreleder,
//     Innehaver …) → Geschaeftsfuehrung fuer den strukturierten Inhalt.
//
// Keine amtliche Taktgrenze dokumentiert; 2 Abfragen je Sekunde sind hoeflich.

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { Readable } from "node:stream";
import { pipeline } from "node:stream/promises";
import zlib from "node:zlib";

export const NO_API = "https://data.brreg.no/enhetsregisteret/api";
export const NO_ABFRAGEN_JE_STUNDE = 7200;
const UA = "AVA-Register-Delta (Kontakt: joyce@quikk.de)";
const ACCEPT_GZ = "application/vnd.brreg.enhetsregisteret.enhet.v2+gzip;charset=UTF-8";

/** Fylke (seit 2024) aus den ersten zwei Stellen der Kommunenummer. */
export const NO_FYLKER: Record<string, string> = {
  "03": "Oslo", "11": "Rogaland", "15": "Møre og Romsdal", "18": "Nordland", "31": "Østfold", "32": "Akershus",
  "33": "Buskerud", "34": "Innlandet", "39": "Vestfold", "40": "Telemark", "42": "Agder", "46": "Vestland",
  "50": "Trøndelag", "55": "Troms", "56": "Finnmark", "21": "Svalbard", "22": "Jan Mayen",
};

/** Rollen, die als Geschaeftsfuehrung in den strukturierten Inhalt gehen. */
const GF_ROLLEN = new Set(["DAGL", "LEDE", "INNH", "KONT", "DTPR", "DTSO"]);

export type TrefferNo = {
  orgnr: string;
  name: string;
  /** Ort des Geschaeftssitzes (poststed), lesbar geschrieben. */
  sitz: string;
  kommune: string;
  fylke: string;
  /** Organisationsform-Kuerzel (AS, ASA, ENK, NUF …) und Langform. */
  legalForm: string;
  legalFormLang: string;
  status: "ACTIVE" | "CLOSED" | "LOESCHUNG_ANGEKUENDIGT";
  insolvenz: "NONE" | "VERDACHT" | "EROEFFNET";
  street?: string | null;
  zipCode?: string | null;
  mva: boolean;
  nace?: string | null;
  gegruendet?: string | null;
  fruehereNamen?: string[];
  si?: {
    legalForm: string;
    street: string;
    houseNumber: string;
    zipCode: string;
    city: string;
    foundingYear: number | null;
    corporatePurpose: string | null;
    shareCapital: number | null;
    capitalCurrency: string | null;
    lastRegisterEntry: string | null;
    managingDirectors: Array<{ firstName: string; lastName: string; birthDay: string | null; rolle: string }>;
  };
};

export type BrregAdresse = { adresse?: string[]; postnummer?: string; poststed?: string; kommune?: string; kommunenummer?: string; landkode?: string };
export type BrregEnhet = {
  organisasjonsnummer: string;
  navn?: string;
  organisasjonsform?: { kode?: string; beskrivelse?: string };
  forretningsadresse?: BrregAdresse;
  postadresse?: BrregAdresse;
  historiskeNavn?: Array<{ navn?: string }>;
  registreringsdatoEnhetsregisteret?: string;
  stiftelsesdato?: string;
  naeringskode1?: { kode?: string };
  registrertIMvaregisteret?: boolean;
  konkurs?: boolean;
  underAvvikling?: boolean;
  underTvangsavviklingEllerTvangsopplosning?: boolean;
  slettedato?: string;
  vedtektsfestetFormaal?: string[];
  kapital?: { belop?: number; type?: string };
  vedtektsdato?: string;
};
export type BrregRolle = { type?: { kode?: string; beskrivelse?: string }; person?: { navn?: { fornavn?: string; etternavn?: string; mellomnavn?: string }; fodselsdato?: string; erDoed?: boolean }; enhet?: { navn?: string[] }; fratraadt?: boolean; avregistrert?: boolean };
export type BrregOppdatering = { organisasjonsnummer: string; endringstype?: "Ny" | "Endring" | "Sletting" | "Ukjent" | string; dato?: string; oppdateringsid?: number };

export function orgnrNormal(v: string | null | undefined): string | null {
  const z = (v ?? "").replace(/\D/g, "");
  return /^\d{9}$/.test(z) ? z : null;
}
/** 916627939 → "916 627 939" (amtliche Schreibweise). */
export function orgnrFormatiert(orgnr: string): string {
  return `${orgnr.slice(0, 3)} ${orgnr.slice(3, 6)} ${orgnr.slice(6, 9)}`;
}
export function companyIdNo(orgnr: string): string {
  const z = orgnrNormal(orgnr);
  if (!z) throw new Error(`ungueltige Organisationsnummer: ${orgnr}`);
  return `NO_${z}`;
}
export function orgnrAusCompanyIdNo(companyId: string): string | null {
  const m = /^NO_(\d{9})$/.exec(companyId);
  return m ? m[1]! : null;
}

/** "SANDNES" → "Sandnes", "MØRE OG ROMSDAL" bleibt pro Wort gross am Anfang. */
export function ortLesbar(v: string | null | undefined): string {
  const s = (v ?? "").trim();
  if (!s) return "";
  if (s !== s.toUpperCase()) return s;
  return s.toLowerCase().replace(/(^|[\s\-/.])([a-zæøå])/g, (_, p: string, c: string) => p + c.toUpperCase()).replace(/\b(Og|I|Av|På)\b/g, (w) => w.toLowerCase());
}

function kappe(s: string | null | undefined, n: number): string {
  return (s ?? "").replace(/\s+/g, " ").trim().slice(0, n);
}

/** Strasse und Hausnummer aus "Strandgaten 208" / "Postboks 32". */
function strasseTeilen(zeilen: string[] | undefined): { street: string; houseNumber: string } {
  const z = (zeilen ?? []).map((x) => x.trim()).filter(Boolean);
  const erste = z.find((x) => !/^postboks\b/i.test(x)) ?? z[0] ?? "";
  const m = /^(.*?)[\s,]+(\d+[a-zA-Z]?(?:[\s/-]\d+[a-zA-Z]?)?)$/.exec(erste);
  return m ? { street: m[1]!.trim(), houseNumber: m[2]!.trim() } : { street: erste, houseNumber: "" };
}

/** Einheit → Treffer; null ohne Orgnr/Name. Rollen optional (no_refresh). */
export function enhetZuTreffer(e: BrregEnhet, rollen: BrregRolle[] | null = null): TrefferNo | null {
  const orgnr = orgnrNormal(e.organisasjonsnummer);
  const name = kappe(e.navn, 500);
  if (!orgnr || !name) return null;
  const adr = e.forretningsadresse?.poststed ? e.forretningsadresse : (e.postadresse ?? e.forretningsadresse ?? {});
  const kommunenummer = (adr.kommunenummer ?? "").padStart(4, "0");
  const fylke = NO_FYLKER[kommunenummer.slice(0, 2)] ?? "";
  const geloescht = Boolean(e.slettedato);
  const abwicklung = e.underAvvikling === true || e.underTvangsavviklingEllerTvangsopplosning === true;
  const { street, houseNumber } = strasseTeilen(adr.adresse);
  const altNamen = (e.historiskeNavn ?? []).map((h) => kappe(h?.navn, 500)).filter((n) => n && n !== name);
  const gf: NonNullable<TrefferNo["si"]>["managingDirectors"] = [];
  for (const r of rollen ?? []) {
    const kode = r.type?.kode ?? "";
    if (!GF_ROLLEN.has(kode) || r.fratraadt || r.avregistrert || r.person?.erDoed) continue;
    const vor = kappe([r.person?.navn?.fornavn, r.person?.navn?.mellomnavn].filter(Boolean).join(" "), 120);
    const nach = kappe(r.person?.navn?.etternavn, 120);
    if (!nach) continue;
    gf.push({ firstName: vor, lastName: nach, birthDay: r.person?.fodselsdato ?? null, rolle: r.type?.beskrivelse ?? kode });
  }
  const t: TrefferNo = {
    orgnr,
    name,
    sitz: kappe(ortLesbar(adr.poststed), 200),
    kommune: kappe(ortLesbar(adr.kommune), 120),
    fylke,
    legalForm: kappe(e.organisasjonsform?.kode, 20),
    legalFormLang: kappe(e.organisasjonsform?.beskrivelse, 200),
    status: geloescht ? "CLOSED" : abwicklung ? "LOESCHUNG_ANGEKUENDIGT" : "ACTIVE",
    insolvenz: e.konkurs === true ? "EROEFFNET" : "NONE",
    street: kappe([street, houseNumber].filter(Boolean).join(" "), 200) || null,
    zipCode: kappe(adr.postnummer, 20) || null,
    mva: e.registrertIMvaregisteret === true,
    nace: e.naeringskode1?.kode ?? null,
    gegruendet: e.stiftelsesdato ?? e.registreringsdatoEnhetsregisteret ?? null,
    fruehereNamen: altNamen.slice(0, 10),
  };
  if (rollen) {
    t.si = {
      legalForm: t.legalFormLang || t.legalForm,
      street: kappe(street, 200),
      houseNumber: kappe(houseNumber, 40),
      zipCode: kappe(adr.postnummer, 20),
      city: kappe(ortLesbar(adr.poststed), 120),
      foundingYear: t.gegruendet ? Number(t.gegruendet.slice(0, 4)) : null,
      corporatePurpose: e.vedtektsfestetFormaal?.length ? kappe(e.vedtektsfestetFormaal.join(" "), 20_000) : null,
      shareCapital: typeof e.kapital?.belop === "number" ? e.kapital.belop : null,
      capitalCurrency: typeof e.kapital?.belop === "number" ? "NOK" : null,
      lastRegisterEntry: e.vedtektsdato ?? null,
      managingDirectors: gf,
    };
  }
  return t;
}

export type BrregOptionen = { fetchImpl?: typeof fetch; log?: (zeile: string) => void; tmpDir?: string };

export class BrregClient {
  private readonly f: typeof fetch;
  constructor(private readonly o: BrregOptionen = {}) {
    this.f = o.fetchImpl ?? fetch;
  }

  private async get<T>(pfad: string): Promise<{ status: number; json: T | null }> {
    const res = await this.f(`${NO_API}${pfad}`, { headers: { "user-agent": UA, accept: "application/json" } });
    if (!res.ok) return { status: res.status, json: null };
    return { status: res.status, json: (await res.json()) as T };
  }

  /** Einheit; null = unbekannt (404, auch geloescht ohne Abdruck). gesperrt bei 429/403. */
  async enhet(orgnr: string): Promise<{ enhet: BrregEnhet | null; gesperrt: boolean }> {
    const z = orgnrNormal(orgnr);
    if (!z) return { enhet: null, gesperrt: false };
    const r = await this.get<BrregEnhet>(`/enheter/${z}`);
    if (r.status === 429 || r.status === 403) return { enhet: null, gesperrt: true };
    if (r.status === 410) return { enhet: { organisasjonsnummer: z, navn: "", slettedato: "unbekannt" }, gesperrt: false };
    return { enhet: r.json, gesperrt: false };
  }

  /** Rollen einer Einheit (leer bei 404). */
  async roller(orgnr: string): Promise<{ rollen: BrregRolle[]; gesperrt: boolean }> {
    const z = orgnrNormal(orgnr);
    if (!z) return { rollen: [], gesperrt: false };
    const r = await this.get<{ rollegrupper?: Array<{ roller?: BrregRolle[] }> }>(`/enheter/${z}/roller`);
    if (r.status === 429 || r.status === 403) return { rollen: [], gesperrt: true };
    return { rollen: (r.json?.rollegrupper ?? []).flatMap((g) => g.roller ?? []), gesperrt: false };
  }

  /**
   * Aenderungen ab einem Zeitpunkt (ISO), alle Seiten. Rueckgabe je Orgnr die
   * letzte Aenderungsart. `bis` grenzt auf einen Tag ab (dato < bis).
   */
  async oppdateringer(ab: string, bis: string | null, onSeite?: () => Promise<void>): Promise<{ aenderungen: Map<string, string>; gesperrt: boolean; abfragen: number }> {
    const out = new Map<string, string>();
    let abfragen = 0;
    for (let page = 0; page < 500; page++) {
      if (onSeite) await onSeite();
      const r = await this.get<{ _embedded?: { oppdaterteEnheter?: BrregOppdatering[] }; page?: { totalPages?: number } }>(`/oppdateringer/enheter?dato=${encodeURIComponent(ab)}&size=1000&page=${page}`);
      abfragen++;
      if (r.status === 429 || r.status === 403) return { aenderungen: out, gesperrt: true, abfragen };
      const liste = r.json?._embedded?.oppdaterteEnheter ?? [];
      for (const o of liste) {
        if (bis && o.dato && o.dato >= bis) continue;
        const z = orgnrNormal(o.organisasjonsnummer);
        if (z) out.set(z, o.endringstype ?? "Ukjent");
      }
      const seiten = r.json?.page?.totalPages ?? 0;
      if (liste.length === 0 || page + 1 >= seiten) break;
    }
    return { aenderungen: out, gesperrt: false, abfragen };
  }

  /**
   * Gesamtdownload auf Platte laden und als Stream Einheit fuer Einheit
   * liefern; die Datei wird danach geloescht. Rueckgabe: Zeilenzahl.
   */
  async lastned(zeile: (t: TrefferNo, index: number) => Promise<void> | void): Promise<number> {
    const datei = path.join(this.o.tmpDir ?? os.tmpdir(), `ava-no-${Date.now()}.json.gz`);
    try {
      const res = await this.f(`${NO_API}/enheter/lastned`, { headers: { "user-agent": UA, accept: ACCEPT_GZ } });
      if (!res.ok || !res.body) throw new Error(`brreg lastned ${res.status}`);
      await pipeline(Readable.fromWeb(res.body as never), fs.createWriteStream(datei));
      let n = 0;
      await jsonArrayStreamen(fs.createReadStream(datei).pipe(zlib.createGunzip()), async (obj) => {
        const t = enhetZuTreffer(obj as BrregEnhet);
        if (t) {
          await zeile(t, n);
          n++;
        }
      });
      return n;
    } finally {
      fs.rmSync(datei, { force: true });
    }
  }
}

/**
 * Ein JSON-Array von Objekten aus einem Stream lesen, ohne es ganz zu halten:
 * Klammertiefe und String-Zustand verfolgen, jedes Objekt der obersten Ebene
 * einzeln parsen.
 */
export async function jsonArrayStreamen(quelle: NodeJS.ReadableStream, onObjekt: (o: unknown) => Promise<void> | void): Promise<void> {
  let tiefe = 0;
  let inString = false;
  let escape = false;
  let puffer = "";
  let sammeln = false;
  for await (const chunk of quelle as AsyncIterable<Buffer | string>) {
    const text = typeof chunk === "string" ? chunk : chunk.toString("utf8");
    let start = 0;
    for (let i = 0; i < text.length; i++) {
      const c = text[i]!;
      if (inString) {
        if (escape) escape = false;
        else if (c === "\\") escape = true;
        else if (c === '"') inString = false;
        continue;
      }
      if (c === '"') inString = true;
      else if (c === "{") {
        if (tiefe === 1) {
          sammeln = true;
          start = i;
          puffer = "";
        }
        tiefe++;
      } else if (c === "}") {
        tiefe--;
        if (tiefe === 1 && sammeln) {
          puffer += text.slice(start, i + 1);
          sammeln = false;
          await onObjekt(JSON.parse(puffer));
          puffer = "";
        }
      } else if (c === "[" && tiefe === 0) tiefe = 1;
      else if (c === "]" && tiefe === 1) tiefe = 0;
    }
    if (sammeln) puffer += text.slice(start);
  }
}

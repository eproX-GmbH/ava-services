// Schweiz (docs/PLAN_SCHWEIZ.md): Zefix Public REST (Bundesamt fuer Justiz,
// Betreiber-Konto, HTTP Basic) fuer Firmendetail und SHAB-Tagesliste, LINDAS
// (Linked Data des Bundes, ohne Konto, SPARQL) fuer den Erstabzug aller aktiven
// Rechtseinheiten. Kein Browser, kein Portal-Takt; Zefix nennt keine Ratengrenze,
// wir fahren vorsichtig (ZEFIX_ABFRAGEN_JE_STUNDE).
//
// companyId = CH_ + UID ohne Trennzeichen (CH_CHE101602521), siehe Plan 2.3.
// Personen (Verwaltungsrat, Geschaeftsfuehrung) liefert Zefix nicht; die kommen
// spaeter aus dem kantonalen Auszug (cantonalExcerptWeb).

export const ZEFIX_API = "https://www.zefix.admin.ch/ZefixPublicREST/api/v1";
export const LINDAS_SPARQL = "https://lindas.admin.ch/query";
export const ZEFIX_ABFRAGEN_JE_STUNDE = 1800; // 0,5 je Sekunde, wie JustizOnline
export const LINDAS_SEITE = 5000;

const UA = "AVA-Recherche (Kontakt: joyce@quikk.de)";

/** eCH-0097 Rechtsformen (Zefix /legalForm, Stand 2026-10-24), Kuerzel deutsch. */
export const CH_RECHTSFORMEN: Record<string, { kurz: string; lang: string }> = {
  "0101": { kurz: "EIU", lang: "Einzelunternehmen" },
  "0103": { kurz: "KlG", lang: "Kollektivgesellschaft" },
  "0104": { kurz: "KmG", lang: "Kommanditgesellschaft" },
  "0105": { kurz: "KmAG", lang: "Kommanditaktiengesellschaft" },
  "0106": { kurz: "AG", lang: "Aktiengesellschaft" },
  "0107": { kurz: "GmbH", lang: "Gesellschaft mit beschränkter Haftung" },
  "0108": { kurz: "Gen", lang: "Genossenschaft" },
  "0109": { kurz: "Verein", lang: "Verein" },
  "0110": { kurz: "Stift", lang: "Stiftung" },
  "0111": { kurz: "ZNA", lang: "Zweigniederlassung ausländische Gesellschaft" },
  "0113": { kurz: "BES", lang: "Besondere Rechtsform" },
  "0114": { kurz: "KmGK", lang: "Kommanditgesellschaft für kollektive Kapitalanlagen" },
  "0115": { kurz: "SICAV", lang: "Investmentgesellschaft mit variablem Kapital" },
  "0116": { kurz: "SICAF", lang: "Investmentgesellschaft mit festem Kapital" },
  "0117": { kurz: "IOR", lang: "Institut des öffentlichen Rechts" },
  "0118": { kurz: "NKP", lang: "Nichtkaufmännische Prokura" },
  "0119": { kurz: "GEM", lang: "Gemeinde" },
  "0151": { kurz: "ZN", lang: "Zweigniederlassung" },
};

/** "CHE-101.602.521", "CHE101602521", "che 101 602 521" → "CHE101602521"; null wenn keine UID. */
export function uidNormal(uid: string | null | undefined): string | null {
  const z = (uid ?? "").toUpperCase().replace(/[^A-Z0-9]/g, "");
  return /^CHE\d{9}$/.test(z) ? z : null;
}

/** "CHE101602521" → "CHE-101.602.521" (amtliche Schreibweise). */
export function uidFormatiert(uid: string): string {
  const z = uidNormal(uid) ?? uid;
  return /^CHE\d{9}$/.test(z) ? `CHE-${z.slice(3, 6)}.${z.slice(6, 9)}.${z.slice(9, 12)}` : z;
}

export function companyIdCh(uid: string): string {
  const z = uidNormal(uid);
  if (!z) throw new Error(`ungueltige UID: ${uid}`);
  return `CH_${z}`;
}

export function uidAusCompanyIdCh(companyId: string): string | null {
  const m = /^CH_(CHE\d{9})$/.exec(companyId);
  return m ? m[1] : null;
}

export type TrefferCh = {
  /** CHE + 9 Ziffern. */
  uid: string;
  name: string;
  /** Sitzgemeinde (legalSeat). */
  sitz: string;
  /** Kanton-Kuerzel (BS, ZH …), leer wenn unbekannt. */
  kanton: string;
  /** Handelsregisteramt ("Handelsregisteramt des Kantons Basel-Stadt"), leer wenn unbekannt. */
  amt: string;
  /** Rechtsform-Kuerzel (AG, GmbH …), leer wenn unbekannt. */
  legalForm: string;
  legalFormCode: string;
  status: "ACTIVE" | "CLOSED" | "LOESCHUNG_ANGEKUENDIGT";
  insolvenz: "NONE" | "VERDACHT" | "EROEFFNET";
  street?: string | null;
  zipCode?: string | null;
  /** Letzte SHAB-Publikation (ISO-Datum). */
  sogcDate?: string | null;
  fruehereNamen?: string[];
  /** Strukturierter Inhalt aus dem Zefix-Detail (ch_refresh): Zweck, Kapital, Adresse. */
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
    cantonalExcerptWeb: string | null;
  };
};

// ---- Zefix-Antworten (Ausschnitt) ----------------------------------------------------

export type ZefixLegalForm = { id: number; uid: string; name?: Record<string, string>; shortName?: Record<string, string> };
export type ZefixCompanyShort = {
  name: string;
  uid: string;
  chid?: string;
  ehraid?: number;
  legalSeat?: string;
  registryOfCommerceId?: number;
  legalForm?: ZefixLegalForm;
  status?: string;
  sogcDate?: string | null;
  deletionDate?: string | null;
};
export type ZefixCompanyFull = ZefixCompanyShort & {
  purpose?: string | null;
  address?: { street?: string; houseNumber?: string; city?: string; swissZipCode?: string; poBox?: string } | null;
  canton?: string | null;
  capitalNominal?: string | null;
  capitalCurrency?: string | null;
  oldNames?: Array<{ name?: string } | string> | null;
  cantonalExcerptWeb?: string | null;
  sogcPub?: Array<{ sogcDate?: string; message?: string }> | null;
};
export type ZefixSogcEintrag = {
  sogcPublication: { sogcDate: string; sogcId: number; registryOfCommerceCanton?: string; message?: string; mutationTypes?: Array<{ id: number; key: string }> };
  companyShort?: ZefixCompanyShort;
};
export type ZefixAmt = { registryOfCommerceId: number; canton: string; address1?: string };

export type ZefixOptionen = { user: string; passwort: string; fetchImpl?: typeof fetch; log?: (zeile: string) => void };

export class ZefixClient {
  private readonly f: typeof fetch;
  private aemterCache: Map<number, ZefixAmt> | null = null;
  constructor(private readonly o: ZefixOptionen) {
    this.f = o.fetchImpl ?? fetch;
  }

  private kopf(): Record<string, string> {
    return { authorization: `Basic ${Buffer.from(`${this.o.user}:${this.o.passwort}`).toString("base64")}`, accept: "application/json", "user-agent": UA };
  }

  private async get<T>(pfad: string): Promise<{ status: number; json: T | null }> {
    const res = await this.f(`${ZEFIX_API}${pfad}`, { headers: this.kopf() });
    if (!res.ok) return { status: res.status, json: null };
    return { status: res.status, json: (await res.json()) as T };
  }

  /** Handelsregisteraemter (28), je registryOfCommerceId Kanton und Name; einmal je Prozess. */
  async aemter(): Promise<Map<number, ZefixAmt>> {
    if (this.aemterCache) return this.aemterCache;
    const r = await this.get<ZefixAmt[]>("/registryOfCommerce");
    if (r.status === 401) throw new Error("zefix: Konto abgelehnt (401)");
    this.aemterCache = new Map((r.json ?? []).map((a) => [a.registryOfCommerceId, a]));
    return this.aemterCache;
  }

  /** Firmendetail. null = unbekannt (404). gesperrt bei 401/403/429. */
  async firma(uid: string): Promise<{ firma: ZefixCompanyFull | null; gesperrt: boolean }> {
    const z = uidNormal(uid);
    if (!z) return { firma: null, gesperrt: false };
    const r = await this.get<ZefixCompanyFull[] | ZefixCompanyFull>(`/company/uid/${z}`);
    if (r.status === 401 || r.status === 403 || r.status === 429) return { firma: null, gesperrt: true };
    if (r.status === 404 || !r.json) return { firma: null, gesperrt: false };
    const f = Array.isArray(r.json) ? r.json[0] ?? null : r.json;
    return { firma: f, gesperrt: false };
  }

  /** Alle SHAB-Publikationen eines Tages (Neueintragungen, Mutationen, Loeschungen, Konkurse). */
  async sogcTag(datum: string): Promise<{ eintraege: ZefixSogcEintrag[]; gesperrt: boolean }> {
    if (!/^\d{4}-\d{2}-\d{2}$/.test(datum)) throw new Error(`ungueltiges Datum: ${datum}`);
    const r = await this.get<ZefixSogcEintrag[]>(`/sogc/bydate/${datum}`);
    if (r.status === 401 || r.status === 403 || r.status === 429) return { eintraege: [], gesperrt: true };
    return { eintraege: r.json ?? [], gesperrt: false };
  }

  /** Namenssuche (fuer Chat/Import ohne UID). */
  async suche(name: string, aktivNur = true): Promise<ZefixCompanyShort[]> {
    const res = await this.f(`${ZEFIX_API}/company/search`, {
      method: "POST",
      headers: { ...this.kopf(), "content-type": "application/json" },
      body: JSON.stringify({ name, activeOnly: aktivNur }),
    });
    if (!res.ok) return [];
    const j = (await res.json()) as ZefixCompanyShort[];
    return Array.isArray(j) ? j : [];
  }
}

// ---- Abbildung ----------------------------------------------------------------------

function kappe(s: string | null | undefined, n: number): string {
  return (s ?? "").replace(/\s+/g, " ").trim().slice(0, n);
}

function rechtsform(lf: ZefixLegalForm | undefined | null): { kurz: string; code: string } {
  const code = lf?.uid ?? "";
  const kurz = lf?.shortName?.de ?? CH_RECHTSFORMEN[code]?.kurz ?? "";
  return { kurz, code };
}

function amtVon(aemter: Map<number, ZefixAmt> | null, id: number | undefined, kantonFallback?: string | null): { kanton: string; amt: string } {
  const a = id != null ? aemter?.get(id) : undefined;
  return { kanton: a?.canton ?? kantonFallback ?? "", amt: a?.address1 ?? "" };
}

/** Zefix-Detail → Treffer mit strukturiertem Inhalt (ch_refresh). */
export function companyFullZuTreffer(c: ZefixCompanyFull, aemter: Map<number, ZefixAmt> | null): TrefferCh | null {
  const uid = uidNormal(c.uid);
  if (!uid || !c.name) return null;
  const rf = rechtsform(c.legalForm);
  const { kanton, amt } = amtVon(aemter, c.registryOfCommerceId, c.canton);
  const geloescht = c.status === "CANCELLED" || Boolean(c.deletionDate);
  const inLiquidation = /\bin Liquidation\b|\ben liquidation\b|\bin liquidazione\b/i.test(c.name);
  const adr = c.address ?? {};
  const kapital = c.capitalNominal != null && c.capitalNominal !== "" ? Number(String(c.capitalNominal).replace(/[^0-9.]/g, "")) : NaN;
  const altNamen = (c.oldNames ?? []).map((n) => (typeof n === "string" ? n : n?.name ?? "")).filter(Boolean);
  const erstePub = (c.sogcPub ?? []).map((p) => p.sogcDate ?? "").filter(Boolean).sort()[0] ?? null;
  return {
    uid,
    name: kappe(c.name, 500),
    sitz: kappe(c.legalSeat, 200),
    kanton,
    amt: kappe(amt, 200),
    legalForm: rf.kurz,
    legalFormCode: rf.code,
    status: geloescht ? "CLOSED" : inLiquidation ? "LOESCHUNG_ANGEKUENDIGT" : "ACTIVE",
    insolvenz: "NONE",
    street: kappe([adr.street, adr.houseNumber].filter(Boolean).join(" "), 200) || null,
    zipCode: kappe(adr.swissZipCode, 20) || null,
    sogcDate: c.sogcDate ?? null,
    fruehereNamen: altNamen.slice(0, 10),
    si: {
      legalForm: CH_RECHTSFORMEN[rf.code]?.lang ?? rf.kurz,
      street: kappe(adr.street, 200),
      houseNumber: kappe(adr.houseNumber, 40),
      zipCode: kappe(adr.swissZipCode, 20),
      city: kappe(adr.city, 120) || kappe(c.legalSeat, 120),
      foundingYear: erstePub ? Number(erstePub.slice(0, 4)) : null,
      corporatePurpose: c.purpose ? kappe(c.purpose, 20_000) : null,
      shareCapital: Number.isFinite(kapital) ? kapital : null,
      capitalCurrency: c.capitalCurrency ?? null,
      lastRegisterEntry: c.sogcDate ?? null,
      cantonalExcerptWeb: c.cantonalExcerptWeb ?? null,
    },
  };
}

/** SHAB-Eintrag → Treffer (ch_sogc). Loeschung → CLOSED, Konkurs → EROEFFNET, Liquidation → Loeschung angekuendigt. */
export function sogcZuTreffer(e: ZefixSogcEintrag, aemter: Map<number, ZefixAmt> | null): TrefferCh | null {
  const c = e.companyShort;
  const uid = uidNormal(c?.uid ?? uidAusText(e.sogcPublication.message ?? ""));
  if (!uid) return null;
  const name = c?.name ?? nameAusText(e.sogcPublication.message ?? "");
  if (!name) return null;
  const arten = new Set((e.sogcPublication.mutationTypes ?? []).map((m) => m.key));
  const rf = rechtsform(c?.legalForm);
  const { kanton, amt } = amtVon(aemter, c?.registryOfCommerceId, e.sogcPublication.registryOfCommerceCanton);
  const geloescht = arten.has("status.loeschung") || c?.status === "CANCELLED";
  const konkurs = arten.has("status.aufl.konk");
  const liquidation = arten.has("status.aufl") || arten.has("status.aufl.liq") || /\bin Liquidation\b/i.test(name);
  const widerrufen = arten.has("status.wiederrufliq");
  return {
    uid,
    name: kappe(name, 500),
    sitz: kappe(c?.legalSeat ?? sitzAusText(e.sogcPublication.message ?? ""), 200),
    kanton,
    amt: kappe(amt, 200),
    legalForm: rf.kurz,
    legalFormCode: rf.code,
    status: geloescht ? "CLOSED" : (konkurs || liquidation) && !widerrufen ? "LOESCHUNG_ANGEKUENDIGT" : "ACTIVE",
    insolvenz: konkurs ? "EROEFFNET" : "NONE",
    sogcDate: e.sogcPublication.sogcDate ?? null,
  };
}

function uidAusText(t: string): string | null {
  const m = /<FT TYPE="A">\s*([^<]+?)\s*<\/FT>/.exec(t);
  return m ? m[1] : null;
}
function nameAusText(t: string): string | null {
  const m = /<FT TYPE="F">\s*([^<]+?)\s*<\/FT>/.exec(t);
  return m ? m[1] : null;
}
function sitzAusText(t: string): string {
  const m = /<FT TYPE="S">\s*([^<]+?)\s*<\/FT>/.exec(t);
  return m ? m[1] : "";
}

// ---- LINDAS: Erstabzug -------------------------------------------------------------

export type LindasOptionen = { fetchImpl?: typeof fetch; log?: (zeile: string) => void };

export class LindasClient {
  private readonly f: typeof fetch;
  constructor(private readonly o: LindasOptionen = {}) {
    this.f = o.fetchImpl ?? fetch;
  }

  private async sparql(query: string): Promise<Array<Record<string, string>>> {
    const res = await this.f(LINDAS_SPARQL, {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded", accept: "application/sparql-results+json", "user-agent": UA },
      body: new URLSearchParams({ query }).toString(),
    });
    if (!res.ok) throw new Error(`lindas ${res.status}`);
    const j = (await res.json()) as { results: { bindings: Array<Record<string, { value: string }>> } };
    return j.results.bindings.map((b) => Object.fromEntries(Object.entries(b).map(([k, v]) => [k, v.value])));
  }

  async anzahl(): Promise<number> {
    const r = await this.sparql(`SELECT (COUNT(*) AS ?n) FROM <https://lindas.admin.ch/foj/zefix> WHERE { ?s a <https://schema.ld.admin.ch/ZefixOrganisation> }`);
    return Number(r[0]?.n ?? 0);
  }

  /** Eine Seite aktiver Rechtseinheiten, stabil nach Firmen-IRI sortiert. */
  async seite(offset: number, limit = LINDAS_SEITE): Promise<TrefferCh[]> {
    const q = `PREFIX schema: <http://schema.org/>
SELECT ?s ?name ?uid ?type ?street ?plz ?ort ?kanton FROM <https://lindas.admin.ch/foj/zefix> WHERE {
  { SELECT ?s WHERE { ?s a <https://schema.ld.admin.ch/ZefixOrganisation> } ORDER BY ?s LIMIT ${limit} OFFSET ${offset} }
  ?s schema:legalName ?name ; schema:identifier ?uid .
  FILTER(CONTAINS(STR(?uid), "/UID/"))
  OPTIONAL { ?s schema:additionalType ?type }
  OPTIONAL { ?s schema:address ?a . OPTIONAL { ?a schema:streetAddress ?street } OPTIONAL { ?a schema:postalCode ?plz } OPTIONAL { ?a schema:addressLocality ?ort } OPTIONAL { ?a schema:addressRegion ?kanton } }
}`;
    const rows = await this.sparql(q);
    const out: TrefferCh[] = [];
    const gesehen = new Set<string>();
    for (const r of rows) {
      const uid = uidNormal(r.uid.split("/").pop() ?? "");
      if (!uid || gesehen.has(uid)) continue;
      gesehen.add(uid);
      const code = (r.type ?? "").split("/").pop() ?? "";
      out.push({
        uid,
        name: kappe(r.name, 500),
        sitz: kappe(r.ort, 200),
        kanton: kappe(r.kanton, 10),
        amt: "",
        legalForm: CH_RECHTSFORMEN[code]?.kurz ?? "",
        legalFormCode: code,
        status: "ACTIVE",
        insolvenz: "NONE",
        street: kappe(r.street, 200) || null,
        zipCode: kappe(r.plz, 20) || null,
      });
    }
    return out;
  }
}

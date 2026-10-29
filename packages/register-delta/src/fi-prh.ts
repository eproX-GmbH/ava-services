// Finnland (docs/PLAN_SKANDINAVIEN.md §4): Handelsregister (YTJ/Kaupparekisteri)
// ueber die offene PRH-Schnittstelle Open Data v3, ohne Schluessel.
//
//   * Kein Gesamtdownload: der Erstabzug laeuft ueber Abfragen nach
//     Registrierungsdatum in Zeitscheiben (registrationDateStart/End), je
//     Seite 100 Firmen, Seiten unbegrenzt (1990 = 269 Seiten, geprueft).
//   * Kein Aenderungsfeed: neue Firmen taeglich ueber das Registrierungsdatum,
//     Aenderungen an bekannten Firmen ueber den monatlichen Refresh je Pool-Firma
//     (GET /companies?businessId=…).
//   * Keine Personen in den offenen Daten; Rechtsform, Branche, Adresse, Status,
//     Website und Namenshistorie stehen im Datensatz (fi/sv/en).

export const FI_API = "https://avoindata.prh.fi/opendata-ytj-api/v3";
export const FI_ABFRAGEN_JE_STUNDE = 3600; // 1 je Sekunde, hoeflich
export const FI_SEITE = 100;
const UA = "AVA-Register-Delta (Kontakt: joyce@quikk.de)";

/** Kurzformen der finnischen Rechtsformen (aus der finnischen Beschreibung). */
const FI_KURZ: Array<[RegExp, string]> = [
  [/^julkinen osakeyhti/i, "OYJ"],
  [/^asunto-osakeyhti/i, "AS OY"],
  [/^osakeyhti/i, "OY"],
  [/^kommandiittiyhti/i, "KY"],
  [/^avoin yhti/i, "AY"],
  [/^yksityinen elinkeinonharjoittaja|^toiminimi/i, "TMI"],
  [/^osuuskunta/i, "OSK"],
  [/^sivuliike|^ulkomaisen/i, "SIV"],
  [/^säätiö/i, "SR"],
  [/^yhdistys|^aatteellinen/i, "RY"],
  [/^konkurssipes/i, "KP"],
  [/^kunta|^kuntayhtym/i, "KUNTA"],
];

export type TrefferFi = {
  /** Y-Tunnus mit Bindestrich, z. B. 0112038-9. */
  businessId: string;
  name: string;
  sitz: string;
  legalForm: string;
  legalFormLang: string;
  status: "ACTIVE" | "CLOSED" | "LOESCHUNG_ANGEKUENDIGT";
  insolvenz: "NONE" | "VERDACHT" | "EROEFFNET";
  street?: string | null;
  zipCode?: string | null;
  website?: string | null;
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
    lastRegisterEntry: string | null;
  };
};

type Beschreibung = { languageCode?: string; description?: string };
export type PrhCompany = {
  businessId?: { value?: string; registrationDate?: string };
  names?: Array<{ name?: string; type?: string; registrationDate?: string; endDate?: string | null }>;
  mainBusinessLine?: { type?: string; descriptions?: Beschreibung[] };
  website?: { url?: string };
  companyForms?: Array<{ type?: string; descriptions?: Beschreibung[]; registrationDate?: string; endDate?: string | null }>;
  companySituations?: Array<{ type?: string; descriptions?: Beschreibung[]; registrationDate?: string; endDate?: string | null }>;
  addresses?: Array<{ type?: number; street?: string; postCode?: string; buildingNumber?: string; entrance?: string; postOffices?: Array<{ city?: string; languageCode?: string }>; endDate?: string | null }>;
  tradeRegisterStatus?: string;
  status?: string;
  registrationDate?: string;
  endDate?: string | null;
  lastModified?: string;
};

function text(b: Beschreibung[] | undefined, sprache: "1" | "2" | "3"): string {
  return (b ?? []).find((x) => x.languageCode === sprache)?.description?.trim() ?? "";
}
function kappe(s: string | null | undefined, n: number): string {
  return (s ?? "").replace(/\s+/g, " ").trim().slice(0, n);
}
function ortLesbar(v: string): string {
  const s = v.trim();
  if (!s || s !== s.toUpperCase()) return s;
  return s.toLowerCase().replace(/(^|[\s\-/])([a-zäöå])/g, (_, p: string, c: string) => p + c.toUpperCase());
}

export function businessIdNormal(v: string | null | undefined): string | null {
  const m = /^(\d{7})-?(\d)$/.exec((v ?? "").trim());
  return m ? `${m[1]}-${m[2]}` : null;
}
/** 0112038-9 → FI_01120389. */
export function companyIdFi(businessId: string): string {
  const n = businessIdNormal(businessId);
  if (!n) throw new Error(`ungueltiger Y-Tunnus: ${businessId}`);
  return `FI_${n.replace("-", "")}`;
}
export function businessIdAusCompanyIdFi(companyId: string): string | null {
  const m = /^FI_(\d{7})(\d)$/.exec(companyId);
  return m ? `${m[1]}-${m[2]}` : null;
}

/** PRH-Datensatz → Treffer; null ohne Y-Tunnus oder Namen. */
export function companyZuTreffer(c: PrhCompany, mitSi = false): TrefferFi | null {
  const businessId = businessIdNormal(c.businessId?.value);
  if (!businessId) return null;
  const namen = (c.names ?? []).filter((n) => n.type === "1" && n.name);
  const aktuell = namen.find((n) => !n.endDate) ?? namen[0];
  const name = kappe(aktuell?.name, 500);
  if (!name) return null;
  const fruehere = namen.filter((n) => n !== aktuell).map((n) => kappe(n.name, 500)).filter((n) => n && n !== name);
  const form = (c.companyForms ?? []).find((f) => !f.endDate) ?? c.companyForms?.[0];
  const formFi = text(form?.descriptions, "1");
  const formEn = text(form?.descriptions, "3");
  const kurz = FI_KURZ.find(([re]) => re.test(formFi))?.[1] ?? (form?.type ? `F${form.type}` : "");
  const adr = (c.addresses ?? []).filter((a) => !a.endDate).sort((a, b) => (a.type ?? 9) - (b.type ?? 9))[0];
  const stadt = ortLesbar(adr?.postOffices?.find((p) => p.languageCode === "1")?.city ?? adr?.postOffices?.[0]?.city ?? "");
  const situationen = (c.companySituations ?? []).filter((s) => !s.endDate).map((s) => `${text(s.descriptions, "3")} ${s.type ?? ""}`.toLowerCase());
  const konkurs = situationen.some((s) => /bankrupt|konkurs/.test(s)) || /^konkurssipes/i.test(formFi);
  const liquidation = situationen.some((s) => /liquidat|selvitystila|dissolution/.test(s));
  const sanierung = situationen.some((s) => /restructur|reorgani|saneeraus/.test(s));
  const geschlossen = Boolean(c.endDate);
  const strasse = kappe(adr?.street, 200);
  const hausnr = kappe([adr?.buildingNumber, adr?.entrance].filter(Boolean).join(" "), 40);
  const t: TrefferFi = {
    businessId,
    name,
    sitz: kappe(stadt, 200),
    legalForm: kurz,
    legalFormLang: kappe(formEn || formFi, 200),
    status: geschlossen ? "CLOSED" : liquidation || konkurs ? "LOESCHUNG_ANGEKUENDIGT" : "ACTIVE",
    insolvenz: konkurs ? "EROEFFNET" : sanierung ? "VERDACHT" : "NONE",
    street: kappe([strasse, hausnr].filter(Boolean).join(" "), 200) || null,
    zipCode: kappe(adr?.postCode, 20) || null,
    website: kappe(c.website?.url, 300) || null,
    nace: c.mainBusinessLine?.type ?? null,
    gegruendet: c.registrationDate ?? c.businessId?.registrationDate ?? null,
    fruehereNamen: fruehere.slice(0, 10),
  };
  if (mitSi) {
    const branche = text(c.mainBusinessLine?.descriptions, "3") || text(c.mainBusinessLine?.descriptions, "1");
    t.si = {
      legalForm: t.legalFormLang || t.legalForm,
      street: strasse,
      houseNumber: hausnr,
      zipCode: kappe(adr?.postCode, 20),
      city: kappe(stadt, 120),
      foundingYear: t.gegruendet ? Number(t.gegruendet.slice(0, 4)) : null,
      corporatePurpose: branche ? `Hauptgeschäftszweig: ${branche}` : null,
      lastRegisterEntry: c.lastModified ? c.lastModified.slice(0, 10) : null,
    };
  }
  return t;
}

export type PrhOptionen = { fetchImpl?: typeof fetch; log?: (zeile: string) => void };

export class PrhClient {
  private readonly f: typeof fetch;
  constructor(private readonly o: PrhOptionen = {}) {
    this.f = o.fetchImpl ?? fetch;
  }

  private async get<T>(query: string): Promise<{ status: number; json: T | null }> {
    const res = await this.f(`${FI_API}/companies?${query}`, { headers: { "user-agent": UA, accept: "application/json" } });
    if (!res.ok) return { status: res.status, json: null };
    return { status: res.status, json: (await res.json()) as T };
  }

  /** Eine Firma; null = unbekannt. gesperrt bei 429/403. */
  async firma(businessId: string): Promise<{ firma: PrhCompany | null; gesperrt: boolean }> {
    const n = businessIdNormal(businessId);
    if (!n) return { firma: null, gesperrt: false };
    const r = await this.get<{ companies?: PrhCompany[] }>(`businessId=${encodeURIComponent(n)}`);
    if (r.status === 429 || r.status === 403) return { firma: null, gesperrt: true };
    return { firma: r.json?.companies?.[0] ?? null, gesperrt: false };
  }

  /** Eine Seite Firmen nach Registrierungsdatum (von/bis einschliesslich, JJJJ-MM-TT). */
  async seite(von: string, bis: string, page: number): Promise<{ firmen: PrhCompany[]; gesamt: number; gesperrt: boolean }> {
    const r = await this.get<{ companies?: PrhCompany[]; totalResults?: number }>(`registrationDateStart=${von}&registrationDateEnd=${bis}&page=${page}`);
    if (r.status === 429 || r.status === 403) return { firmen: [], gesamt: 0, gesperrt: true };
    return { firmen: r.json?.companies ?? [], gesamt: r.json?.totalResults ?? 0, gesperrt: false };
  }
}

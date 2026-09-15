// Register-Delta S3 (docs/PLAN_STAMMDATEN_DELTA.md, 3.4) — Job-Queue mit Lease.
//
// Drei Job-Arten:
//   front            je (Gericht, Art): ab maxNummer+1 hochzaehlen, bis
//                    maxFehltreffer Fehltreffer in Folge; Luecken merken.
//   bekanntmachungen je Tag: Registerbekanntmachungen des Tages parsen.
//   refresh          Buendel bis 25 Firmen: exakte Abfrage, Vergleich.
//
// Der Worker (S4) fragt das Portal ab und meldet das Ergebnis; das Gateway
// schreibt ueber master-data (/internal/companies/register-delta, Upsert mit
// Aenderungserkennung) und pflegt die Nummernfront (/internal/register-front).
// Lease 20 Minuten, Rueckfall in die Queue bei Ablauf, maximal 5 Versuche.

import { createHmac } from "node:crypto";
import type pg from "pg";
import { loadEnv } from "./env";
import { logger } from "./logger";
import { getGatewayPool } from "./producer-pools";
import { companyIdAus, idTeil, zusatzBestand } from "./register-ids";

export type JobArt = "front" | "bekanntmachungen" | "refresh" | "insolvenz" | "at_front" | "at_refresh" | "at_insolvenz";
export const JOB_ARTEN: JobArt[] = ["front", "bekanntmachungen", "refresh", "insolvenz", "at_front", "at_refresh", "at_insolvenz"];
/**
 * Oesterreich, Weg 1 (docs/PLAN_OESTERREICH.md): JustizOnline-JSON und
 * Ediktsdatei, kein Browser. at_front = Aufzaehlung je (Gericht, Begriff
 * <Ziffer><Buchstabe>) monatlich; at_refresh = Detail je FN der Pool-Firmen;
 * at_insolvenz = Ediktsdatei je FN der Pool-Firmen.
 */
export const JOB_ARTEN_AT: JobArt[] = ["at_front", "at_refresh", "at_insolvenz"];
/** Worker ohne ausdruecklich gemeldete Arten (Stand vor I3) bekommen nur Register-Jobs. */
export const JOB_ARTEN_REGISTER: JobArt[] = ["front", "bekanntmachungen", "refresh"];

export const LEASE_MINUTEN = 20;
export const MAX_VERSUCHE = 5;
/** Grenze der Nutzungsordnung des Registerportals je IP und Stunde. */
export const ABFRAGEN_JE_STUNDE = 60;
export const FRONT_MAX_FEHLTREFFER = 10;
export const BEKANNTMACHUNGEN_FENSTER_TAGE = 56;
export const REFRESH_BUENDEL = 15; // passt mit 60/h in eine 20-Minuten-Lease (Worker: MAX_ABFRAGEN_JE_JOB 15)
export const REFRESH_INTERVALL_TAGE = 90;
/** Insolvenz-Delta (docs/PLAN_INSOLVENZEN.md): Pool-Firmen alle 30 Tage, Buendel zu 15. */
export const INSOLVENZ_INTERVALL_TAGE = 30;
export const INSOLVENZ_BUENDEL = 15;
export const INSOLVENZ_POOL_MAX = 20_000;
/** Oesterreich: 0,5 Anfragen je Sekunde und IP (429 ab 3/s); Buendel passen mit 2 Anfragen je Firma in die Lease. */
export const AT_ABFRAGEN_JE_STUNDE = 1800;
export const AT_REFRESH_BUENDEL = 50;
export const AT_INSOLVENZ_BUENDEL = 30;
export const AT_GERICHTE: Record<string, { name: string; bundesland: string }> = {
  "007": { name: "Handelsgericht Wien", bundesland: "Wien" },
  "309": { name: "Landesgericht Eisenstadt", bundesland: "Burgenland" },
  "929": { name: "Landesgericht Feldkirch", bundesland: "Vorarlberg" },
  "638": { name: "Landesgericht für ZRS Graz", bundesland: "Steiermark" },
  "818": { name: "Landesgericht Innsbruck", bundesland: "Tirol" },
  "729": { name: "Landesgericht Klagenfurt", bundesland: "Kärnten" },
  "119": { name: "Landesgericht Korneuburg", bundesland: "Niederösterreich" },
  "129": { name: "Landesgericht Krems an der Donau", bundesland: "Niederösterreich" },
  "609": { name: "Landesgericht Leoben", bundesland: "Steiermark" },
  "458": { name: "Landesgericht Linz", bundesland: "Oberösterreich" },
  "469": { name: "Landesgericht Ried im Innkreis", bundesland: "Oberösterreich" },
  "569": { name: "Landesgericht Salzburg", bundesland: "Salzburg" },
  "499": { name: "Landesgericht Steyr", bundesland: "Oberösterreich" },
  "199": { name: "Landesgericht St. Pölten", bundesland: "Niederösterreich" },
  "519": { name: "Landesgericht Wels", bundesland: "Oberösterreich" },
  "239": { name: "Landesgericht Wiener Neustadt", bundesland: "Niederösterreich" },
};
/** 260 Suffix-Begriffe <Ziffer><Buchstabe>: vollstaendig per Konstruktion, da jede FN so endet. */
export const AT_BEGRIFFE: string[] = [];
for (const z of "0123456789") for (const b of "abcdefghijklmnopqrstuvwxyz") AT_BEGRIFFE.push(`${z}${b}`);

const AT_ID_RE = /^AT_FN([1-9][0-9]{0,5})([A-Z])$/;
export function companyIdAt(fnr: string): string {
  const m = /^(\d{1,6})([a-z])$/.exec(fnr.trim().toLowerCase().replace(/^fn\s*/, ""));
  if (!m) throw new JobFehler(400, `ungueltige Firmenbuchnummer: ${fnr}`);
  return `AT_FN${Number(m[1])}${m[2].toUpperCase()}`;
}
/** AT_FN588123M → 588123m; null fuer fremde Ids. */
export function fnrAusCompanyId(companyId: string): string | null {
  const m = AT_ID_RE.exec(companyId);
  return m ? `${m[1]}${m[2].toLowerCase()}` : null;
}

export type RegisterJob = {
  id: string;
  art: JobArt;
  schluessel: string;
  payload: Record<string, unknown>;
  status: "offen" | "laeuft" | "erledigt" | "fehlgeschlagen";
  prioritaet: number;
  leaseUntil: string | null;
  leasedBy: string | null;
  versuche: number;
};

/** Ergebniszeile des Workers = Eingabe fuer master-data upsertManyDelta. */
export type Treffer = {
  gericht: string;
  art: string;
  nummer: number;
  zusatz: string;
  frueher: string;
  frueherSuffix?: boolean;
  bundesland: string;
  name: string;
  sitz: string;
  status: "ACTIVE" | "CLOSED" | "LOESCHUNG_ANGEKUENDIGT";
  historie: Array<{ name: string; sitz: string; order: number }>;
};

export type Bekanntmachung = {
  datum: string;
  kategorie: string;
  bundesland: string | null;
  gericht: string | null;
  art: string | null;
  nummer: number | null;
  zusatz: string;
  frueher: string;
  firma: string;
  sitz: string;
};

/** Insolvenz-Delta: Veroeffentlichung des Insolvenzportals (DE) oder der Ediktsdatei (AT) zu einer Firma. */
export type InsolvenzMeldung = {
  companyId: string;
  aktenzeichen: string;
  insolvenzgericht: string;
  datum: string;
  gegenstand: string;
  text: string;
  quelle?: "insolvenzportal" | "ediktsdatei";
};

/** Oesterreich: Suchtreffer oder Detail aus JustizOnline. */
export type TrefferAt = {
  fnr: string;
  name: string;
  sitz: string;
  status: "ACTIVE" | "CLOSED";
  gericht: string;
  bundesland: string;
  legalForm?: string | null;
  uid?: string | null;
};

export type Ergebnis = {
  workerId: string;
  abfragen: number;
  gesperrt?: boolean;
  treffer: Treffer[];
  /** insolvenz: Meldungen plus alle geprueften Firmen (auch ohne Treffer). */
  insolvenz?: { meldungen: InsolvenzMeldung[]; geprueft: string[] };
  /** front: neuer Stand nach dem Lauf. */
  front?: { maxNummer: number; offeneLuecken: number[]; zusaetze?: string[] };
  /** bekanntmachungen: alle Eintraege des Tages. */
  bekanntmachungen?: Bekanntmachung[];
  /** at_front / at_refresh: Firmenbuch-Treffer. */
  trefferAt?: TrefferAt[];
  /** at_front: Stand der Aufzaehlung; nicht fertig → Fortsetzungsjob ab naechsteSeite. */
  atFront?: { begriff: string; naechsteSeite: number; fertig: boolean; gesamt: number };
};

type Q = { query: pg.Pool["query"] };

export class JobFehler extends Error {
  constructor(public readonly status: 404 | 409 | 400, message: string) {
    super(message);
  }
}

function rowToJob(r: Record<string, unknown>): RegisterJob {
  return {
    id: String(r.id),
    art: r.art as JobArt,
    schluessel: String(r.schluessel),
    payload: (r.payload as Record<string, unknown>) ?? {},
    status: r.status as RegisterJob["status"],
    prioritaet: Number(r.prioritaet),
    leaseUntil: r.leaseUntil ? new Date(r.leaseUntil as string).toISOString() : null,
    leasedBy: (r.leasedBy as string | null) ?? null,
    versuche: Number(r.versuche ?? 0),
  };
}

// ---- master-data (HMAC) ----------------------------------------------------

async function masterData<T>(method: "POST" | "PUT", path: string, body?: unknown): Promise<T> {
  const env = loadEnv();
  if (!env.INTERNAL_HMAC_SECRET) throw new Error("INTERNAL_HMAC_SECRET unset");
  const raw = JSON.stringify(body ?? {});
  const sig = createHmac("sha256", env.INTERNAL_HMAC_SECRET).update(raw, "utf8").digest("hex");
  const res = await fetch(`${env.UPSTREAM_MASTER_DATA_URL.replace(/\/$/, "")}${path}`, {
    method,
    headers: { "content-type": "application/json", "x-internal-signature": sig },
    body: raw,
  });
  if (!res.ok) throw new Error(`master-data ${method} ${path} → ${res.status}`);
  return (await res.json()) as T;
}

export type Front = {
  districtCourt: string;
  registerType: string;
  maxNummer: number;
  zusaetze: string[];
  offeneLuecken: number[];
  zuletztGeprueftAt: string | null;
};

export async function ladeFronten(): Promise<Front[]> {
  const r = await masterData<{ fronts: Front[] }>("POST", "/internal/register-front/list", {});
  return r.fronts;
}

let gerichteCache: { map: Map<string, string>; at: number } | null = null;

/** Gerichtsname der Portal-Kopfzeile → Schreibweise des Bestands (ueber die Fronten), sonst unveraendert. */
export async function gerichtBestand(name: string): Promise<string> {
  if (!gerichteCache || Date.now() - gerichteCache.at > 3_600_000) {
    try {
      const fronten = await ladeFronten();
      gerichteCache = { map: new Map(fronten.map((f) => [idTeil(f.districtCourt), f.districtCourt])), at: Date.now() };
    } catch {
      gerichteCache = gerichteCache ?? { map: new Map(), at: 0 };
    }
  }
  return gerichteCache.map.get(idTeil(name)) ?? name;
}

function nameNormalisiert(name: string): string {
  return name.toLowerCase().replace(/\s+/g, " ").trim();
}

function trefferZuDelta(t: Treffer) {
  const companyId = companyIdAus(t.gericht, t.art, t.nummer, t.zusatz, t.frueher, t.frueherSuffix === true);
  return {
    companyId,
    name: t.name,
    nameNormalized: nameNormalisiert(t.name),
    registerType: t.art,
    // Schreibweise des Bestands: Nummer und Zusatz ohne Leerzeichen ("4851FL").
    registerNumber: `${t.nummer}${zusatzBestand(t.gericht, t.zusatz)}`,
    location: t.sitz,
    districtCourt: t.gericht,
    state: t.bundesland,
    registerStatus: t.status,
    formerCourt: t.frueher || null,
    history: t.historie.map((h) => ({ name: h.name, nameNormalized: nameNormalisiert(h.name), location: h.sitz, order: h.order })),
  };
}

function trefferAtZuDelta(t: TrefferAt) {
  const fnr = t.fnr.trim().toLowerCase();
  return {
    companyId: companyIdAt(fnr),
    name: t.name,
    nameNormalized: nameNormalisiert(t.name),
    registerType: "FN",
    registerNumber: fnr,
    location: t.sitz,
    districtCourt: t.gericht,
    state: t.bundesland,
    registerStatus: t.status,
    formerCourt: null,
    country: "AT",
    // Suchtreffer ohne Detail: legalForm/uid weglassen, master-data behaelt den Bestand.
    ...(t.legalForm ? { legalForm: t.legalForm } : {}),
    ...(t.uid ? { uid: t.uid } : {}),
    history: [{ name: t.name, nameNormalized: nameNormalisiert(t.name), location: t.sitz, order: 1 }],
  };
}

type DeltaAntwort = { neu: number; geaendert: number; unveraendert: number; befunde: Array<{ companyId: string; befund: string; felder?: string[] }> };

async function schreibeTreffer(treffer: Treffer[], source: string): Promise<{ neu: number; geaendert: number; unveraendert: number; geaenderteIds: string[] }> {
  return schreibeDelta(treffer.map(trefferZuDelta), source);
}

async function schreibeTrefferAt(treffer: TrefferAt[], source: string): Promise<{ neu: number; geaendert: number; unveraendert: number; geaenderteIds: string[] }> {
  // Treffer mit unbrauchbarer FN (kommt bei der API nicht vor) still auslassen statt den Job zu verwerfen.
  const zeilen = [];
  for (const t of treffer) {
    try {
      zeilen.push(trefferAtZuDelta(t));
    } catch {
      /* ungueltige FN */
    }
  }
  return schreibeDelta(zeilen, source);
}

async function schreibeDelta(zeilen: Array<ReturnType<typeof trefferZuDelta> | ReturnType<typeof trefferAtZuDelta>>, source: string): Promise<{ neu: number; geaendert: number; unveraendert: number; geaenderteIds: string[] }> {
  const summe = { neu: 0, geaendert: 0, unveraendert: 0, geaenderteIds: [] as string[] };
  const gesehenAt = new Date().toISOString();
  for (let i = 0; i < zeilen.length; i += 1000) {
    const r = await masterData<DeltaAntwort>("POST", "/internal/companies/register-delta", {
      companies: zeilen.slice(i, i + 1000),
      source,
      gesehenAt,
    });
    summe.neu += r.neu;
    summe.geaendert += r.geaendert;
    summe.unveraendert += r.unveraendert;
    for (const b of r.befunde ?? []) if (b.befund === "geaendert") summe.geaenderteIds.push(b.companyId);
  }
  return summe;
}

/** S7 — strukturierte Inhalte als veraltet markieren (Producer erneuert beim naechsten Zugriff). */
export async function markiereVeraltet(q: Q, companyIds: string[], grund: string): Promise<number> {
  const ids = [...new Set(companyIds)].filter(Boolean);
  if (ids.length === 0) return 0;
  const r = await q.query(
    `INSERT INTO "StructuredContentStale" ("companyId", "seit", "grund")
       SELECT unnest($1::text[]), NOW(), $2
     ON CONFLICT ("companyId") DO UPDATE SET "seit" = NOW(), "grund" = EXCLUDED."grund"`,
    [ids, grund.slice(0, 120)],
  );
  return r.rowCount ?? 0;
}

// ---- Erzeugung ------------------------------------------------------------

async function legeJobAn(q: Q, art: JobArt, schluessel: string, payload: Record<string, unknown>, prioritaet: number): Promise<boolean> {
  const r = await q.query(
    `INSERT INTO "RegisterJob" ("art", "schluessel", "payload", "prioritaet")
     VALUES ($1, $2, $3::jsonb, $4) ON CONFLICT ("schluessel") DO NOTHING`,
    [art, schluessel, JSON.stringify(payload), prioritaet],
  );
  return (r.rowCount ?? 0) > 0;
}

function tagIso(d: Date): string {
  return d.toISOString().slice(0, 10);
}

/**
 * Ersteller (taeglich): Front-Jobs je (Gericht, Art), deren letzte Pruefung
 * aelter als ein Tag ist; Bekanntmachungs-Jobs fuer jeden Tag im Fenster
 * (idempotent, nachholbar nach Pausen bis 8 Wochen). Refresh-Jobs entstehen
 * aus Bekanntmachungen (siehe verarbeiteErgebnis) und aus expliziten
 * Anforderungen (refreshAnfordern).
 */
export async function erzeugeJobs(pool: pg.Pool, now: Date = new Date()): Promise<{ front: number; bekanntmachungen: number }> {
  let front = 0;
  let bek = 0;
  const heute = tagIso(now);
  try {
    const fronten = await ladeFronten();
    for (const f of fronten) {
      const geprueft = f.zuletztGeprueftAt ? new Date(f.zuletztGeprueftAt).getTime() : 0;
      if (now.getTime() - geprueft < 20 * 3600_000) continue;
      const ok = await legeJobAn(
        pool,
        "front",
        `front:${f.districtCourt}:${f.registerType}:${f.maxNummer}:${heute}`,
        {
          gericht: f.districtCourt,
          art: f.registerType,
          abNummer: f.maxNummer + 1,
          maxFehltreffer: FRONT_MAX_FEHLTREFFER,
          offeneLuecken: f.offeneLuecken,
          zusaetze: f.zusaetze,
        },
        // Grosse Gerichte zuerst: dort entstehen die meisten Firmen.
        f.maxNummer > 50_000 ? 3 : 4,
      );
      if (ok) front++;
    }
  } catch (err) {
    logger.warn({ err: err instanceof Error ? err.message : String(err) }, "[register-jobs] Fronten nicht ladbar");
  }
  // Bekanntmachungen: gestern bis Fensteranfang; heute erst morgen (Tag unvollstaendig).
  for (let i = 1; i <= BEKANNTMACHUNGEN_FENSTER_TAGE; i++) {
    const tag = tagIso(new Date(now.getTime() - i * 86_400_000));
    const ok = await legeJobAn(pool, "bekanntmachungen", `bek:${tag}`, { tag }, 1);
    if (ok) bek++;
  }
  return { front, bekanntmachungen: bek };
}

/** Refresh-Jobs fuer konkrete Blaetter (Buendel zu 25), z. B. aus Bekanntmachungen oder Nutzerbestand. */
export async function refreshAnfordern(
  q: Q,
  firmen: Array<{ gericht: string; art: string; nummer: number; zusatz?: string; hinweis?: string }>,
  grund: string,
  prioritaet = 2,
): Promise<number> {
  let n = 0;
  const gesehen = new Set<string>();
  const eindeutig = firmen.filter((f) => {
    const k = `${f.gericht}|${f.art}|${f.nummer}`;
    if (gesehen.has(k)) return false;
    gesehen.add(k);
    return true;
  });
  for (let i = 0; i < eindeutig.length; i += REFRESH_BUENDEL) {
    const buendel = eindeutig.slice(i, i + REFRESH_BUENDEL);
    const schluessel = `refresh:${grund}:${buendel.map((f) => companyIdAus(f.gericht, f.art, f.nummer)).join(",")}`.slice(0, 900);
    if (await legeJobAn(q, "refresh", schluessel, { firmen: buendel, grund }, prioritaet)) n++;
  }
  return n;
}

export type InsolvenzFirma = { companyId: string; gericht: string; art: string; nummer: string; zusatz?: string };

/** Insolvenz-Jobs fuer konkrete Firmen (Buendel zu 15). */
export async function insolvenzAnfordern(q: Q, firmen: InsolvenzFirma[], grund: string, prioritaet = 2): Promise<number> {
  let n = 0;
  const gesehen = new Set<string>();
  const eindeutig = firmen.filter((f) => {
    if (gesehen.has(f.companyId)) return false;
    gesehen.add(f.companyId);
    return true;
  });
  for (let i = 0; i < eindeutig.length; i += INSOLVENZ_BUENDEL) {
    const buendel = eindeutig.slice(i, i + INSOLVENZ_BUENDEL);
    const schluessel = `insolvenz:${grund}:${buendel.map((f) => f.companyId).join(",")}`.slice(0, 900);
    if (await legeJobAn(q, "insolvenz", schluessel, { firmen: buendel, grund }, prioritaet)) n++;
  }
  return n;
}

/** Registerdaten zu companyIds bei master-data holen; aelterAlsTage 0 = ohne Kadenz. */
export async function insolvenzFaellige(companyIds: string[], aelterAlsTage: number): Promise<InsolvenzFirma[]> {
  const out: InsolvenzFirma[] = [];
  for (let i = 0; i < companyIds.length; i += 5000) {
    const r = await masterData<{ firmen: Array<{ companyId: string; districtCourt: string; registerType: string; registerNumber: string }> }>(
      "POST",
      "/internal/companies/insolvency-due",
      { companyIds: companyIds.slice(i, i + 5000), aelterAlsTage },
    );
    for (const f of r.firmen ?? []) {
      const m = /^(\d+)\s?([A-ZÄÖÜ]{0,3})$/.exec(f.registerNumber.trim());
      if (!m) continue; // Muellnummern des Altbestands ("93141.0", "12345frueher...") nicht abfragen
      out.push({ companyId: f.companyId, gericht: f.districtCourt, art: f.registerType, nummer: m[1], zusatz: m[2] || undefined });
    }
  }
  return out;
}

/**
 * Pool fuer die Insolvenzpruefung: Firmen, mit denen Nutzer arbeiten
 * (Verarbeitung in EntityProgress). Kein Blick auf den Gesamtbestand
 * (Portal-Regel: nur Einzelabruf mit konkretem Bezug).
 */
export async function erzeugeInsolvenzJobs(pool: pg.Pool): Promise<number> {
  const r = await pool.query<{ companyId: string }>(
    `SELECT DISTINCT "companyId" FROM "EntityProgress" ORDER BY "companyId" LIMIT $1`,
    [INSOLVENZ_POOL_MAX],
  );
  const faellig = await insolvenzFaellige(r.rows.map((x) => x.companyId), INSOLVENZ_INTERVALL_TAGE);
  const heute = tagIso(new Date());
  return insolvenzAnfordern(pool, faellig, `pool-${heute}`, 2);
}

// ---- Oesterreich ------------------------------------------------------------

function monatIso(d: Date): string {
  return d.toISOString().slice(0, 7);
}

/** Pool-Firmen aus Oesterreich (Verarbeitung in EntityProgress) als (companyId, fnr). */
async function atPoolFirmen(pool: pg.Pool): Promise<Array<{ companyId: string; fnr: string }>> {
  const r = await pool.query<{ companyId: string }>(
    `SELECT DISTINCT "companyId" FROM "EntityProgress" WHERE "companyId" LIKE 'AT_FN%' ORDER BY "companyId" LIMIT $1`,
    [INSOLVENZ_POOL_MAX],
  );
  const out: Array<{ companyId: string; fnr: string }> = [];
  for (const row of r.rows) {
    const fnr = fnrAusCompanyId(row.companyId);
    if (fnr) out.push({ companyId: row.companyId, fnr });
  }
  return out;
}

/**
 * Monatlich: Aufzaehlung je (Gericht, Begriff) (16 × 260 Jobs, rund 43.000
 * Anfragen, ein Tag auf einer Maschine), Detail-Refresh und Ediktsdatei je
 * Pool-Firma. Schluessel tragen den Monat, Wiederholung damit idempotent.
 */
export async function erzeugeAtJobs(pool: pg.Pool, now: Date = new Date()): Promise<{ front: number; refresh: number; insolvenz: number }> {
  const monat = monatIso(now);
  let front = 0;
  for (const gerichtId of Object.keys(AT_GERICHTE)) {
    for (const begriff of AT_BEGRIFFE) {
      if (await legeJobAn(pool, "at_front", `at_front:${gerichtId}:${begriff}:${monat}`, { gerichtId, begriff, abSeite: 0, state: "ACTIVE" }, 5)) front++;
    }
  }
  const firmen = await atPoolFirmen(pool);
  let refresh = 0;
  for (let i = 0; i < firmen.length; i += AT_REFRESH_BUENDEL) {
    const b = firmen.slice(i, i + AT_REFRESH_BUENDEL);
    if (await legeJobAn(pool, "at_refresh", `at_refresh:pool-${monat}:${b.map((f) => f.companyId).join(",")}`.slice(0, 900), { firmen: b, grund: `pool-${monat}` }, 3)) refresh++;
  }
  let insolvenz = 0;
  for (let i = 0; i < firmen.length; i += AT_INSOLVENZ_BUENDEL) {
    const b = firmen.slice(i, i + AT_INSOLVENZ_BUENDEL);
    if (await legeJobAn(pool, "at_insolvenz", `at_insolvenz:pool-${monat}:${b.map((f) => f.companyId).join(",")}`.slice(0, 900), { firmen: b, grund: `pool-${monat}` }, 2)) insolvenz++;
  }
  return { front, refresh, insolvenz };
}

/** Oesterreich-Pruefung fuer konkrete Firmen (Chat, Import, Firmendetail): Refresh und Ediktsdatei sofort. */
export async function atAnfordern(q: Q, companyIds: string[], grund: string): Promise<{ jobs: number; firmen: number }> {
  const firmen: Array<{ companyId: string; fnr: string }> = [];
  const gesehen = new Set<string>();
  for (const id of companyIds) {
    const fnr = fnrAusCompanyId(id);
    if (!fnr || gesehen.has(id)) continue;
    gesehen.add(id);
    firmen.push({ companyId: id, fnr });
  }
  let jobs = 0;
  for (let i = 0; i < firmen.length; i += AT_INSOLVENZ_BUENDEL) {
    const b = firmen.slice(i, i + AT_INSOLVENZ_BUENDEL);
    const ids = b.map((f) => f.companyId).join(",");
    if (await legeJobAn(q, "at_refresh", `at_refresh:${grund}:${ids}`.slice(0, 900), { firmen: b, grund }, 1)) jobs++;
    if (await legeJobAn(q, "at_insolvenz", `at_insolvenz:${grund}:${ids}`.slice(0, 900), { firmen: b, grund }, 1)) jobs++;
  }
  return { jobs, firmen: firmen.length };
}

// ---- Lease / Ergebnis -------------------------------------------------------

/** Budget-Hinweis fuer den Worker je Portal. */
export function abfragenJeStundeFuer(art: JobArt): number {
  return art.startsWith("at_") ? AT_ABFRAGEN_JE_STUNDE : ABFRAGEN_JE_STUNDE;
}

export async function leaseJob(pool: pg.Pool, workerId: string, arten: JobArt[] = JOB_ARTEN): Promise<RegisterJob | null> {
  const r = await pool.query(
    `UPDATE "RegisterJob" SET "status" = 'laeuft', "leasedBy" = $1,
            "leaseUntil" = NOW() + ($2 || ' minutes')::interval, "versuche" = "versuche" + 1, "updatedAt" = NOW()
      WHERE "id" = (
        SELECT "id" FROM "RegisterJob"
         WHERE "art" = ANY($3::text[])
           AND ("status" = 'offen' OR ("status" = 'laeuft' AND "leaseUntil" < NOW()))
           AND "versuche" < $4
         ORDER BY "prioritaet", "id"
         FOR UPDATE SKIP LOCKED LIMIT 1)
      RETURNING *`,
    [workerId, String(LEASE_MINUTEN), arten, MAX_VERSUCHE],
  );
  // Abgelaufene Leases mit ausgeschoepften Versuchen endgueltig markieren.
  await pool.query(
    `UPDATE "RegisterJob" SET "status" = 'fehlgeschlagen', "fehler" = COALESCE("fehler", 'Lease abgelaufen'), "updatedAt" = NOW()
      WHERE "status" = 'laeuft' AND "leaseUntil" < NOW() AND "versuche" >= $1`,
    [MAX_VERSUCHE],
  );
  if (r.rowCount === 0) return null;
  return rowToJob(r.rows[0] as Record<string, unknown>);
}

async function ladeGeleastenJob(q: Q, jobId: string, workerId: string): Promise<RegisterJob> {
  const r = await q.query(`SELECT * FROM "RegisterJob" WHERE "id" = $1`, [jobId]);
  if (r.rowCount === 0) throw new JobFehler(404, "job_unbekannt");
  const job = rowToJob(r.rows[0] as Record<string, unknown>);
  if (job.status !== "laeuft" || job.leasedBy !== workerId) throw new JobFehler(409, "lease_nicht_gueltig");
  return job;
}

export async function verarbeiteErgebnis(pool: pg.Pool, jobId: string, ergebnis: Ergebnis): Promise<Record<string, unknown>> {
  // Idempotent: meldet derselbe Worker ein bereits verbuchtes Ergebnis erneut
  // (Antwort ging verloren), bekommt er die gespeicherte Zusammenfassung.
  const vorher = await pool.query<{ status: string; leasedBy: string | null; ergebnis: Record<string, unknown> | null }>(
    `SELECT "status", "leasedBy", "ergebnis" FROM "RegisterJob" WHERE "id" = $1`,
    [jobId],
  );
  const v = vorher.rows[0];
  if (v && v.status === "erledigt" && v.leasedBy === ergebnis.workerId) return { ...(v.ergebnis ?? {}), status: "erledigt", wiederholt: true };
  const job = await ladeGeleastenJob(pool, jobId, ergebnis.workerId);
  const zusammenfassung: Record<string, unknown> = { abfragen: ergebnis.abfragen, treffer: ergebnis.treffer.length };

  if (ergebnis.gesperrt) {
    // Portal hat gesperrt: Job zurueck in die Queue, Worker fuer eine Stunde merken.
    await pool.query(
      `UPDATE "RegisterJob" SET "status" = 'offen', "leasedBy" = NULL, "leaseUntil" = NULL, "fehler" = 'Portal gesperrt', "updatedAt" = NOW() WHERE "id" = $1`,
      [jobId],
    );
    await pool.query(`UPDATE "RegisterWorker" SET "gesperrtAt" = NOW(), "zuletztAt" = NOW(), "abfragen" = "abfragen" + $2 WHERE "workerId" = $1`, [
      ergebnis.workerId,
      ergebnis.abfragen,
    ]);
    return { ...zusammenfassung, status: "zurueckgestellt" };
  }

  if (ergebnis.treffer.length > 0) {
    const { geaenderteIds, ...summe } = await schreibeTreffer(ergebnis.treffer, job.art === "bekanntmachungen" ? "bekanntmachung" : "registerportal");
    Object.assign(zusammenfassung, summe);
    // S7: geaendertes Registerblatt → strukturierte Inhalte veraltet.
    if (geaenderteIds.length > 0) zusammenfassung.veraltet = await markiereVeraltet(pool, geaenderteIds, `register-${job.art}`);
    // Insolvenz-Delta: Loeschungsankuendigung → Insolvenzpruefung sofort (Loeschung folgt oft auf Insolvenz).
    const loeschung = ergebnis.treffer.filter((t) => t.status === "LOESCHUNG_ANGEKUENDIGT");
    if (loeschung.length > 0) {
      zusammenfassung.insolvenzJobs = await insolvenzAnfordern(
        pool,
        loeschung.map((t) => ({ companyId: companyIdAus(t.gericht, t.art, t.nummer, t.zusatz, t.frueher, t.frueherSuffix === true), gericht: t.gericht, art: t.art, nummer: String(t.nummer), zusatz: t.zusatz || undefined })),
        `loeschung-${tagIso(new Date())}`,
        1,
      );
    }
  }

  if (ergebnis.trefferAt && ergebnis.trefferAt.length > 0) {
    const { geaenderteIds, ...summe } = await schreibeTrefferAt(ergebnis.trefferAt, "justizonline");
    Object.assign(zusammenfassung, summe);
    if (geaenderteIds.length > 0) zusammenfassung.veraltet = await markiereVeraltet(pool, geaenderteIds, `register-${job.art}`);
  }

  if (job.art === "at_front" && ergebnis.atFront) {
    const p = job.payload as { gerichtId: string; begriff: string; state?: string };
    zusammenfassung.gesamt = ergebnis.atFront.gesamt;
    zusammenfassung.fertig = ergebnis.atFront.fertig;
    if (!ergebnis.atFront.fertig) {
      // Budget des Jobs erschoepft (grosse Gerichte): ab der naechsten Seite weiter.
      const basis = job.schluessel.replace(/:s\d+$/, "");
      await legeJobAn(pool, "at_front", `${basis}:s${ergebnis.atFront.naechsteSeite}`, { ...p, abSeite: ergebnis.atFront.naechsteSeite }, job.prioritaet);
      zusammenfassung.fortsetzung = ergebnis.atFront.naechsteSeite;
    }
  }

  if ((job.art === "insolvenz" || job.art === "at_insolvenz") && ergebnis.insolvenz) {
    // Nur die vom Worker tatsaechlich bearbeiteten Firmen gelten als geprueft;
    // der Rest bleibt faellig und kommt mit dem naechsten Cron.
    const geprueft = [...new Set(ergebnis.insolvenz.geprueft)];
    const r = await masterData<{ befunde: Array<{ companyId: string; neu: number; status: string }>; neu: number }>("POST", "/internal/companies/insolvency-events", {
      meldungen: ergebnis.insolvenz.meldungen,
      geprueft,
      gesehenAt: new Date().toISOString(),
    });
    zusammenfassung.meldungen = ergebnis.insolvenz.meldungen.length;
    zusammenfassung.geprueft = geprueft.length;
    zusammenfassung.neu = r.neu;
    zusammenfassung.mitVerfahren = (r.befunde ?? []).filter((b) => b.status !== "NONE" && b.status !== "unbekannt").length;
    // Neue Veroeffentlichung → Publikationen/strukturierte Inhalte koennen sich aendern.
    const neueIds = (r.befunde ?? []).filter((b) => b.neu > 0).map((b) => b.companyId);
    if (neueIds.length > 0) zusammenfassung.veraltet = await markiereVeraltet(pool, neueIds, "insolvenz");
  }

  if (job.art === "front" && ergebnis.front) {
    const p = job.payload as { gericht: string; art: string; zusaetze?: string[] };
    await masterData("PUT", "/internal/register-front", {
      fronts: [
        {
          districtCourt: p.gericht,
          registerType: p.art,
          maxNummer: ergebnis.front.maxNummer,
          zusaetze: ergebnis.front.zusaetze ?? p.zusaetze ?? [],
          offeneLuecken: ergebnis.front.offeneLuecken,
          zuletztGeprueftAt: new Date().toISOString(),
        },
      ],
    });
    zusammenfassung.maxNummer = ergebnis.front.maxNummer;
    // Front ist weitergewandert: sofort den naechsten Abschnitt einreihen (Aufholen).
    if (ergebnis.treffer.length > 0) {
      await legeJobAn(
        pool,
        "front",
        `front:${p.gericht}:${p.art}:${ergebnis.front.maxNummer}:${tagIso(new Date())}`,
        { gericht: p.gericht, art: p.art, abNummer: ergebnis.front.maxNummer + 1, maxFehltreffer: FRONT_MAX_FEHLTREFFER, offeneLuecken: ergebnis.front.offeneLuecken, zusaetze: ergebnis.front.zusaetze ?? p.zusaetze ?? [] },
        job.prioritaet,
      );
    }
  }

  if (job.art === "bekanntmachungen" && ergebnis.bekanntmachungen) {
    const p = job.payload as { tag: string };
    const mitBlatt = ergebnis.bekanntmachungen.filter((b) => b.gericht && b.art && b.nummer != null);
    for (const b of mitBlatt) b.gericht = await gerichtBestand(b.gericht as string);
    const n = await refreshAnfordern(
      pool,
      mitBlatt.map((b) => ({
        gericht: b.gericht as string,
        art: b.art as string,
        nummer: b.nummer as number,
        zusatz: b.zusatz,
        hinweis: /Löschung|Loeschung/.test(b.kategorie) ? "loeschung_angekuendigt" : b.kategorie,
      })),
      `bek-${p.tag}`,
    );
    zusammenfassung.bekanntmachungen = ergebnis.bekanntmachungen.length;
    zusammenfassung.refreshJobs = n;
    // S7: Umwandlung, neue Dokumente, Sonstiges → strukturierte Inhalte veraltet (Loeschung kommt ueber den Refresh).
    const dokumente = mitBlatt.filter((b) => !/Löschung|Loeschung/.test(b.kategorie));
    zusammenfassung.veraltet = await markiereVeraltet(
      pool,
      dokumente.map((b) => companyIdAus(b.gericht as string, b.art as string, b.nummer as number, b.zusatz, b.frueher)),
      `bekanntmachung-${p.tag}`,
    );
  }

  await pool.query(
    `UPDATE "RegisterJob" SET "status" = 'erledigt', "ergebnis" = $2::jsonb, "ergebnisAt" = NOW(), "leaseUntil" = NULL, "fehler" = NULL, "updatedAt" = NOW() WHERE "id" = $1`,
    [jobId, JSON.stringify(zusammenfassung)],
  );
  await pool.query(
    `UPDATE "RegisterWorker" SET "zuletztAt" = NOW(), "jobsErledigt" = "jobsErledigt" + 1, "abfragen" = "abfragen" + $2 WHERE "workerId" = $1`,
    [ergebnis.workerId, ergebnis.abfragen],
  );
  return { ...zusammenfassung, status: "erledigt" };
}

export async function meldeFehler(pool: pg.Pool, jobId: string, workerId: string, grund: string, abfragen = 0): Promise<{ status: string }> {
  const job = await ladeGeleastenJob(pool, jobId, workerId);
  const endgueltig = job.versuche >= MAX_VERSUCHE;
  await pool.query(
    `UPDATE "RegisterJob" SET "status" = $2, "leasedBy" = NULL, "leaseUntil" = NULL, "fehler" = $3, "updatedAt" = NOW() WHERE "id" = $1`,
    [jobId, endgueltig ? "fehlgeschlagen" : "offen", grund.slice(0, 500)],
  );
  await pool.query(`UPDATE "RegisterWorker" SET "zuletztAt" = NOW(), "abfragen" = "abfragen" + $2 WHERE "workerId" = $1`, [workerId, abfragen]);
  return { status: endgueltig ? "fehlgeschlagen" : "offen" };
}

export async function registriereWorker(q: Q, workerId: string, tenantId: string | null, actorId: string | null, art: "desktop" | "betreiber"): Promise<void> {
  await q.query(
    `INSERT INTO "RegisterWorker" ("workerId", "tenantId", "actorId", "art") VALUES ($1, $2, $3, $4)
     ON CONFLICT ("workerId") DO UPDATE SET "zuletztAt" = NOW(), "tenantId" = EXCLUDED."tenantId", "actorId" = EXCLUDED."actorId"`,
    [workerId, tenantId, actorId, art],
  );
}

export type Statistik = {
  jobs: Record<JobArt, Record<string, number>>;
  /** S7 — Firmen mit veralteten strukturierten Inhalten. */
  veraltet: number;
  workerAktiv: number;
  abfragenHeute: number;
  erledigtHeute: number;
  aeltesterOffenerAt: string | null;
};

export async function statistik(pool: pg.Pool): Promise<Statistik> {
  const jobs: Record<JobArt, Record<string, number>> = { front: {}, bekanntmachungen: {}, refresh: {}, insolvenz: {}, at_front: {}, at_refresh: {}, at_insolvenz: {} };
  const r = await pool.query<{ art: JobArt; status: string; n: string }>(`SELECT "art", "status", count(*)::text AS n FROM "RegisterJob" GROUP BY 1, 2`);
  for (const row of r.rows) if (jobs[row.art]) jobs[row.art][row.status] = Number(row.n);
  const w = await pool.query<{ n: string }>(`SELECT count(*)::text AS n FROM "RegisterWorker" WHERE "zuletztAt" > NOW() - interval '1 hour'`);
  const h = await pool.query<{ abfragen: string; erledigt: string; aeltester: Date | null }>(
    `SELECT COALESCE(sum((("ergebnis"->>'abfragen')::int)), 0)::text AS abfragen,
            count(*) FILTER (WHERE "ergebnisAt" > date_trunc('day', NOW()))::text AS erledigt,
            (SELECT min("createdAt") FROM "RegisterJob" WHERE "status" = 'offen') AS aeltester
       FROM "RegisterJob" WHERE "ergebnisAt" > date_trunc('day', NOW())`,
  );
  const v = await pool.query<{ n: string }>(`SELECT count(*)::text AS n FROM "StructuredContentStale"`);
  return {
    jobs,
    veraltet: Number(v.rows[0]?.n ?? 0),
    workerAktiv: Number(w.rows[0]?.n ?? 0),
    abfragenHeute: Number(h.rows[0]?.abfragen ?? 0),
    erledigtHeute: Number(h.rows[0]?.erledigt ?? 0),
    aeltesterOffenerAt: h.rows[0]?.aeltester ? new Date(h.rows[0].aeltester).toISOString() : null,
  };
}

// ---- Cron -------------------------------------------------------------------

let letzterErstellTag: string | null = null;

/**
 * Wiedervorlage: endgueltig fehlgeschlagene Jobs (5 Versuche, z. B. Portal-
 * Stoerung oder Sprachproblem eines Workers) bekommen nach 12 Stunden einen
 * neuen Anlauf mit frischem Versuchszaehler. Bekanntmachungs-Tage sind
 * idempotent ueber den Schluessel, ohne das blieben sie dauerhaft offen.
 */
export async function wiedervorlage(pool: pg.Pool): Promise<number> {
  const r = await pool.query(
    `UPDATE "RegisterJob" SET "status" = 'offen', "versuche" = 0, "leasedBy" = NULL, "leaseUntil" = NULL, "updatedAt" = NOW()
      WHERE "status" = 'fehlgeschlagen' AND "updatedAt" < NOW() - interval '12 hours'`,
  );
  return r.rowCount ?? 0;
}

export async function runRegisterJobCronOnce(now: Date = new Date()): Promise<void> {
  const tag = tagIso(now);
  if (now.getUTCHours() >= 2 && letzterErstellTag !== tag) {
    letzterErstellTag = tag;
    const r = await erzeugeJobs(getGatewayPool(), now);
    logger.info(r, "[register-jobs] Jobs erzeugt");
    if (process.env.INSOLVENZ_JOBS_DISABLED !== "1") {
      try {
        const n = await erzeugeInsolvenzJobs(getGatewayPool());
        logger.info({ insolvenzJobs: n }, "[register-jobs] Insolvenz-Jobs erzeugt");
      } catch (err) {
        logger.warn({ err: err instanceof Error ? err.message : String(err) }, "[register-jobs] Insolvenz-Jobs nicht erzeugt");
      }
    }
    if (process.env.AT_JOBS_DISABLED !== "1") {
      try {
        const at = await erzeugeAtJobs(getGatewayPool(), now);
        logger.info(at, "[register-jobs] Oesterreich-Jobs erzeugt");
      } catch (err) {
        logger.warn({ err: err instanceof Error ? err.message : String(err) }, "[register-jobs] Oesterreich-Jobs nicht erzeugt");
      }
    }
  }
  const w = await wiedervorlage(getGatewayPool());
  if (w > 0) logger.info({ wiedervorgelegt: w }, "[register-jobs] fehlgeschlagene Jobs erneut eingereiht");
}

/** Stuendlicher Tick; Erzeugung einmal taeglich ab 02:00 UTC. REGISTER_JOBS_DISABLED=1 schaltet ab. */
export function startRegisterJobCron(): void {
  if (process.env.REGISTER_JOBS_DISABLED === "1") {
    logger.info("[register-jobs] cron deaktiviert");
    return;
  }
  const INTERVAL_MS = 60 * 60_000;
  setTimeout(() => {
    void runRegisterJobCronOnce().catch((err) => logger.warn({ err: err instanceof Error ? err.message : String(err) }, "[register-jobs] cron failed"));
    setInterval(() => {
      void runRegisterJobCronOnce().catch((err) => logger.warn({ err: err instanceof Error ? err.message : String(err) }, "[register-jobs] cron failed"));
    }, INTERVAL_MS);
  }, 90_000);
  logger.info({ intervalMs: INTERVAL_MS }, "[register-jobs] cron scheduled");
}

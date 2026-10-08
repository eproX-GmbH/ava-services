// K4 (docs/PLAN_KONZERNABSCHLUSS.md, 2026-10-08) — Angaben aus dem
// Konzernabschluss jenseits der Kennzahlen:
//   * Tochtergesellschaften und Konzernmutter → Tabelle "CompanyBeteiligung"
//     (richtung tochter | mutter) in ava_company_publication, je Firma und
//     Quelle (Titel der Publikation) ersetzt. Deutsche Toechter bekommen
//     einen Stammdaten-Treffer (Stufe 0 Direktsuche, "sicher" nur bei genau
//     einem aktiven Namenstreffer; kein Elasticsearch im Persist-Pfad).
//   * Geschaeftsfuehrung → Tabelle "CompanyKonzernGeschaeftsfuehrer" und
//     Abgleich gegen den Registerbestand (ManagingDirector): Namen, die der
//     Abschluss nennt und das Register nicht kennt, bzw. Austritte, die im
//     Register noch stehen, werden als ProfileChangeEvent
//     (kind managing-directors:konzernabschluss) festgehalten — nur mit
//     Registerbestand (Erst-Crawl-Regel) und nur, wenn der Zeitbezug juenger
//     als 180 Tage ist (aeltere Abschluesse sind keine Neuigkeit).
//
// Schema lazy (CREATE TABLE IF NOT EXISTS), Muster wie PublicationBlock.
// Alles best-effort: ein Fehler hier darf den Publikations-Persist nicht brechen.

import { randomUUID } from "node:crypto";
import type pg from "pg";
import type { Logger } from "pino";
import { getGatewayPool, getProducerPool } from "./producer-pools";
import { direktTreffer } from "./kunden-match";
import type { KundenMatch } from "./kunden";

export interface KonzernTochter {
  name: string;
  sitz?: string;
  land?: string;
  anteilProzent?: number;
  verbundenSeit?: string;
  kerngeschaeft?: string;
}

export interface KonzernGf {
  name: string;
  status: "amtierend" | "ausgeschieden" | "bestellt";
  datum?: string;
}

export interface KonzernAngabenEingang {
  toechter: KonzernTochter[];
  konzernmutter?: { name: string; ort?: string };
  geschaeftsfuehrung: KonzernGf[];
}

export interface BeteiligungRow {
  id: number;
  richtung: "tochter" | "mutter";
  name: string;
  sitz: string | null;
  land: string | null;
  anteilProzent: number | null;
  verbundenSeit: string | null;
  kerngeschaeft: string | null;
  quelle: string;
  jahr: number | null;
  match: KundenMatch | null;
}

export interface KonzernGfRow {
  name: string;
  status: string;
  datum: string | null;
}

export interface KonzernAngabenAusgabe {
  companyId: string;
  quelle: string | null;
  jahr: number | null;
  toechter: BeteiligungRow[];
  konzernmutter: BeteiligungRow | null;
  geschaeftsfuehrung: KonzernGfRow[];
}

/** 180 Tage: aelter ist Bestand, keine Neuigkeit. */
const ZEITBEZUG_MS = 180 * 24 * 3600 * 1000;

let schemaReady: Promise<void> | null = null;

async function ensureSchema(pool: pg.Pool): Promise<void> {
  if (!schemaReady) {
    schemaReady = (async () => {
      await pool.query(`
        CREATE TABLE IF NOT EXISTS "CompanyBeteiligung" (
          id              SERIAL PRIMARY KEY,
          "companyId"     TEXT NOT NULL,
          richtung        TEXT NOT NULL,
          name            TEXT NOT NULL,
          sitz            TEXT,
          land            TEXT,
          "anteilProzent" NUMERIC(6,2),
          "verbundenSeit" TEXT,
          kerngeschaeft   TEXT,
          quelle          TEXT NOT NULL,
          jahr            INT,
          "matchCompanyId" TEXT,
          "matchName"     TEXT,
          "matchLocation" TEXT,
          "matchStufe"    TEXT,
          "updatedAt"     TIMESTAMPTZ NOT NULL DEFAULT NOW()
        );
      `);
      await pool.query(`CREATE INDEX IF NOT EXISTS cb_company_idx ON "CompanyBeteiligung"("companyId");`);
      await pool.query(`
        CREATE TABLE IF NOT EXISTS "CompanyKonzernGeschaeftsfuehrer" (
          id          SERIAL PRIMARY KEY,
          "companyId" TEXT NOT NULL,
          name        TEXT NOT NULL,
          status      TEXT NOT NULL,
          datum       DATE,
          quelle      TEXT NOT NULL,
          jahr        INT,
          "updatedAt" TIMESTAMPTZ NOT NULL DEFAULT NOW()
        );
      `);
      await pool.query(`CREATE INDEX IF NOT EXISTS ckg_company_idx ON "CompanyKonzernGeschaeftsfuehrer"("companyId");`);
    })().catch((err) => {
      schemaReady = null;
      throw err;
    });
  }
  await schemaReady;
}

const DEUTSCH_RE = /^(deutschland|germany|de|d|brd)$/i;

function nachname(name: string): string {
  const w = name.trim().split(/\s+/);
  return (w[w.length - 1] ?? "").toLowerCase();
}

/**
 * Schreibt Toechter, Konzernmutter und Geschaeftsfuehrung einer Publikation
 * (Replace je companyId + quelle) und prueft die Geschaeftsfuehrung gegen den
 * Registerbestand. Liefert die Anzahl Toechter mit Stammdaten-Treffer.
 */
export async function schreibeKonzernAngaben(
  pool: pg.Pool,
  log: Logger,
  companyId: string,
  quelle: string,
  jahr: number | null,
  ende: Date | null,
  angaben: KonzernAngabenEingang,
): Promise<{ toechter: number; treffer: number; gfAbgleich: { added: string[]; removed: string[] } | null }> {
  await ensureSchema(pool);

  // Stammdaten-Treffer nur fuer deutsche Toechter (oder ohne Landangabe).
  const deutsch = angaben.toechter.filter((t) => !t.land || DEUTSCH_RE.test(t.land.trim()));
  let treffer = new Map<string, KundenMatch | null>();
  if (deutsch.length > 0) {
    try {
      treffer = await direktTreffer(deutsch.map((t) => t.name));
    } catch (err) {
      log.warn({ err, companyId }, "[konzern] direktsuche toechter fehlgeschlagen");
    }
  }

  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    await client.query(`DELETE FROM "CompanyBeteiligung" WHERE "companyId" = $1 AND quelle = $2`, [companyId, quelle]);
    await client.query(`DELETE FROM "CompanyKonzernGeschaeftsfuehrer" WHERE "companyId" = $1 AND quelle = $2`, [companyId, quelle]);
    for (const t of angaben.toechter) {
      const m = treffer.get(t.name.trim()) ?? null;
      await client.query(
        `INSERT INTO "CompanyBeteiligung"
           ("companyId", richtung, name, sitz, land, "anteilProzent", "verbundenSeit", kerngeschaeft, quelle, jahr,
            "matchCompanyId", "matchName", "matchLocation", "matchStufe", "updatedAt")
         VALUES ($1,'tochter',$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,NOW())`,
        [
          companyId,
          t.name.slice(0, 300),
          t.sitz?.slice(0, 120) ?? null,
          t.land?.slice(0, 80) ?? null,
          typeof t.anteilProzent === "number" ? t.anteilProzent : null,
          t.verbundenSeit?.slice(0, 20) ?? null,
          t.kerngeschaeft?.slice(0, 200) ?? null,
          quelle,
          jahr,
          m?.companyId ?? null,
          m?.name ?? null,
          m?.location ?? null,
          m?.stufe ?? null,
        ],
      );
    }
    if (angaben.konzernmutter) {
      await client.query(
        `INSERT INTO "CompanyBeteiligung" ("companyId", richtung, name, sitz, quelle, jahr, "updatedAt")
         VALUES ($1,'mutter',$2,$3,$4,$5,NOW())`,
        [companyId, angaben.konzernmutter.name.slice(0, 300), angaben.konzernmutter.ort?.slice(0, 120) ?? null, quelle, jahr],
      );
    }
    for (const g of angaben.geschaeftsfuehrung) {
      await client.query(
        `INSERT INTO "CompanyKonzernGeschaeftsfuehrer" ("companyId", name, status, datum, quelle, jahr, "updatedAt")
         VALUES ($1,$2,$3,$4,$5,$6,NOW())`,
        [companyId, g.name.slice(0, 200), g.status, g.datum ?? null, quelle, jahr],
      );
    }
    await client.query("COMMIT");
  } catch (err) {
    await client.query("ROLLBACK").catch(() => undefined);
    throw err;
  } finally {
    client.release();
  }

  const gfAbgleich = await pruefeGeschaeftsfuehrung(log, companyId, jahr, ende, angaben.geschaeftsfuehrung);
  return { toechter: angaben.toechter.length, treffer: [...treffer.values()].filter(Boolean).length, gfAbgleich };
}

/**
 * Geschaeftsfuehrung laut Konzernabschluss gegen den Registerbestand
 * (structured-content.ManagingDirector). Ohne Bestand kein Urteil
 * (Erst-Crawl-Regel). Ereignis nur bei Abweichung UND Zeitbezug
 * (Austritts-/Bestelldatum, sonst Abschlussende) juenger als 180 Tage.
 */
async function pruefeGeschaeftsfuehrung(
  log: Logger,
  companyId: string,
  jahr: number | null,
  ende: Date | null,
  gf: KonzernGf[],
): Promise<{ added: string[]; removed: string[] } | null> {
  if (gf.length === 0) return null;
  let register: Array<{ firstName: string | null; lastName: string | null; updatedAt: Date | null }>;
  try {
    const r = await getProducerPool("structured-content").query<{ firstName: string | null; lastName: string | null; updatedAt: Date | null }>(
      `SELECT "firstName", "lastName", "updatedAt" FROM "ManagingDirector" WHERE "companyId" = $1`,
      [companyId],
    );
    register = r.rows;
  } catch (err) {
    log.warn({ err, companyId }, "[konzern] registerbestand nicht lesbar");
    return null;
  }
  if (register.length === 0) return null;
  const imRegister = new Set(register.map((r) => (r.lastName ?? "").trim().toLowerCase()).filter(Boolean));
  const laut = new Map<string, KonzernGf>();
  for (const g of gf) laut.set(nachname(g.name), g);

  const added: string[] = [];
  const removed: string[] = [];
  let zeitbezug: Date | null = ende;
  for (const g of gf) {
    const n = nachname(g.name);
    if (!n) continue;
    if (g.status === "ausgeschieden" && imRegister.has(n)) removed.push(g.name);
    if (g.status !== "ausgeschieden" && !imRegister.has(n)) added.push(g.name);
    if (g.datum && (g.status === "ausgeschieden" ? imRegister.has(n) : !imRegister.has(n))) {
      const d = new Date(g.datum);
      if (!Number.isNaN(d.getTime()) && (!zeitbezug || d > zeitbezug)) zeitbezug = d;
    }
  }
  const diff = { added, removed };
  if (added.length === 0 && removed.length === 0) return diff;
  const alter = zeitbezug ? Date.now() - zeitbezug.getTime() : Number.POSITIVE_INFINITY;
  if (alter > ZEITBEZUG_MS) {
    log.info({ companyId, jahr, added, removed }, "[konzern] gf-abweichung zum register, aber aelter als 180 Tage — kein Ereignis");
    return diff;
  }
  try {
    const pool = getGatewayPool();
    const bestandVon = register.map((r) => r.updatedAt).filter((d): d is Date => d instanceof Date).sort((a, b) => b.getTime() - a.getTime())[0] ?? null;
    const alsPerson = (name: string) => {
      const w = name.trim().split(/\s+/);
      return { firstName: w.slice(0, -1).join(" "), lastName: w[w.length - 1] ?? "" };
    };
    await pool.query(
      `INSERT INTO "ProfileChangeEvent" (id, "companyId", kind, added, removed, "bestandVon")
       VALUES ($1, $2, $3, $4::jsonb, $5::jsonb, $6)`,
      [
        randomUUID(),
        companyId,
        `managing-directors:konzernabschluss${jahr ? ` ${jahr}` : ""}`,
        JSON.stringify(added.map(alsPerson)),
        JSON.stringify(removed.map(alsPerson)),
        bestandVon,
      ],
    );
    log.info({ companyId, jahr, added, removed }, "[konzern] profile-change recorded (managing-directors:konzernabschluss)");
  } catch (err) {
    log.warn({ err, companyId }, "[konzern] profile-change record failed (best-effort)");
  }
  return diff;
}

/** Neueste Angaben einer Firma (eine Quelle = der juengste Konzernabschluss). */
export async function listeKonzernAngaben(companyId: string): Promise<KonzernAngabenAusgabe> {
  const pool = getProducerPool("company-publication");
  const leer: KonzernAngabenAusgabe = { companyId, quelle: null, jahr: null, toechter: [], konzernmutter: null, geschaeftsfuehrung: [] };
  // Ohne Schema (noch nie ein Konzernabschluss verarbeitet) gibt es nichts.
  const vorhanden = await pool.query<{ ok: boolean }>(`SELECT to_regclass('"CompanyBeteiligung"') IS NOT NULL AS ok`);
  if (!vorhanden.rows[0]?.ok) return leer;
  const q = await pool.query<{ quelle: string; jahr: number | null }>(
    `SELECT quelle, jahr FROM "CompanyBeteiligung" WHERE "companyId" = $1
     UNION SELECT quelle, jahr FROM "CompanyKonzernGeschaeftsfuehrer" WHERE "companyId" = $1
     ORDER BY jahr DESC NULLS LAST LIMIT 1`,
    [companyId],
  );
  const quelle = q.rows[0];
  if (!quelle) return leer;
  const b = await pool.query<{
    id: number; richtung: "tochter" | "mutter"; name: string; sitz: string | null; land: string | null; anteilProzent: string | null;
    verbundenSeit: string | null; kerngeschaeft: string | null; matchCompanyId: string | null; matchName: string | null; matchLocation: string | null; matchStufe: string | null;
  }>(
    `SELECT id, richtung, name, sitz, land, "anteilProzent"::text AS "anteilProzent", "verbundenSeit", kerngeschaeft,
            "matchCompanyId", "matchName", "matchLocation", "matchStufe"
       FROM "CompanyBeteiligung" WHERE "companyId" = $1 AND quelle = $2 ORDER BY richtung, id`,
    [companyId, quelle.quelle],
  );
  const g = await pool.query<{ name: string; status: string; datum: Date | null }>(
    `SELECT name, status, datum FROM "CompanyKonzernGeschaeftsfuehrer" WHERE "companyId" = $1 AND quelle = $2 ORDER BY status, id`,
    [companyId, quelle.quelle],
  );
  const rows: BeteiligungRow[] = b.rows.map((r) => ({
    id: r.id,
    richtung: r.richtung,
    name: r.name,
    sitz: r.sitz,
    land: r.land,
    anteilProzent: r.anteilProzent === null ? null : Number(r.anteilProzent),
    verbundenSeit: r.verbundenSeit,
    kerngeschaeft: r.kerngeschaeft,
    quelle: quelle.quelle,
    jahr: quelle.jahr,
    match: r.matchCompanyId && r.matchName
      ? { companyId: r.matchCompanyId, name: r.matchName, location: r.matchLocation, stufe: r.matchStufe === "unsicher" ? "unsicher" : "sicher", score: null }
      : null,
  }));
  return {
    companyId,
    quelle: quelle.quelle,
    jahr: quelle.jahr,
    toechter: rows.filter((r) => r.richtung === "tochter"),
    konzernmutter: rows.find((r) => r.richtung === "mutter") ?? null,
    geschaeftsfuehrung: g.rows.map((r) => ({ name: r.name, status: r.status, datum: r.datum ? new Date(r.datum).toISOString().slice(0, 10) : null })),
  };
}

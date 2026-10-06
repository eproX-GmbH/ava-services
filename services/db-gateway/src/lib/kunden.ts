// Kunden und Referenzen einer Firma (docs/PLAN_KUNDEN.md, K2).
//
// Der Kontakt-Producer erkennt beim Nutzer, welche Kunden, Partner und
// Referenzprojekte eine Firma auf ihrer Website nennt, und schickt sie mit
// dem Persist-Ereignis (`kunden`). Hier landen sie in der Gateway-DB
// (abgeleitetes Signal, wie ProfileChangeEvent) und werden gegen die
// Stammdaten abgeglichen, damit die Oberflaeche einen genannten Kunden
// direkt uebernehmen kann.
//
// Schreiben ist best-effort: Ein Fehler hier bricht den Persist nie.

import { randomUUID } from "node:crypto";
import type { Pool } from "pg";
import type { Logger } from "pino";
import { getGatewayPool } from "./producer-pools";

export type KundenArt = "kunde" | "partner" | "referenzprojekt" | "zertifikat" | "technologiepartner";
export const KUNDEN_ARTEN: KundenArt[] = ["kunde", "partner", "referenzprojekt", "zertifikat", "technologiepartner"];
/** Zertifikate sind keine Firmen: kein Stammdaten-Abgleich, keine Uebernahme. */
export const OHNE_ABGLEICH: KundenArt[] = ["zertifikat"];

export interface KundeEingang {
  name: string;
  art: string;
  beleg?: string | null;
  quelle?: string | null;
  konfidenz?: string | null;
}

export interface KundeRow {
  id: string;
  companyId: string;
  name: string;
  art: KundenArt;
  beleg: string | null;
  quelle: string | null;
  konfidenz: string | null;
  erstGesehen: string;
  zuletztGesehen: string;
  match: { companyId: string; name: string; location: string | null } | null;
  matchGeprueftAt: string | null;
}

let schemaReady: Promise<void> | null = null;

async function ensureSchema(pool: Pool): Promise<void> {
  if (!schemaReady) {
    schemaReady = pool
      .query(
        `CREATE TABLE IF NOT EXISTS "CompanyKunde" (
           id               TEXT PRIMARY KEY,
           "companyId"      TEXT NOT NULL,
           name             TEXT NOT NULL,
           "nameNormalized" TEXT NOT NULL,
           art              TEXT NOT NULL,
           beleg            TEXT,
           quelle           TEXT,
           konfidenz        TEXT,
           "erstGesehen"    TIMESTAMPTZ NOT NULL DEFAULT NOW(),
           "zuletztGesehen" TIMESTAMPTZ NOT NULL DEFAULT NOW(),
           "matchCompanyId" TEXT,
           "matchName"      TEXT,
           "matchLocation"  TEXT,
           "matchGeprueftAt" TIMESTAMPTZ,
           UNIQUE ("companyId", "nameNormalized")
         );
         CREATE INDEX IF NOT EXISTS "CompanyKunde_company_idx"
           ON "CompanyKunde" ("companyId", "zuletztGesehen" DESC);
         CREATE INDEX IF NOT EXISTS "CompanyKunde_name_idx"
           ON "CompanyKunde" ("nameNormalized");`,
      )
      .then(() => undefined)
      .catch((err) => {
        schemaReady = null;
        throw err;
      });
  }
  return schemaReady;
}

/** Vergleichsform: klein, ohne Rechtsform und Sonderzeichen. */
export function normalisiereKundenname(s: string): string {
  return s
    .toLowerCase()
    .replace(/\b(inc|llc|ltd|gmbh|ag|se|b\.?v|s\.?a|corp|co|kg|mbh|ohg|e\.?v)\b\.?/g, " ")
    .replace(/[^\p{L}\p{N}]+/gu, "")
    .trim();
}

/** Upsert je (Firma, Name): neue Zeile oder zuletztGesehen + Beleg frisch. */
export async function schreibeKunden(
  log: Logger,
  companyId: string,
  kunden: KundeEingang[],
): Promise<void> {
  if (kunden.length === 0) return;
  try {
    const pool = getGatewayPool();
    await ensureSchema(pool);
    let geschrieben = 0;
    for (const k of kunden) {
      const name = (k.name ?? "").trim();
      const norm = normalisiereKundenname(name);
      const art = (k.art ?? "").trim().toLowerCase();
      if (!name || norm.length < 2 || !KUNDEN_ARTEN.includes(art as KundenArt)) continue;
      await pool.query(
        `INSERT INTO "CompanyKunde" (id, "companyId", name, "nameNormalized", art, beleg, quelle, konfidenz)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
         ON CONFLICT ("companyId", "nameNormalized") DO UPDATE SET
           name = EXCLUDED.name,
           art = EXCLUDED.art,
           beleg = COALESCE(EXCLUDED.beleg, "CompanyKunde".beleg),
           quelle = COALESCE(EXCLUDED.quelle, "CompanyKunde".quelle),
           konfidenz = COALESCE(EXCLUDED.konfidenz, "CompanyKunde".konfidenz),
           "zuletztGesehen" = NOW()`,
        [randomUUID(), companyId, name, norm, art, k.beleg?.slice(0, 300) ?? null, k.quelle ?? null, k.konfidenz ?? null],
      );
      geschrieben += 1;
    }
    log.info({ companyId, kunden: geschrieben }, "kunden persisted");
  } catch (err) {
    log.warn({ err, companyId }, "kunden persist failed (best-effort, persist unaffected)");
  }
}

function iso(v: Date | string | null | undefined): string | null {
  if (!v) return null;
  return v instanceof Date ? v.toISOString() : new Date(v).toISOString();
}

export async function listeKunden(companyId: string): Promise<KundeRow[]> {
  const pool = getGatewayPool();
  await ensureSchema(pool);
  const r = await pool.query<{
    id: string; companyId: string; name: string; art: string; beleg: string | null; quelle: string | null;
    konfidenz: string | null; erstGesehen: Date; zuletztGesehen: Date;
    matchCompanyId: string | null; matchName: string | null; matchLocation: string | null; matchGeprueftAt: Date | null;
  }>(
    `SELECT id, "companyId", name, art, beleg, quelle, konfidenz, "erstGesehen", "zuletztGesehen",
            "matchCompanyId", "matchName", "matchLocation", "matchGeprueftAt"
       FROM "CompanyKunde" WHERE "companyId" = $1
      ORDER BY (konfidenz = 'hoch') DESC, art, name`,
    [companyId],
  );
  return r.rows.map((x) => ({
    id: x.id,
    companyId: x.companyId,
    name: x.name,
    art: x.art as KundenArt,
    beleg: x.beleg,
    quelle: x.quelle,
    konfidenz: x.konfidenz,
    erstGesehen: iso(x.erstGesehen)!,
    zuletztGesehen: iso(x.zuletztGesehen)!,
    match: x.matchCompanyId ? { companyId: x.matchCompanyId, name: x.matchName ?? x.matchCompanyId, location: x.matchLocation } : null,
    matchGeprueftAt: iso(x.matchGeprueftAt),
  }));
}

/** Abgleich-Ergebnis festhalten; `null` heisst geprueft, nichts gefunden. */
export async function setzeMatch(
  id: string,
  match: { companyId: string; name: string; location: string | null } | null,
): Promise<void> {
  const pool = getGatewayPool();
  await pool.query(
    `UPDATE "CompanyKunde"
        SET "matchCompanyId" = $2, "matchName" = $3, "matchLocation" = $4, "matchGeprueftAt" = NOW()
      WHERE id = $1`,
    [id, match?.companyId ?? null, match?.name ?? null, match?.location ?? null],
  );
}

/**
 * Umkehrsuche (docs/PLAN_KUNDEN.md): Welche der uebergebenen Firmen nennen
 * eine bestimmte Firma als Kunde, Partner oder Referenz? Trifft ueber den
 * Stammdaten-Treffer (companyId) ODER den genannten Namen (Normalform,
 * Teiltreffer). Die Firmenliste kommt vom Aufrufer — seine eigenen Firmen.
 */
export async function listeNennungen(args: {
  companyIds: string[];
  name?: string | null;
  zielCompanyId?: string | null;
  limit?: number;
}): Promise<KundeRow[]> {
  if (args.companyIds.length === 0) return [];
  const pool = getGatewayPool();
  await ensureSchema(pool);
  const norm = args.name ? normalisiereKundenname(args.name) : "";
  if (!norm && !args.zielCompanyId) return [];
  const bedingungen: string[] = [];
  const werte: unknown[] = [args.companyIds];
  if (args.zielCompanyId) {
    werte.push(args.zielCompanyId);
    bedingungen.push(`"matchCompanyId" = $${werte.length}`);
  }
  if (norm.length >= 3) {
    werte.push(`%${norm}%`);
    bedingungen.push(`"nameNormalized" LIKE $${werte.length}`);
  } else if (norm) {
    werte.push(norm);
    bedingungen.push(`"nameNormalized" = $${werte.length}`);
  }
  werte.push(Math.max(1, Math.min(500, args.limit ?? 200)));
  const r = await pool.query<{
    id: string; companyId: string; name: string; art: string; beleg: string | null; quelle: string | null;
    konfidenz: string | null; erstGesehen: Date; zuletztGesehen: Date;
    matchCompanyId: string | null; matchName: string | null; matchLocation: string | null; matchGeprueftAt: Date | null;
  }>(
    `SELECT id, "companyId", name, art, beleg, quelle, konfidenz, "erstGesehen", "zuletztGesehen",
            "matchCompanyId", "matchName", "matchLocation", "matchGeprueftAt"
       FROM "CompanyKunde"
      WHERE "companyId" = ANY($1::text[]) AND (${bedingungen.join(" OR ")})
      ORDER BY "zuletztGesehen" DESC
      LIMIT $${werte.length}`,
    werte,
  );
  return r.rows.map((x) => ({
    id: x.id,
    companyId: x.companyId,
    name: x.name,
    art: x.art as KundenArt,
    beleg: x.beleg,
    quelle: x.quelle,
    konfidenz: x.konfidenz,
    erstGesehen: iso(x.erstGesehen)!,
    zuletztGesehen: iso(x.zuletztGesehen)!,
    match: x.matchCompanyId ? { companyId: x.matchCompanyId, name: x.matchName ?? x.matchCompanyId, location: x.matchLocation } : null,
    matchGeprueftAt: iso(x.matchGeprueftAt),
  }));
}

export interface GemeinsamerKunde {
  /** Name, wie die betrachtete Firma ihn nennt. */
  name: string;
  art: KundenArt;
  match: { companyId: string; name: string; location: string | null } | null;
  /** Firmen aus der Liste des Aufrufers, die denselben Kunden nennen. */
  firmen: Array<{ companyId: string; name: string; art: KundenArt }>;
}

/**
 * Gemeinsame Kunden (docs/PLAN_KUNDEN.md, Vertriebsblick): Welche Kunden der
 * Firma X nennen auch andere Firmen aus der Liste des Aufrufers? Gleich ist
 * ein Kunde ueber den Stammdaten-Treffer oder die Normalform des Namens.
 */
export async function listeGemeinsameKunden(args: {
  companyId: string;
  companyIds: string[];
}): Promise<GemeinsamerKunde[]> {
  const andere = args.companyIds.filter((id) => id !== args.companyId);
  if (andere.length === 0) return [];
  const pool = getGatewayPool();
  await ensureSchema(pool);
  const r = await pool.query<{
    name: string; art: string; matchCompanyId: string | null; matchName: string | null; matchLocation: string | null;
    andereCompanyId: string; andererName: string; andereArt: string;
  }>(
    `SELECT k.name, k.art, k."matchCompanyId", k."matchName", k."matchLocation",
            a."companyId" AS "andereCompanyId", a.name AS "andererName", a.art AS "andereArt"
       FROM "CompanyKunde" k
       JOIN "CompanyKunde" a
         ON a."companyId" = ANY($2::text[])
        AND a."companyId" <> k."companyId"
        AND (
          (k."matchCompanyId" IS NOT NULL AND a."matchCompanyId" = k."matchCompanyId")
          OR a."nameNormalized" = k."nameNormalized"
        )
      WHERE k."companyId" = $1
      ORDER BY k.name, a."companyId"
      LIMIT 500`,
    [args.companyId, andere],
  );
  const jeKunde = new Map<string, GemeinsamerKunde>();
  for (const z of r.rows) {
    const key = z.matchCompanyId ?? normalisiereKundenname(z.name);
    let g = jeKunde.get(key);
    if (!g) {
      g = {
        name: z.name,
        art: z.art as KundenArt,
        match: z.matchCompanyId ? { companyId: z.matchCompanyId, name: z.matchName ?? z.matchCompanyId, location: z.matchLocation } : null,
        firmen: [],
      };
      jeKunde.set(key, g);
    }
    if (!g.firmen.some((f) => f.companyId === z.andereCompanyId)) {
      g.firmen.push({ companyId: z.andereCompanyId, name: z.andererName, art: z.andereArt as KundenArt });
    }
  }
  return [...jeKunde.values()];
}

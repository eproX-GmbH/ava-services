// PM-2026-0045 (Patrick, TMS Turnkey Manufacturing Solutions, Linz): die Google-
// Suche fand nur Drittseiten, die echte Website (valianttms.com) traegt den Namen
// der Konzerngruppe. Kein Weg, die Website von Hand vorzugeben. Die Vorgabe liegt
// in der Website-Datenbank neben CompanySerp; die Website-Stufe uebernimmt sie ohne
// Suche und Urteil (wie bei Firmen ohne Register).

import type pg from "pg";
import { getGatewayPool, getProducerPool } from "./producer-pools";

export interface WebsiteVorgabe {
  companyId: string;
  url: string;
  domain: string;
  actorId: string;
  updatedAt: string;
}

let bereit = false;
async function sicherstellen(pool: pg.Pool): Promise<void> {
  if (bereit) return;
  await pool.query(`CREATE TABLE IF NOT EXISTS "WebsiteVorgabe" (
    "companyId" TEXT PRIMARY KEY,
    url         TEXT NOT NULL,
    domain      TEXT NOT NULL,
    "tenantId"  TEXT NOT NULL,
    "actorId"   TEXT NOT NULL,
    "createdAt" TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    "updatedAt" TIMESTAMPTZ NOT NULL DEFAULT NOW()
  )`);
  bereit = true;
}

/** https://www.firma.de/pfad → { url: https://www.firma.de/, domain: firma.de }; null bei Unsinn. */
export function vorgabeNormalisieren(roh: string): { url: string; domain: string } | null {
  const t = roh.trim();
  if (!t || /\s/.test(t)) return null;
  let u: URL;
  try {
    u = new URL(/^https?:\/\//i.test(t) ? t : `https://${t}`);
  } catch {
    return null;
  }
  if (!/^https?:$/.test(u.protocol) || !u.hostname.includes(".")) return null;
  const host = u.hostname.toLowerCase().replace(/\.$/, "");
  return { url: `${u.protocol}//${host}/`, domain: host.replace(/^www\./, "") };
}

export async function vorgabeLesen(companyId: string, pool: pg.Pool = getProducerPool("website")): Promise<WebsiteVorgabe | null> {
  await sicherstellen(pool);
  const r = await pool.query<{ companyId: string; url: string; domain: string; actorId: string; updatedAt: Date }>(
    `SELECT "companyId", url, domain, "actorId", "updatedAt" FROM "WebsiteVorgabe" WHERE "companyId" = $1`,
    [companyId],
  );
  const z = r.rows[0];
  return z ? { companyId: z.companyId, url: z.url, domain: z.domain, actorId: z.actorId, updatedAt: z.updatedAt.toISOString() } : null;
}

/**
 * Vorgabe setzen und die Frische der Website-Stufe loeschen: sonst verwirft das
 * Tier-Gate den naechsten Lauf als "frisch", obwohl sich die Eingabe geaendert hat.
 */
export async function vorgabeSetzen(args: { companyId: string; url: string; domain: string; tenantId: string; actorId: string }): Promise<WebsiteVorgabe> {
  const pool = getProducerPool("website");
  await sicherstellen(pool);
  await pool.query(
    `INSERT INTO "WebsiteVorgabe" ("companyId", url, domain, "tenantId", "actorId")
     VALUES ($1, $2, $3, $4, $5)
     ON CONFLICT ("companyId") DO UPDATE SET url = EXCLUDED.url, domain = EXCLUDED.domain,
       "tenantId" = EXCLUDED."tenantId", "actorId" = EXCLUDED."actorId", "updatedAt" = NOW()`,
    [args.companyId, args.url, args.domain, args.tenantId, args.actorId],
  );
  await getGatewayPool()
    .query(`DELETE FROM "ContentFreshness" WHERE "companyId" = $1 AND stage = 'website'`, [args.companyId])
    .catch(() => undefined);
  return (await vorgabeLesen(args.companyId, pool))!;
}

export async function vorgabeEntfernen(companyId: string): Promise<boolean> {
  const pool = getProducerPool("website");
  await sicherstellen(pool);
  const r = await pool.query(`DELETE FROM "WebsiteVorgabe" WHERE "companyId" = $1`, [companyId]);
  return (r.rowCount ?? 0) > 0;
}

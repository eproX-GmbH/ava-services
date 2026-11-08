// Onboarding O4 (docs/PLAN_ONBOARDING.md, Joyce 2026-11-08): Startpaket. Die bis zu
// 10 Firmen, die der Start-Workflow nach dem ersten Radar-Lauf uebernimmt, zaehlen
// nicht aufs Kontingent. Einmal je Abrechnungskonto; recordUsage bucht sie unter
// periodKey "startpaket" (keine Kontingent- oder Rechnungsabfrage zaehlt diesen).

import type pg from "pg";
import { logger } from "./logger";

export const STARTPAKET_MAX = 10;
export const STARTPAKET_PERIODE = "startpaket";

/** Firmen eines Startpaket-Imports vormerken (nur wenn das Konto noch keins hatte). */
export async function startpaketVormerken(pool: pg.Pool, e: { billingAccountId: string; transactionId: string; companyIds: string[] }): Promise<number> {
  const schon = await pool.query(`SELECT 1 FROM "StartpaketFirma" WHERE "billingAccountId" = $1 LIMIT 1`, [e.billingAccountId]);
  if (schon.rows.length > 0) return 0;
  const ids = [...new Set(e.companyIds)].slice(0, STARTPAKET_MAX);
  for (const companyId of ids) {
    await pool.query(
      `INSERT INTO "StartpaketFirma" ("billingAccountId", "companyId", "transactionId") VALUES ($1, $2, $3) ON CONFLICT DO NOTHING`,
      [e.billingAccountId, companyId, e.transactionId],
    );
  }
  logger.info({ billingAccountId: e.billingAccountId, transactionId: e.transactionId, anzahl: ids.length }, "[startpaket] vorgemerkt");
  return ids.length;
}

/** Gehoert die Firma zum Startpaket dieses Abrechnungskontos? */
export async function istStartpaket(pool: pg.Pool, billingAccountId: string, companyId: string): Promise<boolean> {
  try {
    const r = await pool.query(`SELECT 1 FROM "StartpaketFirma" WHERE "billingAccountId" = $1 AND "companyId" = $2`, [billingAccountId, companyId]);
    return r.rows.length > 0;
  } catch {
    return false; // Tabelle fehlt (Migration ausstehend): normal buchen
  }
}

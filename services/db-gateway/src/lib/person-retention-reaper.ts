// C1 — taeglicher Tilgungslauf: Personen ohne Beobachtung seit N Tagen
// (Standard 180; je Tenant ueber TenantPolicy.personRetentionDays, bei
// mehreren erhebenden Tenants gilt der kleinste Wert).

import { logger } from "./logger";
import { getGatewayPool, getProducerPool } from "./producer-pools";
import { purgeStalePersons } from "./person-compliance";

const INTERVAL_MS = 24 * 60 * 60_000;

export async function runPersonRetentionOnce(dryRun = false): Promise<{ geprueft: number; getilgt: number }> {
  const r = await getGatewayPool().query<{ tenantId: string; d: number | null }>(`SELECT "tenantId", "personRetentionDays" AS d FROM "TenantPolicy" WHERE "personRetentionDays" IS NOT NULL`);
  const map = new Map<string, number>();
  for (const row of r.rows) if (row.d) map.set(row.tenantId, row.d);
  const res = await purgeStalePersons(getProducerPool("company-contact"), { retentionByTenant: map, dryRun });
  logger.info({ ...res, dryRun, tenantsMitVorgabe: map.size }, "[person-retention] Lauf");
  return res;
}

export function startPersonRetentionCron(): void {
  if (process.env.PERSON_RETENTION_DISABLED === "1") {
    logger.info("[person-retention] deaktiviert (PERSON_RETENTION_DISABLED=1)");
    return;
  }
  const tick = () => void runPersonRetentionOnce().catch((err) => logger.warn({ err: err instanceof Error ? err.message : String(err) }, "[person-retention] failed"));
  setTimeout(tick, 5 * 60_000).unref?.();
  setInterval(tick, INTERVAL_MS).unref?.();
  logger.info("[person-retention] cron scheduled (taeglich, erster Lauf in 5 Min)");
}

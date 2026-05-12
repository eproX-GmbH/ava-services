// Q-track v0.1.137 — Resume-worker.
//
// Two triggers replay parked-companies into the producer pipeline:
//
//   1. Stripe tier-change webhook (lib/billing.ts hooks
//      `resumeParkedForTenant` after `upsertSubscriptionState`).
//   2. 5-minute cron tick that scans `ParkedCompany` for tenants with
//      at least one row, rolls expired `periodEnd` columns forward on
//      paid tiers, and fires the resume for tenants that have headroom.
//
// The worker DOES NOT decide per-row whether to publish — it just asks
// master-data to do another batch. Master-data calls `try-reserve` for
// each parked id; whichever still doesn't fit stays parked.
//
// Throttling: per-tenant in-flight set in process memory. Multi-
// instance gateway would need a Redis-backed dedupe, but per D3 we're
// single-instance per customer.

import { getGatewayPool } from "./producer-pools";
import { loadEnv } from "./env";
import { logger } from "./logger";
import { createHmac } from "node:crypto";

const inFlight = new Set<string>();

/** Mark the tenant as in-flight and fire-and-forget the resume.
 *  Returns immediately; the caller (Stripe webhook) doesn't need the
 *  outcome. Safe to call repeatedly — dedupe is in-memory. */
export function resumeParkedForTenant(tenantId: string): void {
  if (inFlight.has(tenantId)) {
    logger.debug({ tenantId }, "[quota-resume] already in-flight, skipping");
    return;
  }
  inFlight.add(tenantId);
  runResumeLoop(tenantId)
    .catch((err) =>
      logger.error(
        { err: err instanceof Error ? err.message : String(err), tenantId },
        "[quota-resume] loop failed",
      ),
    )
    .finally(() => inFlight.delete(tenantId));
}

async function runResumeLoop(tenantId: string): Promise<void> {
  const env = loadEnv();
  if (!env.INTERNAL_HMAC_SECRET) {
    logger.warn({ tenantId }, "[quota-resume] INTERNAL_HMAC_SECRET unset; skipping");
    return;
  }
  let totalPublished = 0;
  // Hard cap at 50 iterations × 20 rows = 1000 companies per trigger;
  // resumes for huge backlogs cycle back via the 5-min cron.
  for (let i = 0; i < 50; i++) {
    const body = JSON.stringify({ tenantId, batchSize: 20 });
    const sig = createHmac("sha256", env.INTERNAL_HMAC_SECRET).update(body, "utf8").digest("hex");
    let res: Response;
    try {
      res = await fetch(
        `${env.UPSTREAM_MASTER_DATA_URL.replace(/\/$/, "")}/internal/companies/republish-triggers`,
        {
          method: "POST",
          headers: {
            "content-type": "application/json",
            "x-internal-signature": sig,
          },
          body,
        },
      );
    } catch (err) {
      logger.error(
        { err: err instanceof Error ? err.message : String(err), tenantId },
        "[quota-resume] fetch failed",
      );
      return;
    }
    if (!res.ok) {
      logger.error(
        { status: res.status, tenantId },
        "[quota-resume] master-data returned non-2xx",
      );
      return;
    }
    const data = (await res.json()) as { published?: number; remaining?: number };
    totalPublished += data.published ?? 0;
    if (!data.published || data.published === 0) break;
    if (data.remaining === 0) break;
    // Throttle: ~5/sec/tenant. With batchSize=20 that's 100 publishes/sec
    // upper-bound, well within healthy AMQP fan-out.
    await new Promise((r) => setTimeout(r, 200));
  }
  logger.info({ tenantId, total_published: totalPublished }, "[quota-resume] tenant done");
}

/** 5-minute cron. Two concerns:
 *  1. Roll `periodEnd` forward for paid-tier tenants whose period
 *     already passed (so resumed companies fall under the new period).
 *  2. For every tenant with at least one parked row, kick the resume
 *     loop. master-data's `try-reserve` per row decides what fits. */
export function startQuotaResumeCron(): void {
  const INTERVAL_MS = 5 * 60_000;
  // Stagger the first tick so a boot storm doesn't pile-up.
  setTimeout(() => {
    void cronTick();
    setInterval(() => {
      void cronTick();
    }, INTERVAL_MS);
  }, 30_000);
  logger.info({ intervalMs: INTERVAL_MS }, "[quota-resume] cron scheduled");
}

async function cronTick(): Promise<void> {
  try {
    // 1. Roll expired periodEnd forward to the next month for paid tiers.
    //    Free + enterprise are excluded (their periodEnd is NULL).
    await getGatewayPool().query(
      `UPDATE "TenantBilling"
          SET "periodEnd" = date_trunc('month', "periodEnd") + interval '2 months',
              "updatedAt" = NOW()
        WHERE "periodEnd" IS NOT NULL
          AND "periodEnd" < NOW()
          AND tier IN ('starter', 'pro')`,
    );

    // 2. Scan for tenants with parked rows.
    const res = await getGatewayPool().query<{ tenantId: string }>(
      `SELECT DISTINCT "tenantId" FROM "ParkedCompany"`,
    );
    for (const row of res.rows) {
      resumeParkedForTenant(row.tenantId);
    }
    if (res.rowCount && res.rowCount > 0) {
      logger.info({ tenants: res.rowCount }, "[quota-resume] cron tick fan-out");
    }
  } catch (err) {
    logger.error(
      { err: err instanceof Error ? err.message : String(err) },
      "[quota-resume] cron tick failed",
    );
  }
}

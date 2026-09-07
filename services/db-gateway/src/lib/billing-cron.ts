// B1/B2 (docs/PLAN_ABRECHNUNG_SEATS.md) — Billing-Cron.
//
// Stuendlich:
//   1. Vorgemerkte Seat-Aenderungen anwenden (Downgrade/Deaktivierung zum 1.).
//   2. Abgeschlossene Monate verbuchen (SeatInvoice-Datensatz), nachholbar (K14).
//   3. Zahlungsstoerungen: past_due laenger als graceDays → suspended (K7).
// Taeglich (erster Lauf nach 03:00 UTC):
//   4. Abgleich mit Stripe (H4): Abo-Stand je Kunde gegen die DB.
//
// BILLING_CRON_DISABLED=1 schaltet alles ab (Tests, souveraener Betrieb
// ohne Stripe laesst nur den Abgleich aus).

import { logger } from "./logger";
import { getGatewayPool } from "./producer-pools";
import { applyScheduledSeatChanges, closeCompletedPeriods } from "./seat-billing";
import { recordBillingEvent } from "./billing-events";
import { invalidateBillingResolution } from "./billing";
import { TIER_LIMITS, tierFromPriceId } from "./billing-plans";

const INTERVAL_MS = 60 * 60_000;
let letzterAbgleichTag: string | null = null;

export async function runBillingCronOnce(now: Date = new Date()): Promise<void> {
  const pool = getGatewayPool();
  try {
    const applied = await applyScheduledSeatChanges(pool, now);
    if (applied > 0) logger.info({ applied }, "[billing-cron] Seat-Aenderungen angewandt");
  } catch (err) {
    logger.warn({ err: err instanceof Error ? err.message : String(err) }, "[billing-cron] applyScheduledSeatChanges failed");
  }
  try {
    const r = await closeCompletedPeriods(pool, now);
    if (r.created > 0) logger.info(r, "[billing-cron] Monatsabschluss verbucht");
  } catch (err) {
    logger.warn({ err: err instanceof Error ? err.message : String(err) }, "[billing-cron] closeCompletedPeriods failed");
  }
  try {
    await suspendOverdue(now);
  } catch (err) {
    logger.warn({ err: err instanceof Error ? err.message : String(err) }, "[billing-cron] suspendOverdue failed");
  }
  const tag = now.toISOString().slice(0, 10);
  if (now.getUTCHours() >= 3 && letzterAbgleichTag !== tag) {
    letzterAbgleichTag = tag;
    try {
      await reconcileWithStripe();
    } catch (err) {
      logger.warn({ err: err instanceof Error ? err.message : String(err) }, "[billing-cron] reconcile failed");
    }
  }
}

/** K7 — past_due laenger als graceDays → suspended (Importe/Scans pausieren). */
async function suspendOverdue(now: Date): Promise<void> {
  const pool = getGatewayPool();
  const r = await pool.query<{ tenantId: string; graceDays: number; pastDueSince: Date }>(
    `SELECT "tenantId", "graceDays", "pastDueSince" FROM "TenantBilling"
      WHERE "status" = 'past_due' AND "pastDueSince" IS NOT NULL AND "pastDueSince" + ("graceDays" || ' days')::interval < $1`,
    [now],
  );
  for (const row of r.rows) {
    await pool.query(`UPDATE "TenantBilling" SET "status" = 'suspended', "suspendedAt" = NOW(), "updatedAt" = NOW() WHERE "tenantId" = $1 AND "status" = 'past_due'`, [row.tenantId]);
    await recordBillingEvent(pool, {
      billingAccountId: row.tenantId,
      kind: "suspended",
      source: "cron",
      payload: { pastDueSince: new Date(row.pastDueSince).toISOString(), graceDays: row.graceDays },
    });
    invalidateBillingResolution(row.tenantId);
    logger.warn({ tenantId: row.tenantId }, "[billing-cron] Konto gesperrt (Zahlungsstoerung ueber Karenz)");
  }
}

/** H4 — Stripe als Wahrheit fuer Einzelabos: Abweichungen heilen. */
async function reconcileWithStripe(): Promise<void> {
  if (!process.env.STRIPE_SECRET_KEY) return;
  const { getStripe } = await import("./stripe-client");
  const stripe = getStripe();
  const pool = getGatewayPool();
  const r = await pool.query<{ tenantId: string; stripeCustomerId: string; tier: string; cancelAtPeriodEnd: boolean; status: string; stripeSubscriptionId: string | null }>(
    `SELECT "tenantId", "stripeCustomerId", tier, "cancelAtPeriodEnd", "status", "stripeSubscriptionId"
       FROM "TenantBilling" WHERE "stripeCustomerId" IS NOT NULL AND "mode" IN ('subscription', 'none')`,
  );
  let geheilt = 0;
  for (const row of r.rows) {
    let subs;
    try {
      subs = await stripe.subscriptions.list({ customer: row.stripeCustomerId, status: "all", limit: 10 });
    } catch (err) {
      logger.warn({ tenantId: row.tenantId, err: err instanceof Error ? err.message : String(err) }, "[billing-cron] stripe list failed");
      continue;
    }
    const live = subs.data
      .filter((s) => s.status === "active" || s.status === "trialing" || s.status === "past_due" || s.status === "unpaid")
      .sort((a, b) => b.created - a.created)[0];
    if (!live) {
      if (row.tier !== "free" || row.stripeSubscriptionId) {
        await pool.query(
          `UPDATE "TenantBilling" SET tier = 'free', "mode" = 'none', "quotaLimit" = 25, "stripeSubscriptionId" = NULL, "periodEnd" = NULL,
                  "cancelAtPeriodEnd" = FALSE, "status" = 'active', "pastDueSince" = NULL, "suspendedAt" = NULL, "updatedAt" = NOW()
            WHERE "tenantId" = $1`,
          [row.tenantId],
        );
        await recordBillingEvent(pool, { billingAccountId: row.tenantId, kind: "reconciled_from_stripe", source: "cron", payload: { to: "free", reason: "no live subscription" } });
        invalidateBillingResolution(row.tenantId);
        geheilt++;
      }
      continue;
    }
    const priceId = live.items.data[0]?.price?.id ?? null;
    const tier = priceId ? tierFromPriceId(priceId) : null;
    if (!tier) continue;
    const cancel = (live as unknown as { cancel_at_period_end?: boolean }).cancel_at_period_end === true;
    const periodEndUnix = (live as unknown as { current_period_end?: number }).current_period_end ?? null;
    const status = live.status === "past_due" || live.status === "unpaid" ? (row.status === "suspended" ? "suspended" : "past_due") : "active";
    if (row.tier !== tier || row.cancelAtPeriodEnd !== cancel || row.stripeSubscriptionId !== live.id || row.status !== status) {
      await pool.query(
        `UPDATE "TenantBilling" SET tier = $2, "mode" = 'subscription', "quotaLimit" = $3, "stripeSubscriptionId" = $4, "periodEnd" = $5,
                "cancelAtPeriodEnd" = $6, "status" = $7, "pastDueSince" = CASE WHEN $7 = 'active' THEN NULL ELSE COALESCE("pastDueSince", NOW()) END,
                "suspendedAt" = CASE WHEN $7 = 'active' THEN NULL ELSE "suspendedAt" END, "updatedAt" = NOW()
          WHERE "tenantId" = $1`,
        [row.tenantId, tier, TIER_LIMITS[tier], live.id, periodEndUnix ? new Date(periodEndUnix * 1000) : null, cancel, status],
      );
      await recordBillingEvent(pool, {
        billingAccountId: row.tenantId,
        kind: "reconciled_from_stripe",
        source: "cron",
        payload: { from: { tier: row.tier, cancel: row.cancelAtPeriodEnd, status: row.status }, to: { tier, cancel, status }, subscriptionId: live.id },
      });
      invalidateBillingResolution(row.tenantId);
      geheilt++;
    }
  }
  logger.info({ konten: r.rowCount ?? 0, geheilt }, "[billing-cron] Stripe-Abgleich");
}

export function startBillingCron(): void {
  if (process.env.BILLING_CRON_DISABLED === "1") {
    logger.info("[billing-cron] deaktiviert (BILLING_CRON_DISABLED=1)");
    return;
  }
  const tick = () => void runBillingCronOnce().catch((err) => logger.warn({ err: err instanceof Error ? err.message : String(err) }, "[billing-cron] tick failed"));
  setTimeout(tick, 2 * 60_000).unref?.();
  setInterval(tick, INTERVAL_MS).unref?.();
  logger.info("[billing-cron] cron scheduled (stuendlich, erster Lauf in 2 Min)");
}

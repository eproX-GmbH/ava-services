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

import type { ZugangStand } from "./billing";
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
    const { bestandVerbuchen } = await import("./bestand");
    const b = await bestandVerbuchen(pool, now);
    if (b.konten > 0) logger.info(b, "[billing-cron] Bestand verbucht");
  } catch (err) {
    logger.warn({ err: err instanceof Error ? err.message : String(err) }, "[billing-cron] bestandVerbuchen failed");
  }
  try {
    await zugangUeberschreitungEinzelabo(now);
  } catch (err) {
    logger.warn({ err: err instanceof Error ? err.message : String(err) }, "[billing-cron] zugangUeberschreitung failed");
  }
  try {
    const { stripeRechnungenNachholen } = await import("./seat-billing");
    await stripeRechnungenNachholen(getGatewayPool());
  } catch (err) {
    logger.warn({ err: err instanceof Error ? err.message : String(err) }, "[billing-cron] Stripe-Rechnungen nachholen failed");
  }
  try {
    await suspendOverdue(now);
  } catch (err) {
    logger.warn({ err: err instanceof Error ? err.message : String(err) }, "[billing-cron] suspendOverdue failed");
  }
  const tag = now.toISOString().slice(0, 10);
  // 2026-10-15 — Apify-Laeufe, die beim Aufruf noch liefen: echte Kosten nachtragen.
  try {
    const { apifyFehlendeKostenNachtragen } = await import("./anbieter-kosten");
    const n = await apifyFehlendeKostenNachtragen(pool);
    if (n > 0) logger.info({ n }, "[billing-cron] Apify-Laufkosten nachgetragen");
  } catch (err) {
    logger.warn({ err: err instanceof Error ? err.message : String(err) }, "[billing-cron] Apify-Laufkosten failed");
  }
  if (now.getUTCHours() >= 3 && letzterAbgleichTag !== tag) {
    letzterAbgleichTag = tag;
    try {
      await reconcileWithStripe();
    } catch (err) {
      logger.warn({ err: err instanceof Error ? err.message : String(err) }, "[billing-cron] reconcile failed");
    }
    // Tatsaechliche Anbieterkosten (OpenAI Admin-API, Apify-Konto, Valueserp-Konto).
    try {
      const { anbieterAbgleich } = await import("./anbieter-kosten");
      await anbieterAbgleich(pool, now);
    } catch (err) {
      logger.warn({ err: err instanceof Error ? err.message : String(err) }, "[billing-cron] Anbieter-Abgleich failed");
    }
  }
}

/** Z4/Z7 — Einzelabos: Aufnahmen des Vormonats als Stripe-Rechnungsposten
 *  (landen auf der naechsten Abo-Rechnung). Buchhaltungssauber: je Stufe ein
 *  Posten mit Menge × Einzelpreis, Metadaten periodKey/stufe und Idempotenz-
 *  Schluessel; ein etwaiges Guthaben (Altvertraege, Env) als negativer Posten.
 *  Idempotent ueber BillingEvent kind zugang_ueberschreitung je Periode. */
async function zugangUeberschreitungEinzelabo(now: Date): Promise<void> {
  if (!process.env.STRIPE_SECRET_KEY) return;
  const pool = getGatewayPool();
  const vormonat = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() - 1, 1));
  const periodKey = `${vormonat.getUTCFullYear()}-${String(vormonat.getUTCMonth() + 1).padStart(2, "0")}`;
  const r = await pool.query<{ tenantId: string; stripeCustomerId: string; tier: string }>(
    `SELECT b."tenantId", b."stripeCustomerId", b.tier FROM "TenantBilling" b
      WHERE b."mode" = 'subscription' AND b."stripeCustomerId" IS NOT NULL AND b.tier IN ('starter', 'pro')
        AND NOT EXISTS (SELECT 1 FROM "BillingEvent" e WHERE e."billingAccountId" = b."tenantId" AND e.kind = 'zugang_ueberschreitung' AND e.payload->>'periodKey' = $1)`,
    [periodKey],
  );
  if (r.rows.length === 0) return;
  const { guthabenCents } = await import("./billing-plans");
  const { zugangStand } = await import("./billing");
  const { getStripe } = await import("./stripe-client");
  const stripe = getStripe();
  for (const row of r.rows) {
    const tier = row.tier as "starter" | "pro";
    const z = await zugangStand(pool, row.tenantId, periodKey, guthabenCents(tier));
    const aufnahmen = z.stufen.klein + z.stufen.mittel + z.stufen.gross;
    let stripeItemIds: string[] = [];
    if (z.ueberschreitungCents > 0) {
      try {
        stripeItemIds = await stufenPostenAnlegen(stripe, { customer: row.stripeCustomerId, tenantId: row.tenantId, periodKey, z });
      } catch (err) {
        logger.warn({ tenantId: row.tenantId, periodKey, err: err instanceof Error ? err.message : String(err) }, "[billing-cron] Stripe-Rechnungsposten fehlgeschlagen");
        continue;
      }
    }
    await recordBillingEvent(pool, {
      billingAccountId: row.tenantId,
      kind: "zugang_ueberschreitung",
      source: "cron",
      payload: { periodKey, aufnahmen, stufen: z.stufen, verbrauchtCents: z.verbrauchtCents, guthabenCents: z.guthabenCents, ueberschreitungCents: z.ueberschreitungCents, stripeItemIds },
    });
    if (z.ueberschreitungCents > 0) logger.info({ tenantId: row.tenantId, periodKey, cents: z.ueberschreitungCents, posten: stripeItemIds.length }, "[billing-cron] Aufnahmen des Vormonats berechnet");
  }
}

/** Z7 — Stripe-Rechnungsposten je Stufe (Menge × Einzelpreis) fuer eine Periode.
 *  `invoice` gesetzt: Posten haengen an genau dieser Rechnung (Seats); sonst
 *  landen sie auf der naechsten Abo-Rechnung des Kunden (Einzelabo). Der
 *  Idempotenz-Schluessel verhindert doppelte Posten bei Wiederholungen. */
export async function stufenPostenAnlegen(
  stripe: import("stripe").default,
  p: { customer: string; tenantId: string; periodKey: string; z: ZugangStand; invoice?: string },
): Promise<string[]> {
  const preise = (await import("./stufen")).stufenPreise();
  const ids: string[] = [];
  const stufen: Array<{ stufe: "klein" | "mittel" | "gross"; label: string }> = [
    { stufe: "klein", label: "Aufnahme klein (ohne LinkedIn-Firmenprofil)" },
    { stufe: "mittel", label: "Aufnahme mittel (LinkedIn-Profil, bis 100 Personen)" },
    { stufe: "gross", label: "Aufnahme gross (LinkedIn-Profil, ueber 100 Personen)" },
  ];
  for (const s of stufen) {
    const n = p.z.stufen[s.stufe];
    if (n <= 0) continue;
    const unit = preise[s.stufe].preisCents;
    const item = await stripe.invoiceItems.create(
      {
        customer: p.customer,
        ...(p.invoice ? { invoice: p.invoice } : {}),
        currency: "eur",
        quantity: n,
        unit_amount: unit,
        description: `AVA ${s.label}, ${p.periodKey}: ${n} × ${(unit / 100).toFixed(2)} EUR`,
        metadata: { tenantId: p.tenantId, periodKey: p.periodKey, stufe: s.stufe, art: "aufnahme" },
      },
      { idempotencyKey: `ava-aufnahme-${p.tenantId}-${p.periodKey}-${s.stufe}` },
    );
    ids.push(item.id);
  }
  // Altvertraege mit Guthaben: enthaltener Anteil als Abzug, damit die Posten die
  // tatsaechlichen Aufnahmen zeigen und die Summe trotzdem stimmt.
  const abzug = p.z.verbrauchtCents - p.z.ueberschreitungCents;
  if (abzug > 0) {
    const item = await stripe.invoiceItems.create(
      {
        customer: p.customer,
        ...(p.invoice ? { invoice: p.invoice } : {}),
        currency: "eur",
        amount: -abzug,
        description: `AVA enthaltenes Zugangsguthaben, ${p.periodKey}`,
        metadata: { tenantId: p.tenantId, periodKey: p.periodKey, art: "guthaben" },
      },
      { idempotencyKey: `ava-guthaben-${p.tenantId}-${p.periodKey}` },
    );
    ids.push(item.id);
  }
  return ids;
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

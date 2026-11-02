// docs/PLAN_PRICING_TIERS.md P3 (2026-11-02) — Stripe fuer das Sitz-Modell.
//
// Ein Stripe-Kunde und EIN Abo je Organisation; je Plan (pro | max | ultra) eine
// Abo-Position, deren Menge der Zahl der laufenden, nicht zur Reduktion
// vorgemerkten Sitze entspricht. Regeln (Vorbild Claude Team / ChatGPT Business):
//   - Sitz dazu  → Menge hoch mit Proration (sofort, anteilig berechnet).
//   - Reduktion  → Menge sofort runter OHNE Proration: bezahlt bis Zyklusende,
//                  keine Erstattung; die Sitz-Zeile endet per Cron zum Zyklusende.
//   - Widerruf   → Menge wieder hoch OHNE Proration (schon bezahlt).
//   - Webhook    → Mengen je Plan mit der Sitz-Tabelle abgleichen (mehr Menge als
//                  Sitze → freie Sitze anlegen; weniger → freie Sitze beenden, nie
//                  zugewiesene).
// Erster Kauf ohne Abo laeuft ueber Checkout (Zahlungsmittel + erste Sitze);
// der Webhook legt dann die Sitze an.

import type Stripe from "stripe";
import type pg from "pg";
import { randomUUID } from "node:crypto";
import { getStripe } from "./stripe-client";
import { logger } from "./logger";
import { readBillingAccount, invalidateBillingResolution } from "./billing";
import { priceIdForTier, SITZ_PLAENE, type SitzPlan } from "./billing-plans";
import { recordBillingEvent } from "./billing-events";
import { sitzeLesen } from "./sitze";

type Q = { query: pg.Pool["query"] };

export function stripeKonfiguriert(): boolean {
  return Boolean(process.env.STRIPE_SECRET_KEY);
}

/** Gewuenschte Mengen je Plan aus der Sitz-Tabelle (laufend, nicht zur Reduktion vorgemerkt). */
export async function gewuenschteMengen(q: Q, tenantId: string): Promise<Record<SitzPlan, number>> {
  const sitze = await sitzeLesen(q, tenantId);
  const m: Record<SitzPlan, number> = { pro: 0, max: 0, ultra: 0 };
  for (const s of sitze) if (!s.reduziertZum) m[s.plan] += 1;
  return m;
}

function planVonPreis(priceId: string | null): SitzPlan | null {
  if (!priceId) return null;
  for (const p of SITZ_PLAENE) if (priceIdForTier(p) === priceId) return p;
  return null;
}

/** Abo-Positionen mit Stripe abgleichen. Ohne Abo (noch kein Checkout) passiert nichts. */
export async function sitzeStripeSyncAusfuehren(
  q: Q,
  tenantId: string,
  opts: { proration: "create_prorations" | "none" } = { proration: "create_prorations" },
): Promise<void> {
  if (!stripeKonfiguriert()) return;
  const acc = await readBillingAccount(q, tenantId);
  if (!acc?.stripeSubscriptionId) return;
  const stripe = getStripe();
  const sub = await stripe.subscriptions.retrieve(acc.stripeSubscriptionId, { expand: ["items.data.price"] });
  if (sub.status === "canceled" || sub.status === "incomplete_expired") return;
  const soll = await gewuenschteMengen(q, tenantId);
  const vorhanden = new Map<SitzPlan, Stripe.SubscriptionItem>();
  for (const it of sub.items.data) {
    const plan = planVonPreis(it.price?.id ?? null);
    if (plan) vorhanden.set(plan, it);
  }
  for (const plan of SITZ_PLAENE) {
    const item = vorhanden.get(plan);
    const menge = soll[plan];
    const priceId = priceIdForTier(plan);
    if (!priceId) continue;
    if (item && item.quantity === menge) continue;
    if (item && menge === 0) {
      // Letzte Position darf nicht geloescht werden (Abo braucht eine); dann Menge 0 nicht moeglich → Position behalten, Menge 1? Nein:
      // Stripe erlaubt kein Abo ohne Position; wir loeschen nur, wenn eine andere bleibt.
      const andere = sub.items.data.some((o) => o.id !== item.id && (planVonPreis(o.price?.id ?? null) ?? null) !== null && soll[planVonPreis(o.price?.id ?? null)!] > 0);
      if (andere) await stripe.subscriptionItems.del(item.id, { proration_behavior: opts.proration === "none" ? "none" : "create_prorations" });
      else await stripe.subscriptionItems.update(item.id, { quantity: 0, proration_behavior: opts.proration }).catch(async () => {
        // Falls Menge 0 abgelehnt wird: Abo zum Periodenende kuendigen.
        await stripe.subscriptions.update(sub.id, { cancel_at_period_end: true });
      });
      continue;
    }
    if (item) {
      const hoch = menge > (item.quantity ?? 0);
      await stripe.subscriptionItems.update(item.id, { quantity: menge, proration_behavior: hoch ? opts.proration : "none" });
    } else if (menge > 0) {
      await stripe.subscriptionItems.create({ subscription: sub.id, price: priceId, quantity: menge, proration_behavior: opts.proration });
    }
  }
  if (sub.cancel_at_period_end && Object.values(soll).some((n) => n > 0)) {
    await stripe.subscriptions.update(sub.id, { cancel_at_period_end: false });
  }
  logger.info({ tenantId, soll }, "[sitze-stripe] Mengen abgeglichen");
}

/** Checkout fuer die ersten Sitze (Zahlungsmittel der Organisation + Abo). */
export async function sitzeCheckout(
  q: Q,
  args: { tenantId: string; actorId: string; plan: SitzPlan; anzahl: number; rueckkehr: "app" | "konsole"; email?: string | null },
): Promise<{ url: string; sessionId: string }> {
  const stripe = getStripe();
  const priceId = priceIdForTier(args.plan);
  if (!priceId) throw new Error(`stripe price id fuer ${args.plan} fehlt (STRIPE_PRICE_${args.plan.toUpperCase()})`);
  const acc = await readBillingAccount(q, args.tenantId);
  const konsole = (process.env.ADMIN_KONSOLE_URL ?? "https://admin.ava.bi").replace(/\/+$/, "");
  const success = args.rueckkehr === "konsole" ? `${konsole}/abrechnung?checkout=ok&session_id={CHECKOUT_SESSION_ID}` : "ava://billing/success?session_id={CHECKOUT_SESSION_ID}";
  const cancel = args.rueckkehr === "konsole" ? `${konsole}/abrechnung?checkout=abgebrochen` : "ava://billing/cancel";
  const params: Stripe.Checkout.SessionCreateParams = {
    mode: "subscription",
    line_items: [{ price: priceId, quantity: args.anzahl }],
    client_reference_id: args.tenantId,
    metadata: { tenantId: args.tenantId, sitze: "1", plan: args.plan, anzahl: String(args.anzahl), von: args.actorId },
    subscription_data: { metadata: { tenantId: args.tenantId, sitze: "1" } },
    automatic_tax: { enabled: true },
    success_url: success,
    cancel_url: cancel,
    ...(acc?.stripeCustomerId ? { customer: acc.stripeCustomerId } : args.email ? { customer_email: args.email } : {}),
  };
  const session = await stripe.checkout.sessions.create(params);
  await recordBillingEvent(q, { billingAccountId: args.tenantId, kind: "sitze_checkout_gestartet", source: "admin", actorId: args.actorId, payload: { sessionId: session.id, plan: args.plan, anzahl: args.anzahl } });
  return { url: session.url ?? "", sessionId: session.id };
}

/** Vorschau: Was kostet es heute, `anzahl` Sitze eines Plans dazuzunehmen? (anteilig bis Zyklusende) */
export async function sitzeVorschau(
  q: Q,
  args: { tenantId: string; plan: SitzPlan; anzahl: number },
): Promise<{ heuteCents: number; jeMonatCents: number; periodEnd: string | null; anteilig: boolean }> {
  const { planEintrag } = await import("./billing-plans");
  const jeMonat = (planEintrag(args.plan).preisCents ?? 0) * args.anzahl;
  const acc = await readBillingAccount(q, args.tenantId);
  if (!stripeKonfiguriert() || !acc?.stripeSubscriptionId) return { heuteCents: jeMonat, jeMonatCents: jeMonat, periodEnd: null, anteilig: false };
  const stripe = getStripe();
  const sub = await stripe.subscriptions.retrieve(acc.stripeSubscriptionId);
  const priceId = priceIdForTier(args.plan);
  if (!priceId) return { heuteCents: jeMonat, jeMonatCents: jeMonat, periodEnd: null, anteilig: false };
  const item = sub.items.data.find((it) => it.price?.id === priceId);
  const items: Stripe.InvoiceCreatePreviewParams.SubscriptionDetails.Item[] = item
    ? [{ id: item.id, quantity: (item.quantity ?? 0) + args.anzahl }]
    : [{ price: priceId, quantity: args.anzahl }];
  const preview = await stripe.invoices.createPreview({
    customer: typeof sub.customer === "string" ? sub.customer : sub.customer.id,
    subscription: sub.id,
    subscription_details: { items, proration_behavior: "create_prorations", proration_date: Math.floor(Date.now() / 1000) },
  });
  // Nur die Proration-Zeilen zaehlen (die Vorschau enthaelt auch die naechste regulaere Rechnung).
  const heute = preview.lines.data.filter((l) => (l as { proration?: boolean }).proration).reduce((s, l) => s + l.amount, 0);
  const periodEndUnix = (sub as unknown as { current_period_end?: number }).current_period_end ?? null;
  return { heuteCents: Math.max(0, heute), jeMonatCents: jeMonat, periodEnd: periodEndUnix ? new Date(periodEndUnix * 1000).toISOString() : null, anteilig: true };
}

/** Webhook: Mengen eines Sitz-Abos mit der Sitz-Tabelle abgleichen und das Organisationskonto setzen. */
export async function sitzeAusStripeAbgleichen(
  pool: pg.Pool,
  args: { tenantId: string; customerId: string; sub: Stripe.Subscription; eventCreated: number; status: "active" | "past_due" | "suspended" | "canceled" },
): Promise<void> {
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    const periodEndUnix = (args.sub as unknown as { current_period_end?: number }).current_period_end ?? null;
    await client.query(
      `INSERT INTO "TenantBilling" ("tenantId", "kind", "mode", tier, "quotaLimit", "stripeCustomerId", "stripeSubscriptionId", "periodEnd", "status", "lastStripeEventAt", "updatedAt", "createdAt")
       VALUES ($1, 'organisation', 'sitze', 'free', -1, $2, $3, $4, $5, to_timestamp($6), NOW(), NOW())
       ON CONFLICT ("tenantId") DO UPDATE SET "mode" = CASE WHEN "TenantBilling"."mode" = 'enterprise' THEN 'enterprise' ELSE 'sitze' END, "kind" = 'organisation',
         "stripeCustomerId" = EXCLUDED."stripeCustomerId", "stripeSubscriptionId" = EXCLUDED."stripeSubscriptionId", "periodEnd" = EXCLUDED."periodEnd",
         "status" = EXCLUDED."status", "cancelAtPeriodEnd" = $7, "lastStripeEventAt" = EXCLUDED."lastStripeEventAt", "updatedAt" = NOW()`,
      [args.tenantId, args.customerId, args.sub.id, periodEndUnix ? new Date(periodEndUnix * 1000) : null, args.status, args.eventCreated, Boolean((args.sub as unknown as { cancel_at_period_end?: boolean }).cancel_at_period_end)],
    );
    const sitze = await sitzeLesen(client, args.tenantId);
    for (const plan of SITZ_PLAENE) {
      const priceId = priceIdForTier(plan);
      const item = args.sub.items.data.find((it) => it.price?.id === priceId);
      const menge = args.status === "canceled" ? 0 : item?.quantity ?? 0;
      const aktiv = sitze.filter((s) => s.plan === plan && !s.reduziertZum);
      if (menge > aktiv.length) {
        for (let i = aktiv.length; i < menge; i++) {
          await client.query(`INSERT INTO "Sitz" ("id", "tenantId", "plan", "stripeItemId") VALUES ($1, $2, $3, $4)`, [randomUUID(), args.tenantId, plan, item?.id ?? null]);
        }
      } else if (menge < aktiv.length) {
        // Zu viele: freie Sitze beenden (neueste zuerst), zugewiesene bleiben (werden nachberechnet, nie still entzogen).
        const frei = aktiv.filter((s) => !s.actorId).sort((a, b) => (b.zugewiesenAm?.getTime() ?? 0) - (a.zugewiesenAm?.getTime() ?? 0));
        for (const s of frei.slice(0, aktiv.length - menge)) await client.query(`UPDATE "Sitz" SET "endetAm" = NOW() WHERE "id" = $1`, [s.id]);
      }
      if (item) await client.query(`UPDATE "Sitz" SET "stripeItemId" = $2 WHERE "tenantId" = $1 AND "plan" = $3 AND "endetAm" IS NULL AND "stripeItemId" IS NULL`, [args.tenantId, item.id, plan]);
    }
    await recordBillingEvent(client, { billingAccountId: args.tenantId, kind: "sitze_stripe_abgeglichen", source: "webhook", payload: { subscriptionId: args.sub.id, status: args.status, mengen: Object.fromEntries(args.sub.items.data.map((it) => [planVonPreis(it.price?.id ?? null) ?? it.price?.id, it.quantity])) } });
    await client.query("COMMIT");
    invalidateBillingResolution(args.tenantId);
  } catch (err) {
    await client.query("ROLLBACK").catch(() => undefined);
    throw err;
  } finally {
    client.release();
  }
}

/** Ist dieses Abo ein Sitz-Abo der Organisation? (Metadaten oder Preise der Sitzplaene) */
export function istSitzAbo(sub: Stripe.Subscription): boolean {
  if (sub.metadata?.sitze === "1") return true;
  return sub.items.data.some((it) => planVonPreis(it.price?.id ?? null) === "max" || planVonPreis(it.price?.id ?? null) === "ultra");
}

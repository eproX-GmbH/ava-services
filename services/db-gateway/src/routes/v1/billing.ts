// M3 — Stripe Checkout + Customer Portal + webhook.
//
// Three routes, two trust models:
//   POST /v1/billing/checkout   — auth required (tenant from JWT)
//   POST /v1/billing/portal     — auth required (tenant from JWT)
//   POST /v1/billing/webhook    — NO AUTH; signature-verified instead.
//                                  Mounted SEPARATELY at app-level (see
//                                  index.ts) so the v1 auth middleware
//                                  doesn't intercept it AND so we read
//                                  the raw body for signature checks.
//
// Idempotency: every webhook handler is a SQL UPSERT keyed by
// `tenantId`. Stripe retries until 2xx; replaying the same event is a
// no-op.

import { OpenAPIHono, createRoute, z } from "@hono/zod-openapi";
import { HTTPException } from "hono/http-exception";
// v0.1.158 — non-type-only because the stale-customer probe needs
// Stripe.errors.StripeInvalidRequestError at runtime.
import Stripe from "stripe";
import { getStripe, getStripeWebhookSecret } from "../../lib/stripe-client";
import { getGatewayPool } from "../../lib/producer-pools";
import { logger } from "../../lib/logger";
import {
  TIER_LIMITS,
  priceIdForTier,
  tierFromPriceId,
  type PaidTier,
} from "../../lib/billing-plans";
import { type BillingTier, readBillingAccount, invalidateBillingResolution } from "../../lib/billing";
import { recordBillingEvent } from "../../lib/billing-events";

// =============================================================================
// Authed router — checkout + portal. Mounted in v1.ts behind the standard
// auth/rate-limit/audit chain.
// =============================================================================

export const billingRouter = new OpenAPIHono();

const CheckoutBody = z.object({ tier: z.enum(["starter", "pro"]) });
// Response can be one of two shapes:
//  (a) Checkout URL — tenant has no existing subscription, the
//      renderer opens this in the system browser to complete payment.
//  (b) In-place upgrade — tenant already has an active or
//      cancel-at-period-end subscription; the gateway updated its
//      items directly via Stripe Subscriptions API. The renderer
//      should refresh the usage snapshot; no URL to open.
// Both shapes share `sessionId` (empty string for the in-place case)
// so the existing renderer type narrows cleanly. New `upgraded` flag
// signals the in-place path so the renderer can show a confirmation
// toast instead of opening a browser tab.
const CheckoutResponse = z.object({
  url: z.string(),  // empty string when upgraded=true
  sessionId: z.string(),
  upgraded: z.boolean().optional(),
});
const PortalResponse = z.object({ url: z.string().url() });

const checkoutRoute = createRoute({
  method: "post",
  path: "/billing/checkout",
  tags: ["billing"],
  summary: "Start a Stripe Checkout session for a paid tier",
  request: {
    body: { content: { "application/json": { schema: CheckoutBody } }, required: true },
  },
  responses: {
    200: { content: { "application/json": { schema: CheckoutResponse } }, description: "checkout url" },
    401: { description: "unauthenticated", content: { "application/json": { schema: z.object({ error: z.string() }) } } },
    503: { description: "stripe not configured", content: { "application/json": { schema: z.object({ error: z.string() }) } } },
  },
});

billingRouter.openapi(checkoutRoute, async (c) => {
  const auth = c.get("auth");
  if (!auth?.tenantId) throw new HTTPException(401, { message: "auth_context_missing" });
  const { tier } = c.req.valid("json");

  const priceId = priceIdForTier(tier);
  if (!priceId) {
    throw new HTTPException(503, { message: `stripe price id not configured for tier=${tier}` });
  }

  // B1 — Einzelabo haengt am PERSOENLICHEN Abrechnungskonto (actorId),
  // auch wenn der Daten-Tenant eine Organisation ist. Mitglieder, deren
  // Zugang die Organisation bezahlt, brauchen kein eigenes Abo.
  const billingAccountId = auth.actorId;
  const orgAcc = auth.tenantId !== auth.actorId ? await readBillingAccount(getGatewayPool(), auth.tenantId) : null;
  if (orgAcc && (orgAcc.mode === "seats" || orgAcc.mode === "enterprise")) {
    throw new HTTPException(409, { message: "Dein Zugang wird von deiner Organisation bezahlt. Ein eigenes Abo ist nicht noetig." });
  }

  const stripe = getStripe();
  let existing = await readStripeCustomerId(billingAccountId);

  // v0.1.158 — defend against a stale `stripeCustomerId`. The most
  // common path that triggers this: STRIPE_SECRET_KEY was rotated
  // from a test-mode key to a live-mode key. Test and live customers
  // live in entirely separate namespaces, so the DB-stored id no
  // longer resolves and EVERY operation that passes it (subscriptions
  // list, checkout-session create with `customer`, …) returns 400
  // `resource_missing` and the desktop user sees `gateway 500`.
  //
  // Resolution: probe the customer once; if Stripe says "missing",
  // wipe the column and fall through to the fresh-customer path
  // (Checkout creates a brand-new customer, the webhook persists the
  // new id). Surface a single log line so the operator can spot the
  // rotation aftermath in the gateway log.
  if (existing) {
    const stillValid = await stripeCustomerExists(stripe, existing);
    if (!stillValid) {
      logger.warn(
        { billingAccountId, staleCustomerId: existing },
        "stale stripeCustomerId — wiping and falling through to fresh-customer checkout",
      );
      await clearStripeCustomerId(billingAccountId);
      existing = null;
    }
  }

  // Pre-v0.1.118: every checkout call minted a NEW Subscription, even
  // when the customer already had an active or cancel-at-period-end
  // one. Result: a tenant who "upgraded" Starter → Pro by hitting our
  // checkout button ended up with TWO active Stripe subscriptions
  // running in parallel until the old one's period actually expired.
  //
  // Fix: when the tenant already has a usable subscription, update its
  // items in-place (with prorations) instead of opening Checkout. The
  // existing webhook handler on `customer.subscription.updated` will
  // pick up the tier change and update TenantBilling. Cancellation
  // requests still go through the Customer Portal — this path is
  // strictly for tier-switch / re-activation.
  if (existing) {
    const existingSub = await findUsableSubscription(stripe, existing);
    if (existingSub) {
      const currentItem = existingSub.items.data[0];
      const currentPrice = currentItem?.price?.id ?? null;
      // No-op: same price + not cancelling. Surface a clear error so
      // the renderer can show "Du bist bereits auf diesem Tarif".
      if (currentPrice === priceId && !existingSub.cancel_at_period_end) {
        throw new HTTPException(409, {
          message: "already on this tier",
        });
      }
      const updated = await stripe.subscriptions.update(existingSub.id, {
        items: [{ id: currentItem.id, price: priceId }],
        // Prorate upgrades + downgrades on the same billing cycle.
        // Stripe credits unused time on the old plan and charges the
        // pro-rated new plan amount on the next invoice.
        proration_behavior: "create_prorations",
        // Clear any scheduled cancellation — the tenant explicitly
        // chose a new plan, so they're not cancelling anymore.
        cancel_at_period_end: false,
        metadata: { tenantId: billingAccountId },
      });
      await recordBillingEvent(getGatewayPool(), {
        billingAccountId,
        kind: "checkout_inplace_update",
        source: "admin",
        actorId: auth.actorId,
        payload: { subscriptionId: existingSub.id, fromPrice: currentPrice, toPrice: priceId, tier },
      });
      logger.info(
        {
          billingAccountId,
          subscriptionId: existingSub.id,
          fromPrice: currentPrice,
          toPrice: priceId,
          cancelAtPeriodEndCleared: existingSub.cancel_at_period_end,
        },
        "stripe subscription updated in place (no Checkout)",
      );
      // The renderer expects a CheckoutResponse-shaped object; pack
      // upgraded=true with empty url + sub id as the session id.
      return c.json(
        { url: "", sessionId: updated.id, upgraded: true },
        200,
      );
    }
  }

  // No existing subscription → original Checkout path.
  const params: Stripe.Checkout.SessionCreateParams = {
    mode: "subscription",
    line_items: [{ price: priceId, quantity: 1 }],
    client_reference_id: billingAccountId,
    metadata: { tenantId: billingAccountId },
    subscription_data: {
      metadata: { tenantId: billingAccountId },
    },
    automatic_tax: { enabled: true },
    success_url: "ava://billing/success?session_id={CHECKOUT_SESSION_ID}",
    cancel_url: "ava://billing/cancel",
  };
  if (existing) params.customer = existing;

  const session = await stripe.checkout.sessions.create(params);
  await recordBillingEvent(getGatewayPool(), {
    billingAccountId,
    kind: "checkout_started",
    source: "admin",
    actorId: auth.actorId,
    payload: { sessionId: session.id, tier },
  });
  return c.json({ url: session.url ?? "", sessionId: session.id }, 200);
});

/**
 * Pick the most relevant existing subscription for a Stripe customer
 * so we can in-place upgrade rather than minting a duplicate.
 * Preference order:
 *   1. status='active'
 *   2. status='trialing'
 *   3. status='past_due'  (treat as "ours to upgrade" — Stripe lets us)
 *   4. status='active' WITH cancel_at_period_end=true (scheduled cancel)
 * We deliberately ignore status='canceled' and status='incomplete' —
 * those are dead/abandoned subscriptions that shouldn't be reanimated
 * (Checkout will replace them).
 */
async function findUsableSubscription(
  stripe: ReturnType<typeof getStripe>,
  customerId: string,
): Promise<Stripe.Subscription | null> {
  const all = await stripe.subscriptions.list({
    customer: customerId,
    status: "all",
    limit: 20,
    expand: ["data.items.data.price"],
  });
  const score = (s: Stripe.Subscription): number => {
    if (s.status === "active" && !s.cancel_at_period_end) return 100;
    if (s.status === "trialing") return 90;
    if (s.status === "past_due") return 80;
    if (s.status === "active" && s.cancel_at_period_end) return 70;
    return 0;  // canceled / incomplete / unpaid / paused
  };
  const candidates = all.data
    .map((s) => ({ s, score: score(s) }))
    .filter((x) => x.score > 0)
    .sort((a, b) => b.score - a.score || b.s.created - a.s.created);
  return candidates[0]?.s ?? null;
}

const portalRoute = createRoute({
  method: "post",
  path: "/billing/portal",
  tags: ["billing"],
  summary: "Open the Stripe Customer Portal for the calling tenant",
  responses: {
    200: { content: { "application/json": { schema: PortalResponse } }, description: "portal url" },
    400: { description: "no stripe customer for tenant", content: { "application/json": { schema: z.object({ error: z.string() }) } } },
    401: { description: "unauthenticated", content: { "application/json": { schema: z.object({ error: z.string() }) } } },
  },
});

billingRouter.openapi(portalRoute, async (c) => {
  const auth = c.get("auth");
  if (!auth?.tenantId) throw new HTTPException(401, { message: "auth_context_missing" });

  const customerId = await readStripeCustomerId(auth.actorId);
  if (!customerId) {
    throw new HTTPException(400, { message: "no stripe customer; complete a checkout first" });
  }

  const session = await getStripe().billingPortal.sessions.create({
    customer: customerId,
    return_url: "ava://billing/portal-return",
  });
  return c.json({ url: session.url }, 200);
});

// =============================================================================
// Webhook router — exported separately. Mounted at app-level in index.ts so
// it bypasses v1's auth middleware and we can read the raw body before any
// JSON parsing kicks in.
// =============================================================================

export const billingWebhookRouter = new OpenAPIHono();

billingWebhookRouter.post("/v1/billing/webhook", async (c) => {
  const sigHeader = c.req.header("stripe-signature");
  if (!sigHeader) return c.text("missing stripe-signature", 400);

  const raw = await c.req.text();

  let event: Stripe.Event;
  try {
    const stripe = getStripe();
    event = stripe.webhooks.constructEvent(raw, sigHeader, getStripeWebhookSecret());
  } catch (err) {
    logger.warn(
      { err: err instanceof Error ? err.message : String(err) },
      "stripe webhook signature verification failed",
    );
    return c.text("invalid signature", 400);
  }

  // B1 H2 — Dedupe: Stripe wiederholt Events bis 2xx; ein bereits
  // verarbeitetes Event ist ein No-op. INSERT … ON CONFLICT liefert nur
  // fuer den Erstverarbeiter eine Zeile.
  try {
    const ins = await getGatewayPool().query(
      `INSERT INTO "StripeEvent" ("id", "type", "created") VALUES ($1, $2, to_timestamp($3)) ON CONFLICT ("id") DO NOTHING`,
      [event.id, event.type, event.created],
    );
    if ((ins.rowCount ?? 0) === 0) {
      logger.info({ eventId: event.id, eventType: event.type }, "stripe webhook duplicate — ignored");
      return c.text("ok (duplicate)", 200);
    }
  } catch (err) {
    // Tabelle fehlt (Migration ausstehend) → ohne Dedupe weiter.
    logger.warn({ err: err instanceof Error ? err.message : String(err) }, "stripe event dedupe unavailable");
  }

  try {
    await handleStripeEvent(event);
  } catch (err) {
    logger.error(
      { err: err instanceof Error ? err.message : String(err), eventType: event.type, eventId: event.id },
      "stripe webhook handler failed",
    );
    // Returning 500 makes Stripe retry — but only for genuine errors. We
    // already swallow handler-side "expected" misses (unknown price id,
    // missing tenantId) inside handleStripeEvent.
    return c.text("handler error", 500);
  }
  return c.text("ok", 200);
});

async function handleStripeEvent(event: Stripe.Event): Promise<void> {
  switch (event.type) {
    case "checkout.session.completed": {
      const session = event.data.object as Stripe.Checkout.Session;
      const tenantId = (session.metadata?.tenantId as string | undefined) ?? session.client_reference_id ?? null;
      const customerId = typeof session.customer === "string" ? session.customer : session.customer?.id ?? null;
      if (!tenantId || !customerId) {
        logger.warn({ eventId: event.id }, "checkout.session.completed missing tenantId/customerId");
        return;
      }
      await upsertCustomerLink(tenantId, customerId);
      await recordBillingEvent(getGatewayPool(), {
        billingAccountId: tenantId,
        kind: "checkout_completed",
        source: "webhook",
        stripeEventId: event.id,
        payload: { sessionId: session.id, customerId, mode: session.mode },
      });
      logger.info({ tenantId, customerId }, "stripe checkout completed");
      return;
    }
    case "customer.subscription.created":
    case "customer.subscription.updated": {
      const sub = event.data.object as Stripe.Subscription;
      const customerId = typeof sub.customer === "string" ? sub.customer : sub.customer.id;
      let tenantId = (sub.metadata?.tenantId as string | undefined) ?? null;
      if (!tenantId) tenantId = await readTenantIdByCustomer(customerId);
      if (!tenantId) {
        logger.warn({ eventId: event.id, customerId }, "subscription event has no tenantId mapping");
        return;
      }
      const priceId = sub.items.data[0]?.price?.id ?? null;
      const tier: PaidTier | null = priceId ? tierFromPriceId(priceId) : null;
      if (!tier) {
        logger.warn({ eventId: event.id, priceId }, "unknown price id; skipping tier flip");
        return;
      }
      const periodEndUnix = (sub as unknown as { current_period_end?: number }).current_period_end ?? null;
      const periodEnd = periodEndUnix ? new Date(periodEndUnix * 1000) : null;
      const cancelAtPeriodEnd = (sub as unknown as { cancel_at_period_end?: boolean }).cancel_at_period_end === true;
      // B1 H2 — Reihenfolge: ein aelteres Event darf einen neueren Stand
      // nicht ueberschreiben (Stripe garantiert keine Zustellreihenfolge).
      if (await isStaleEvent(tenantId, event)) {
        logger.warn({ eventId: event.id, tenantId, created: event.created }, "stripe event older than last applied — ignored");
        return;
      }
      const vorher = await readBillingAccount(getGatewayPool(), tenantId);
      // B1 H3 — Abo-Status → Kontozustand (Smart Retries laufen bei Stripe).
      const status = subscriptionStatusToAccountStatus(sub.status, vorher?.status ?? "active");
      await upsertSubscriptionState({
        tenantId,
        customerId,
        subscriptionId: sub.id,
        tier,
        quotaLimit: TIER_LIMITS[tier],
        periodEnd,
        cancelAtPeriodEnd,
        status,
        eventCreated: event.created,
      });
      await recordBillingEvent(getGatewayPool(), {
        billingAccountId: tenantId,
        kind: event.type === "customer.subscription.created" ? "subscription_created" : "subscription_updated",
        source: "webhook",
        stripeEventId: event.id,
        payload: { tier, from: vorher?.tier ?? null, subscriptionId: sub.id, stripeStatus: sub.status, status, cancelAtPeriodEnd, periodEnd: periodEnd?.toISOString() ?? null },
      });
      invalidateBillingResolution(tenantId);
      logger.info({ tenantId, tier, subscriptionId: sub.id, status }, "stripe subscription state synced");
      // Q-track v0.1.137 — Tier flip may have created fresh headroom.
      // Fire-and-forget the resume-worker; it dedupes via in-flight set.
      await resumeForBillingAccount(tenantId);
      return;
    }
    case "customer.subscription.deleted": {
      const sub = event.data.object as Stripe.Subscription;
      const customerId = typeof sub.customer === "string" ? sub.customer : sub.customer.id;
      let tenantId = (sub.metadata?.tenantId as string | undefined) ?? null;
      if (!tenantId) tenantId = await readTenantIdByCustomer(customerId);
      if (!tenantId) {
        logger.warn({ eventId: event.id, customerId }, "subscription.deleted has no tenantId mapping");
        return;
      }
      if (await isStaleEvent(tenantId, event)) {
        logger.warn({ eventId: event.id, tenantId }, "stripe subscription.deleted older than last applied — ignored");
        return;
      }
      await downgradeToFree(tenantId, event.created);
      await recordBillingEvent(getGatewayPool(), {
        billingAccountId: tenantId,
        kind: "subscription_deleted",
        source: "webhook",
        stripeEventId: event.id,
        payload: { subscriptionId: sub.id },
      });
      invalidateBillingResolution(tenantId);
      logger.info({ tenantId }, "stripe subscription deleted; downgraded to free");
      return;
    }
    case "invoice.payment_failed": {
      // B1 H3 — Zahlungsstoerung: past_due ab dem ersten Fehlschlag; die
      // Sperre (suspended) setzt der Billing-Cron nach graceDays (K7).
      const inv = event.data.object as Stripe.Invoice;
      const customerId = typeof inv.customer === "string" ? inv.customer : inv.customer?.id ?? null;
      const tenantId = customerId ? await readTenantIdByCustomer(customerId) : null;
      if (!tenantId) {
        logger.warn({ eventId: event.id, invoiceId: inv.id, customer: inv.customer }, "invoice.payment_failed without tenant mapping");
        return;
      }
      await getGatewayPool().query(
        `UPDATE "TenantBilling" SET "status" = 'past_due', "pastDueSince" = COALESCE("pastDueSince", NOW()), "updatedAt" = NOW()
          WHERE "tenantId" = $1 AND "status" IN ('active', 'past_due')`,
        [tenantId],
      );
      await recordBillingEvent(getGatewayPool(), {
        billingAccountId: tenantId,
        kind: "payment_failed",
        source: "webhook",
        stripeEventId: event.id,
        payload: { invoiceId: inv.id, amountDue: inv.amount_due, attemptCount: inv.attempt_count },
      });
      logger.warn({ eventId: event.id, invoiceId: inv.id, tenantId }, "stripe invoice payment failed → past_due");
      return;
    }
    case "invoice.paid": {
      const inv = event.data.object as Stripe.Invoice;
      const customerId = typeof inv.customer === "string" ? inv.customer : inv.customer?.id ?? null;
      const tenantId = customerId ? await readTenantIdByCustomer(customerId) : null;
      if (!tenantId) return;
      const r = await getGatewayPool().query(
        `UPDATE "TenantBilling" SET "status" = 'active', "pastDueSince" = NULL, "suspendedAt" = NULL, "updatedAt" = NOW()
          WHERE "tenantId" = $1 AND "status" IN ('past_due', 'suspended')`,
        [tenantId],
      );
      await recordBillingEvent(getGatewayPool(), {
        billingAccountId: tenantId,
        kind: "invoice_paid",
        source: "webhook",
        stripeEventId: event.id,
        payload: { invoiceId: inv.id, amountPaid: inv.amount_paid, reactivated: (r.rowCount ?? 0) > 0 },
      });
      if ((r.rowCount ?? 0) > 0) {
        logger.info({ tenantId, invoiceId: inv.id }, "stripe invoice paid → active (K8)");
        await resumeForBillingAccount(tenantId);
      }
      return;
    }
    default:
      // Many event types fire on a generic webhook subscription; we ignore
      // anything not in the allowlist above. Logging at debug avoids noise.
      logger.debug({ eventType: event.type }, "stripe webhook ignored");
      return;
  }
}

// ---- DB helpers --------------------------------------------------------------

/** B1 H2 — Event aelter als der zuletzt angewandte Stand des Kontos? */
async function isStaleEvent(tenantId: string, event: Stripe.Event): Promise<boolean> {
  const r = await getGatewayPool().query<{ lastStripeEventAt: Date | null }>(
    `SELECT "lastStripeEventAt" FROM "TenantBilling" WHERE "tenantId" = $1`,
    [tenantId],
  );
  const last = r.rows[0]?.lastStripeEventAt;
  return !!last && new Date(last).getTime() > event.created * 1000;
}

/** Stripe-Abo-Status → Kontozustand. `unpaid`/`past_due` = past_due;
 *  `canceled`/`incomplete_expired` = canceled; sonst active. Ein bereits
 *  gesperrtes Konto bleibt gesperrt, bis eine Rechnung bezahlt ist. */
function subscriptionStatusToAccountStatus(stripeStatus: string, current: string): "active" | "past_due" | "suspended" | "canceled" {
  if (stripeStatus === "past_due" || stripeStatus === "unpaid") return current === "suspended" ? "suspended" : "past_due";
  if (stripeStatus === "canceled" || stripeStatus === "incomplete_expired") return "canceled";
  return "active";
}

/** Geparkte Firmen nachspielen — beim Daten-Tenant des Kontos: das Konto
 *  selbst und (persoenliches Konto) die Organisation des Nutzers. */
async function resumeForBillingAccount(billingAccountId: string): Promise<void> {
  try {
    const { resumeParkedForTenant } = await import("../../lib/quota-resume-worker");
    resumeParkedForTenant(billingAccountId);
    const m = await getGatewayPool().query<{ tenantId: string }>(
      `SELECT "tenantId" FROM "TenantMember" WHERE "actorId" = $1 AND "tenantId" <> $1`,
      [billingAccountId],
    );
    for (const row of m.rows) resumeParkedForTenant(row.tenantId);
  } catch (err) {
    logger.warn({ err: err instanceof Error ? err.message : String(err) }, "resume-worker hook failed");
  }
}

/**
 * v0.1.158 — probe whether a customer id still exists in the
 * current Stripe mode. Returns false for the specific
 * `StripeInvalidRequestError` with `code: resource_missing` on
 * `param: customer`. Any OTHER error (auth, network, rate limit)
 * bubbles up — we deliberately don't want to silently "the customer
 * is gone" on a transient failure that would lose the in-place
 * upgrade path.
 */
async function stripeCustomerExists(
  stripe: ReturnType<typeof getStripe>,
  customerId: string,
): Promise<boolean> {
  try {
    const c = await stripe.customers.retrieve(customerId);
    // `retrieve` returns a DeletedCustomer when the id was deleted in
    // Stripe (rare but possible via dashboard). Treat as missing.
    if ((c as Stripe.Customer | Stripe.DeletedCustomer).deleted) return false;
    return true;
  } catch (err) {
    if (
      err instanceof Stripe.errors.StripeInvalidRequestError &&
      err.code === "resource_missing" &&
      err.param === "id"
    ) {
      return false;
    }
    throw err;
  }
}

async function clearStripeCustomerId(tenantId: string): Promise<void> {
  await getGatewayPool().query(
    `UPDATE "TenantBilling"
       SET "stripeCustomerId" = NULL,
           "stripeSubscriptionId" = NULL,
           "updatedAt" = NOW()
     WHERE "tenantId" = $1`,
    [tenantId],
  );
}

async function readStripeCustomerId(tenantId: string): Promise<string | null> {
  const res = await getGatewayPool().query<{ stripeCustomerId: string | null }>(
    `SELECT "stripeCustomerId" FROM "TenantBilling" WHERE "tenantId" = $1`,
    [tenantId],
  );
  return res.rows[0]?.stripeCustomerId ?? null;
}

async function readTenantIdByCustomer(customerId: string): Promise<string | null> {
  const res = await getGatewayPool().query<{ tenantId: string }>(
    `SELECT "tenantId" FROM "TenantBilling" WHERE "stripeCustomerId" = $1`,
    [customerId],
  );
  return res.rows[0]?.tenantId ?? null;
}

async function upsertCustomerLink(tenantId: string, customerId: string): Promise<void> {
  // Upsert: brand-new tenants land here without a TenantBilling row if
  // they paid before any persist event (unlikely but possible).
  await getGatewayPool().query(
    `INSERT INTO "TenantBilling"
       ("tenantId", "kind", "mode", tier, "quotaLimit", "stripeCustomerId", "updatedAt", "createdAt")
     VALUES ($1, 'personal', 'none', 'free', 25, $2, NOW(), NOW())
     ON CONFLICT ("tenantId")
     DO UPDATE SET "stripeCustomerId" = EXCLUDED."stripeCustomerId",
                   "updatedAt" = NOW()`,
    [tenantId, customerId],
  );
}

async function upsertSubscriptionState(args: {
  tenantId: string;
  customerId: string;
  subscriptionId: string;
  tier: BillingTier;
  quotaLimit: number;
  periodEnd: Date | null;
  cancelAtPeriodEnd: boolean;
  status: "active" | "past_due" | "suspended" | "canceled";
  eventCreated: number;
}): Promise<void> {
  // B1 — mode wird nur gesetzt, wenn das Konto kein Organisationskonto
  // mit Sammelabrechnung/Enterprise ist (Einzelabo eines Nutzers).
  await getGatewayPool().query(
    `INSERT INTO "TenantBilling"
       ("tenantId", "kind", "mode", tier, "quotaLimit", "stripeCustomerId",
        "stripeSubscriptionId", "periodEnd", "cancelAtPeriodEnd", "status", "lastStripeEventAt",
        "updatedAt", "createdAt")
     VALUES ($1, 'personal', 'subscription', $2, $3, $4, $5, $6, $7, $8, to_timestamp($9), NOW(), NOW())
     ON CONFLICT ("tenantId")
     DO UPDATE SET tier = EXCLUDED.tier,
                   "mode" = CASE WHEN "TenantBilling"."mode" IN ('seats', 'enterprise') THEN "TenantBilling"."mode" ELSE 'subscription' END,
                   "quotaLimit" = EXCLUDED."quotaLimit",
                   "stripeCustomerId" = EXCLUDED."stripeCustomerId",
                   "stripeSubscriptionId" = EXCLUDED."stripeSubscriptionId",
                   "periodEnd" = EXCLUDED."periodEnd",
                   "cancelAtPeriodEnd" = EXCLUDED."cancelAtPeriodEnd",
                   "status" = EXCLUDED."status",
                   "pastDueSince" = CASE WHEN EXCLUDED."status" = 'active' THEN NULL ELSE COALESCE("TenantBilling"."pastDueSince", NOW()) END,
                   "suspendedAt" = CASE WHEN EXCLUDED."status" = 'active' THEN NULL ELSE "TenantBilling"."suspendedAt" END,
                   "lastStripeEventAt" = EXCLUDED."lastStripeEventAt",
                   "updatedAt" = NOW()`,
    [
      args.tenantId,
      args.tier,
      args.quotaLimit,
      args.customerId,
      args.subscriptionId,
      args.periodEnd,
      args.cancelAtPeriodEnd,
      args.status,
      args.eventCreated,
    ],
  );
}

async function downgradeToFree(tenantId: string, eventCreated: number): Promise<void> {
  await getGatewayPool().query(
    `UPDATE "TenantBilling"
        SET tier = 'free',
            "mode" = CASE WHEN "mode" IN ('seats', 'enterprise') THEN "mode" ELSE 'none' END,
            "quotaLimit" = 25,
            "stripeSubscriptionId" = NULL,
            "periodEnd" = NULL,
            "cancelAtPeriodEnd" = FALSE,
            "status" = 'active',
            "pastDueSince" = NULL,
            "suspendedAt" = NULL,
            "lastStripeEventAt" = to_timestamp($2),
            "updatedAt" = NOW()
      WHERE "tenantId" = $1`,
    [tenantId, eventCreated],
  );
}

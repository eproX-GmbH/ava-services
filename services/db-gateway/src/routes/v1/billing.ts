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
import type Stripe from "stripe";
import { getStripe, getStripeWebhookSecret } from "../../lib/stripe-client";
import { getGatewayPool } from "../../lib/producer-pools";
import { logger } from "../../lib/logger";
import {
  TIER_LIMITS,
  priceIdForTier,
  tierFromPriceId,
  type PaidTier,
} from "../../lib/billing-plans";
import type { BillingTier } from "../../lib/billing";

// =============================================================================
// Authed router — checkout + portal. Mounted in v1.ts behind the standard
// auth/rate-limit/audit chain.
// =============================================================================

export const billingRouter = new OpenAPIHono();

const CheckoutBody = z.object({ tier: z.enum(["starter", "pro"]) });
const CheckoutResponse = z.object({
  url: z.string().url(),
  sessionId: z.string(),
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

  const stripe = getStripe();
  const existing = await readStripeCustomerId(auth.tenantId);

  const params: Stripe.Checkout.SessionCreateParams = {
    mode: "subscription",
    line_items: [{ price: priceId, quantity: 1 }],
    metadata: { tenantId: auth.tenantId },
    subscription_data: {
      metadata: { tenantId: auth.tenantId },
    },
    automatic_tax: { enabled: true },
    success_url: "ava://billing/success?session_id={CHECKOUT_SESSION_ID}",
    cancel_url: "ava://billing/cancel",
  };
  if (existing) params.customer = existing;

  const session = await stripe.checkout.sessions.create(params);
  return c.json({ url: session.url ?? "", sessionId: session.id }, 200);
});

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

  const customerId = await readStripeCustomerId(auth.tenantId);
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
      const tenantId = (session.metadata?.tenantId as string | undefined) ?? null;
      const customerId = typeof session.customer === "string" ? session.customer : session.customer?.id ?? null;
      if (!tenantId || !customerId) {
        logger.warn({ eventId: event.id }, "checkout.session.completed missing tenantId/customerId");
        return;
      }
      await upsertCustomerLink(tenantId, customerId);
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
      await upsertSubscriptionState({
        tenantId,
        customerId,
        subscriptionId: sub.id,
        tier,
        quotaLimit: TIER_LIMITS[tier],
        periodEnd,
        cancelAtPeriodEnd,
      });
      logger.info({ tenantId, tier, subscriptionId: sub.id }, "stripe subscription state synced");
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
      await downgradeToFree(tenantId);
      logger.info({ tenantId }, "stripe subscription deleted; downgraded to free");
      return;
    }
    case "invoice.payment_failed": {
      const inv = event.data.object as Stripe.Invoice;
      logger.warn(
        { eventId: event.id, invoiceId: inv.id, customer: inv.customer },
        "stripe invoice payment failed (no state change; awaiting subscription.updated)",
      );
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
       ("tenantId", tier, "quotaLimit", "stripeCustomerId", "updatedAt", "createdAt")
     VALUES ($1, 'free', 25, $2, NOW(), NOW())
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
}): Promise<void> {
  await getGatewayPool().query(
    `INSERT INTO "TenantBilling"
       ("tenantId", tier, "quotaLimit", "stripeCustomerId",
        "stripeSubscriptionId", "periodEnd", "cancelAtPeriodEnd",
        "updatedAt", "createdAt")
     VALUES ($1, $2, $3, $4, $5, $6, $7, NOW(), NOW())
     ON CONFLICT ("tenantId")
     DO UPDATE SET tier = EXCLUDED.tier,
                   "quotaLimit" = EXCLUDED."quotaLimit",
                   "stripeCustomerId" = EXCLUDED."stripeCustomerId",
                   "stripeSubscriptionId" = EXCLUDED."stripeSubscriptionId",
                   "periodEnd" = EXCLUDED."periodEnd",
                   "cancelAtPeriodEnd" = EXCLUDED."cancelAtPeriodEnd",
                   "updatedAt" = NOW()`,
    [
      args.tenantId,
      args.tier,
      args.quotaLimit,
      args.customerId,
      args.subscriptionId,
      args.periodEnd,
      args.cancelAtPeriodEnd,
    ],
  );
}

async function downgradeToFree(tenantId: string): Promise<void> {
  await getGatewayPool().query(
    `UPDATE "TenantBilling"
        SET tier = 'free',
            "quotaLimit" = 25,
            "stripeSubscriptionId" = NULL,
            "periodEnd" = NULL,
            "cancelAtPeriodEnd" = FALSE,
            "updatedAt" = NOW()
      WHERE "tenantId" = $1`,
    [tenantId],
  );
}

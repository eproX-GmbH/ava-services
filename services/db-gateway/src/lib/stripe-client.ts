// M3 — Stripe SDK wrapper.
//
// Lazy-init: we don't construct the SDK at module load so the gateway
// can boot in dev without `STRIPE_SECRET_KEY`. The first checkout/
// portal/webhook call triggers init; missing env throws a 503-shaped
// HTTPException that the caller can let bubble.

import Stripe from "stripe";
import { HTTPException } from "hono/http-exception";

let cached: Stripe | null = null;

export function getStripe(): Stripe {
  if (cached) return cached;
  const key = process.env.STRIPE_SECRET_KEY;
  if (!key) {
    throw new HTTPException(503, {
      message: "stripe not configured (set STRIPE_SECRET_KEY)",
    });
  }
  // Don't pin apiVersion — the SDK's account-default is fine and the
  // type-locked version drifts with each `stripe` package bump. We use
  // only stable surfaces (Checkout, Customer Portal, Subscriptions).
  cached = new Stripe(key, {
    appInfo: { name: "ava-db-gateway" },
  });
  return cached;
}

export function getStripeWebhookSecret(): string {
  const secret = process.env.STRIPE_WEBHOOK_SECRET;
  if (!secret) {
    throw new HTTPException(503, {
      message: "stripe webhook not configured (set STRIPE_WEBHOOK_SECRET)",
    });
  }
  return secret;
}

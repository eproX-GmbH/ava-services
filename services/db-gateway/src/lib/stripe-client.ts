// M3 — Stripe SDK wrapper.
//
// Lazy-init: we don't construct the SDK at module load so the gateway
// can boot in dev without `STRIPE_SECRET_KEY`. The first checkout/
// portal/webhook call triggers init; missing env throws a 503-shaped
// HTTPException that the caller can let bubble.

import Stripe from "stripe";
import { HTTPException } from "hono/http-exception";

import { AsyncLocalStorage } from "node:async_hooks";
import type pg from "pg";

// Staging (docs/PLAN_STAGING.md ST4): Organisationen buchen gegen Stripe live ODER test
// (TenantBilling.stripeModus). Der Modus gilt als Kontext: je Anfrage aus der Organisation
// (Middleware), je Webhook-Endpunkt, in Funktionen mit tenantId ausdrücklich. Ohne Kontext:
// live. Ein falscher Modus scheitert bei Stripe („No such customer“), bewegt aber kein Geld.
export type StripeModus = "live" | "test";
const kontext = new AsyncLocalStorage<StripeModus>();
export const stripeModus = (): StripeModus => kontext.getStore() ?? "live";
export function mitStripeModus<T>(modus: StripeModus, f: () => T): T {
  return kontext.run(modus, f);
}

const modusMerk = new Map<string, { m: StripeModus; bis: number }>();
/** Zahlungsmodus einer Organisation (60 s gemerkt; unbekannt = live). */
export async function stripeModusVon(pool: Pick<pg.Pool, "query">, tenantId: string): Promise<StripeModus> {
  const g = modusMerk.get(tenantId);
  if (g && g.bis > Date.now()) return g.m;
  const r = await pool.query<{ stripeModus: string }>(`SELECT "stripeModus" FROM "TenantBilling" WHERE "tenantId" = $1`, [tenantId]);
  const m: StripeModus = r.rows[0]?.stripeModus === "test" ? "test" : "live";
  if (modusMerk.size > 5000) modusMerk.clear();
  modusMerk.set(tenantId, { m, bis: Date.now() + 60_000 });
  return m;
}
export const stripeModusVergessen = (tenantId: string) => modusMerk.delete(tenantId);

/** f im Zahlungsmodus der Organisation ausführen. */
export async function mitModusVon<T>(pool: Pick<pg.Pool, "query">, tenantId: string, f: () => Promise<T>): Promise<T> {
  return mitStripeModus(await stripeModusVon(pool, tenantId), f);
}

/** Preis-ID je Modus: STRIPE_PRICE_<NAME> bzw. STRIPE_TEST_PRICE_<NAME>. */
export function stripePreis(name: "STARTER" | "PRO" | "MAX" | "ULTRA" | "CLOUD", modus: StripeModus = stripeModus()): string | undefined {
  const v = process.env[modus === "test" ? `STRIPE_TEST_PRICE_${name}` : `STRIPE_PRICE_${name}`]?.trim();
  return v || undefined;
}

/** Ist Stripe für den aktuellen Modus eingerichtet? */
export const stripeSchluesselDa = (modus: StripeModus = stripeModus()): boolean =>
  Boolean(modus === "test" ? process.env.STRIPE_TEST_SECRET_KEY : process.env.STRIPE_SECRET_KEY);

const clients: Partial<Record<StripeModus, Stripe>> = {};

export function getStripe(modus: StripeModus = stripeModus()): Stripe {
  const fertig = clients[modus];
  if (fertig) return fertig;
  const key = modus === "test" ? process.env.STRIPE_TEST_SECRET_KEY : process.env.STRIPE_SECRET_KEY;
  if (!key) {
    throw new HTTPException(503, {
      message: modus === "test" ? "stripe test mode not configured (set STRIPE_TEST_SECRET_KEY)" : "stripe not configured (set STRIPE_SECRET_KEY)",
    });
  }
  // Don't pin apiVersion — the SDK's account-default is fine and the
  // type-locked version drifts with each `stripe` package bump. We use
  // only stable surfaces (Checkout, Customer Portal, Subscriptions).
  const client = new Stripe(key, {
    appInfo: { name: "ava-db-gateway" },
  });
  clients[modus] = client;
  return client;
}

export function getStripeWebhookSecret(modus: StripeModus = stripeModus()): string {
  const secret = modus === "test" ? process.env.STRIPE_TEST_WEBHOOK_SECRET : process.env.STRIPE_WEBHOOK_SECRET;
  if (!secret) {
    throw new HTTPException(503, {
      message: modus === "test" ? "stripe test webhook not configured (set STRIPE_TEST_WEBHOOK_SECRET)" : "stripe webhook not configured (set STRIPE_WEBHOOK_SECRET)",
    });
  }
  return secret;
}

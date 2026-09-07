// M3 — tier ↔ Stripe price-id mapping.
//
// Single source-of-truth for "what does each tier cost the user (in
// quota units) and which Stripe price corresponds to it". Read by:
//   - routes/v1/billing.ts (checkout — tier → price id)
//   - routes/v1/billing.ts (webhook — price id → tier)
//
// Price ids come from env (set via `fly secrets set
// STRIPE_PRICE_STARTER=price_…`). Adding a new paid tier is a code
// change here PLUS a webhook handler update.

import { UNLIMITED, type BillingTier } from "./billing";

/** Quota limits applied when a webhook flips a tenant to a new tier.
 *  Matches the locked pricing in the monetization plan. */
export const TIER_LIMITS: Record<BillingTier, number> = {
  free: 25,
  starter: 500,
  pro: 2000,
  enterprise: UNLIMITED,
};

export type PaidTier = "starter" | "pro";

/** Returns the env-configured Stripe price id for a paid tier, or
 *  null when the env var isn't set (caller decides whether that's a
 *  503). We don't read env at module load — the gateway boots with
 *  Stripe disabled in dev. */
export function priceIdForTier(tier: PaidTier): string | null {
  if (tier === "starter") return process.env.STRIPE_PRICE_STARTER ?? null;
  if (tier === "pro") return process.env.STRIPE_PRICE_PRO ?? null;
  return null;
}

/** Inverse — used by the subscription.{created,updated} webhook to
 *  derive the tier from the line-item price id. Returns null for
 *  unknown price ids (defensive: an admin could create a new product
 *  in Stripe before adding it here). */
export function tierFromPriceId(priceId: string): PaidTier | null {
  if (priceId === process.env.STRIPE_PRICE_STARTER) return "starter";
  if (priceId === process.env.STRIPE_PRICE_PRO) return "pro";
  return null;
}

// ---- B2 — Seat-Sammelabrechnung (docs/PLAN_ABRECHNUNG_SEATS.md) ------------

export type SeatTier = "starter" | "pro";

/** Listenpreis je Seat und Monat in Euro-Cent (netto). Ueberschreibbar
 *  per Env (SEAT_PRICE_STARTER_CENTS / SEAT_PRICE_PRO_CENTS), damit
 *  Preisaenderungen ohne Deploy moeglich sind. */
export function seatPriceCents(tier: SeatTier): number {
  const env = tier === "starter" ? process.env.SEAT_PRICE_STARTER_CENTS : process.env.SEAT_PRICE_PRO_CENTS;
  const n = env ? Number(env) : NaN;
  if (Number.isFinite(n) && n >= 0) return Math.round(n);
  return tier === "starter" ? 4900 : 14900;
}

export function isSeatTier(v: unknown): v is SeatTier {
  return v === "starter" || v === "pro";
}

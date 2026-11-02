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

import type { BillingTier } from "./billing";

/** -1 = keine Begrenzung (identisch mit billing.ts; hier lokal, damit billing-plans
 *  ohne Wertimport aus billing.ts auskommt und kein Importkreis entsteht). */
const UNLIMITED = -1;

/** Quota limits applied when a webhook flips a tenant to a new tier.
 *  Matches the locked pricing in the monetization plan. */
// Z7/Z9 (docs/PLAN_ABRECHNUNG_ZUGANG.md): Pro ist der einzige bezahlte Plan, jede
// verarbeitete Firma wird zum Stufensatz berechnet. Bezahlte Plaene haben KEINEN
// Firmen-Deckel (Joyce, 2026-10-13); die einzige Grenze ist das Ausgabenlimit,
// das der Kunde selbst setzt. Nur Free ist begrenzt. Starter bleibt fuer
// Altvertraege lesbar und verhaelt sich wie Pro.
export const TIER_LIMITS: Record<BillingTier, number> = {
  free: 25,
  starter: UNLIMITED,
  pro: UNLIMITED,
  max: UNLIMITED,
  ultra: UNLIMITED,
  enterprise: UNLIMITED,
};

export type PaidTier = "starter" | "pro" | "max" | "ultra";

// ---- docs/PLAN_PRICING_TIERS.md P1 — Plan-Katalog (2026-11-02) -------------
//
// Eine Quelle fuer App, Konsole und PWA: Preis je Sitz und Monat, Kontingent in
// Cent (Standard = Preis), Rang fuer Upgrade/Downgrade-Richtung, Merkmale fuer
// die Plan-Karten. Preise/Kontingente per Env ohne Deploy aenderbar.

export type SitzPlan = "pro" | "max" | "ultra";
export const SITZ_PLAENE: readonly SitzPlan[] = ["pro", "max", "ultra"];

export interface PlanEintrag {
  plan: BillingTier;
  name: string;
  /** Rang: free 0 < pro 1 < max 2 < ultra 3; enterprise 9 (ausserhalb der Leiter). */
  rang: number;
  /** Preis je Sitz und Monat, Cent netto (0 = kostenlos, null = Vertrag). */
  preisCents: number | null;
  /** Monatskontingent in Cent (null = Vertrag/Betreiber-Limit); Free: 25 Firmen lebenslang. */
  kontingentCents: number | null;
  /** Free: Firmen lebenslang. */
  firmenLebenslang: number | null;
  payg: boolean;
  linkedinBeobachtung: boolean;
  merkmale: string[];
}

function envCents(name: string, fallback: number): number {
  const n = Number(process.env[name]);
  return Number.isFinite(n) && n >= 0 ? Math.round(n) : fallback;
}

export function planKatalog(): PlanEintrag[] {
  const pro = envCents("PLAN_PRO_CENTS", 4900);
  const max = envCents("PLAN_MAX_CENTS", 14900);
  const ultra = envCents("PLAN_ULTRA_CENTS", 29900);
  return [
    {
      plan: "free", name: "Free", rang: 0, preisCents: 0, kontingentCents: null, firmenLebenslang: TIER_LIMITS.free,
      payg: false, linkedinBeobachtung: false,
      merkmale: ["25 Firmen, einmalig", "Ansprechpartner von der Website, LinkedIn-Mitarbeiter ab Pro", "Höchstens 3 Free-Plätze je Organisation"],
    },
    {
      plan: "pro", name: "Pro", rang: 1, preisCents: pro, kontingentCents: envCents("KONTINGENT_PRO_CENTS", pro), firmenLebenslang: null,
      payg: false, linkedinBeobachtung: true,
      merkmale: ["Monatskontingent in Höhe des Sitzpreises", "Firmen im Bestand ab 0,50 € je Monat", "LinkedIn-Beobachtung nach Verbrauch"],
    },
    {
      plan: "max", name: "Max", rang: 2, preisCents: max, kontingentCents: envCents("KONTINGENT_MAX_CENTS", max), firmenLebenslang: null,
      payg: false, linkedinBeobachtung: true,
      merkmale: ["Dreifaches Kontingent gegenüber Pro", "Firmen im Bestand ab 0,50 € je Monat", "LinkedIn-Beobachtung nach Verbrauch"],
    },
    {
      plan: "ultra", name: "Ultra", rang: 3, preisCents: ultra, kontingentCents: envCents("KONTINGENT_ULTRA_CENTS", ultra), firmenLebenslang: null,
      payg: true, linkedinBeobachtung: true,
      merkmale: ["Sechsfaches Kontingent gegenüber Pro", "Über das Kontingent hinaus nach Freigabe", "LinkedIn-Beobachtung nach Verbrauch"],
    },
    {
      plan: "enterprise", name: "Enterprise", rang: 9, preisCents: null, kontingentCents: null, firmenLebenslang: null,
      payg: false, linkedinBeobachtung: true,
      merkmale: ["Vertrag mit Fixpreis und Sammelrechnung", "Mitgliederzahl und Grenzen nach Vereinbarung"],
    },
  ];
}

export function planEintrag(plan: BillingTier): PlanEintrag {
  const e = planKatalog().find((p) => p.plan === plan);
  if (e) return e;
  // starter (Altbestand) verhaelt sich wie pro.
  return planKatalog().find((p) => p.plan === "pro")!;
}

export function istSitzPlan(v: unknown): v is SitzPlan {
  return v === "pro" || v === "max" || v === "ultra";
}

export function planRang(plan: BillingTier): number {
  return planEintrag(plan).rang;
}

/** Z4 (docs/PLAN_ABRECHNUNG_ZUGANG.md): Zugangsguthaben je Monat und Seat in
 *  Euro-Cent (netto). Aufnahmen werden mit ihrem Stufenpreis dagegen gerechnet,
 *  darueber faellt Pay-as-you-go an. Free: 25 Firmen lebenslang, kein Guthaben;
 *  Enterprise: unbegrenzt. Per Env ohne Deploy aenderbar. */
export function guthabenCents(tier: BillingTier): number {
  // Z7: kein enthaltenes Guthaben mehr — jede Aufnahme wird zum Stufenpreis
  // berechnet, Enterprise nach Vertrag. (Env bleibt fuer Sonderfaelle.)
  if (tier === "enterprise") return UNLIMITED;
  if (tier === "free") return 0;
  const env = tier === "starter" ? process.env.GUTHABEN_STARTER_CENTS : process.env.GUTHABEN_PRO_CENTS;
  const n = env ? Number(env) : NaN;
  return Number.isFinite(n) && n >= 0 ? Math.round(n) : 0;
}

/** Returns the env-configured Stripe price id for a paid tier, or
 *  null when the env var isn't set (caller decides whether that's a
 *  503). We don't read env at module load — the gateway boots with
 *  Stripe disabled in dev. */
export function priceIdForTier(tier: PaidTier): string | null {
  if (tier === "starter") return process.env.STRIPE_PRICE_STARTER ?? null;
  if (tier === "pro") return process.env.STRIPE_PRICE_PRO ?? null;
  if (tier === "max") return process.env.STRIPE_PRICE_MAX ?? null;
  if (tier === "ultra") return process.env.STRIPE_PRICE_ULTRA ?? null;
  return null;
}

/** Inverse — used by the subscription.{created,updated} webhook to
 *  derive the tier from the line-item price id. Returns null for
 *  unknown price ids (defensive: an admin could create a new product
 *  in Stripe before adding it here). */
export function tierFromPriceId(priceId: string): PaidTier | null {
  if (priceId === process.env.STRIPE_PRICE_STARTER) return "starter";
  if (priceId === process.env.STRIPE_PRICE_PRO) return "pro";
  if (priceId === process.env.STRIPE_PRICE_MAX) return "max";
  if (priceId === process.env.STRIPE_PRICE_ULTRA) return "ultra";
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
  // Z7: Pro = 49 EUR je Nutzer und Monat plus Stufenpreis je Aufnahme; Starter nur Altvertraege.
  return 4900;
}

export function isSeatTier(v: unknown): v is SeatTier {
  return v === "starter" || v === "pro";
}

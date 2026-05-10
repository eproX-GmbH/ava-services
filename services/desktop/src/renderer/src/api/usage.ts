import { useQuery } from "@tanstack/react-query";
import { gatewayFetch } from "./gateway";

// Shared `/v1/usage` snapshot type + react-query hook.
//
// Mirrors `services/db-gateway/src/lib/billing.ts → UsageSnapshot`.
// Used by:
//   - Settings → Plan & Abrechnung section (M2)
//   - Topbar pill (rendered when used/limit ≥ 0.8)
//   - Ingest route pre-import client gate (M2)
//   - Stripe success protocol callback (invalidates this query so the
//     new tier surfaces immediately)

export type BillingTier = "free" | "starter" | "pro" | "enterprise";

export interface UsageSnapshot {
  tier: BillingTier;
  used: number;
  /** -1 sentinel = enterprise / "unbegrenzt". Otherwise the per-period quota. */
  limit: number;
  /** -1 sentinel = enterprise. Otherwise max(0, limit-used). */
  remaining: number;
  /** ISO-8601 string. null for free + enterprise (no rolling reset). */
  periodEnd: string | null;
  /** "lifetime" | "YYYY-MM" | "unlimited" */
  periodKey: string;
  /** v0.1.103 — true when the user has scheduled cancellation via the
   *  Stripe portal but the period hasn't ended yet. UI shows
   *  "Kündigung zum X vorgemerkt" + helper to take it back. */
  cancelAtPeriodEnd: boolean;
}

export const USAGE_QUERY_KEY = ["usage"] as const;

export function useUsage() {
  return useQuery({
    queryKey: USAGE_QUERY_KEY,
    queryFn: () => gatewayFetch<UsageSnapshot>("/v1/usage"),
    // Quota is read-mostly and changes only on persist events / Stripe
    // webhooks. 30 s staleTime is the same cadence the topbar pill
    // refreshes after a successful import.
    staleTime: 30_000,
  });
}

export function isUnlimited(snap: UsageSnapshot | undefined): boolean {
  return !!snap && (snap.tier === "enterprise" || snap.limit === -1);
}

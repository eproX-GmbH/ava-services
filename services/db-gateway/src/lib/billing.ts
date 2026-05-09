// M1 of monetization plan (v0.1.59).
//
// Per-(tenant, period, company) usage tracking + per-tenant billing
// state. Wired in two places:
//
//   - persist-bus listener calls `recordUsage(...)` on every successful
//     `tenant.persist.structured-content.v1`. Failures don't fire that
//     event, so failed scrapes don't bill — exactly the fairness
//     property the user's design called out.
//
//   - `GET /v1/usage` calls `getUsageSnapshot(...)` to return the
//     `{tier, used, limit, remaining, periodEnd}` envelope the desktop
//     surfaces in Settings + the topbar pill.
//
// All operations are best-effort wrt persist-bus: a billing-table
// failure must NEVER block a producer's persist write. Persist-bus
// already has a try/catch around the apply call; we wrap our usage
// hook in its own try/catch on top.
//
// Why both tables in one module: keeps the "what's a tenant's tier?"
// vs "did we already bill this company?" decisions co-located. M2 +
// M3 will add `enforceQuota()` and `applyStripeWebhook()` here too.

import { Pool } from "pg";
import type { Logger } from "pino";
import { HTTPException } from "hono/http-exception";

/** Tier values the gateway recognizes. Stripe webhooks (M3) will
 *  flip a tenant between these. Schema is `String` so adding a new
 *  tier is data-only, no migration. */
export type BillingTier = "free" | "starter" | "pro" | "enterprise";

/** Default tier + quota for tenants that have no `TenantBilling` row
 *  yet (i.e. brand-new accounts). 25 lifetime cold companies — see
 *  the monetization design doc. */
const FREE_DEFAULT_LIMIT = 25;

/** Snapshot returned by `getUsageSnapshot` and shipped to clients
 *  via `GET /v1/usage`. The desktop renders this directly. */
export interface UsageSnapshot {
  tier: BillingTier;
  used: number;
  /** -1 sentinel = no enforcement (today: tier="enterprise"). Clients
   *  render this as "Unbegrenzt" / ∞ and skip "X von Y" math. Numeric
   *  for all other tiers. */
  limit: number;
  /** Defensive: never negative even if a manual quota cut goes below
   *  current usage. Clients show "Limit überschritten" but don't go
   *  to negative integers. -1 sentinel propagates from `limit` for
   *  enterprise (always shown as ∞). */
  remaining: number;
  /** ISO-8601. null for free + enterprise (no rolling reset). */
  periodEnd: string | null;
  /** "lifetime" | "YYYY-MM" — useful for the desktop's display
   *  ("Monat März 2026" vs "Lebenszeit-Kontingent"). Always
   *  "unlimited" for enterprise. */
  periodKey: string;
}

/** Sentinel for "no enforcement". Used in `limit` + `remaining` of
 *  the snapshot for enterprise tenants. Picked -1 over Infinity
 *  because it serializes cleanly through JSON (Infinity → null). */
export const UNLIMITED = -1;

/** True when this tier shouldn't be enforced — used by the M2
 *  pre-import gate. Today: only "enterprise". The operator's own
 *  tenant flips here via direct DB update + restart-free; there's
 *  no "admin override" in JWT claims because we want the same code
 *  path for paying enterprise customers. */
export function isUnlimited(tier: BillingTier): boolean {
  return tier === "enterprise";
}

/** Compute the right `periodKey` for a tier at a given moment.
 *
 *  - free: a single bucket forever ("lifetime")
 *  - paid tiers: rolling-monthly, keyed on UTC YYYY-MM. Simple +
 *    deterministic. Aligning with the actual Stripe billing date
 *    (subscription anniversary) is a M3 concern; the periodKey
 *    transition would be invisible to billing tracking since
 *    UsageEntry rows are keyed by tenantId+period regardless.
 */
export function periodKeyFor(tier: BillingTier, now: Date = new Date()): string {
  if (tier === "free") return "lifetime";
  const y = now.getUTCFullYear();
  const m = String(now.getUTCMonth() + 1).padStart(2, "0");
  return `${y}-${m}`;
}

/** First moment AFTER the current period (used to compute periodEnd for
 *  the snapshot). Returns null for free + enterprise — they don't roll. */
export function periodEndFor(tier: BillingTier, now: Date = new Date()): Date | null {
  if (tier === "free" || tier === "enterprise") return null;
  return new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() + 1, 1));
}

/** Look up or lazily-create a `TenantBilling` row. Lazy create gives
 *  brand-new tenants the free-tier defaults without an explicit
 *  provisioning step. */
async function ensureBillingRow(
  pool: Pool,
  tenantId: string,
): Promise<{
  tier: BillingTier;
  quotaLimit: number;
  periodEnd: Date | null;
}> {
  // Read first; only insert if missing. Avoids needless writes on
  // every event for established tenants.
  const existing = await pool.query<{
    tier: string;
    quotaLimit: number;
    periodEnd: Date | null;
  }>(
    `SELECT tier, "quotaLimit", "periodEnd"
       FROM "TenantBilling"
      WHERE "tenantId" = $1`,
    [tenantId],
  );
  if (existing.rowCount && existing.rowCount > 0) {
    const row = existing.rows[0]!;
    return {
      tier: row.tier as BillingTier,
      quotaLimit: row.quotaLimit,
      periodEnd: row.periodEnd,
    };
  }

  // First-time-seen tenant. Insert defaults; concurrent inserts are
  // handled by ON CONFLICT (the PK is tenantId).
  await pool.query(
    `INSERT INTO "TenantBilling"
       ("tenantId", tier, "quotaLimit", "updatedAt", "createdAt")
     VALUES ($1, 'free', $2, NOW(), NOW())
     ON CONFLICT ("tenantId") DO NOTHING`,
    [tenantId, FREE_DEFAULT_LIMIT],
  );
  return { tier: "free", quotaLimit: FREE_DEFAULT_LIMIT, periodEnd: null };
}

/** Record a usage credit for a successful structured-content persist.
 *
 *  Idempotent on (tenantId, periodKey, companyId): a second persist
 *  for the same company in the same period does nothing — re-imports
 *  + retries within a period don't double-bill. Cross-period re-imports
 *  DO bill again (the user gets a fresh master-data scrape, the
 *  operator pays valueSERP again on the website stage that follows).
 *
 *  The `source` field is logged but doesn't affect dedup; today only
 *  "structured-content" calls in. Future revenue events (e.g. heartbeat
 *  freshness) would distinguish their bucket here.
 */
export async function recordUsage(
  pool: Pool,
  log: Logger,
  args: {
    tenantId: string;
    companyId: string;
    source: "structured-content";
  },
): Promise<void> {
  try {
    const billing = await ensureBillingRow(pool, args.tenantId);
    const periodKey = periodKeyFor(billing.tier);
    const res = await pool.query(
      `INSERT INTO "UsageEntry"
         ("tenantId", "periodKey", "companyId", source, "createdAt")
       VALUES ($1, $2, $3, $4, NOW())
       ON CONFLICT ("tenantId", "periodKey", "companyId") DO NOTHING`,
      [args.tenantId, periodKey, args.companyId, args.source],
    );
    log.info(
      {
        tenantId: args.tenantId,
        companyId: args.companyId,
        periodKey,
        billed: (res.rowCount ?? 0) > 0,
        tier: billing.tier,
      },
      (res.rowCount ?? 0) > 0 ? "usage debited" : "usage already debited (no-op)",
    );
  } catch (err) {
    // Never block the caller — billing is observability-grade for M1,
    // not enforcement. M2 will add `enforceQuota()` for the pre-import
    // gate; that's where errors will need stricter handling.
    log.warn(
      {
        err: err instanceof Error ? err.message : String(err),
        tenantId: args.tenantId,
        companyId: args.companyId,
      },
      "recordUsage failed (best-effort)",
    );
  }
}

/** Compute the `{tier, used, limit, remaining, periodEnd}` snapshot
 *  for the tenant's current period. Backed by the index on
 *  ("tenantId", "periodKey"). */
export async function getUsageSnapshot(
  pool: Pool,
  tenantId: string,
): Promise<UsageSnapshot> {
  const billing = await ensureBillingRow(pool, tenantId);
  const periodKey = periodKeyFor(billing.tier);
  const periodEnd = billing.periodEnd ?? periodEndFor(billing.tier);

  const countRes = await pool.query<{ used: string }>(
    `SELECT COUNT(*)::text AS used
       FROM "UsageEntry"
      WHERE "tenantId" = $1 AND "periodKey" = $2`,
    [tenantId, periodKey],
  );
  const used = Number(countRes.rows[0]?.used ?? 0);

  // Enterprise tier: stored quotaLimit is irrelevant. Surface UNLIMITED
  // so clients render "∞" and skip the math entirely. This gives the
  // operator a clean self-provisioning path: UPDATE TenantBilling SET
  // tier='enterprise' WHERE tenantId=...; — no need to set quotaLimit
  // to a huge number.
  const limit = isUnlimited(billing.tier) ? UNLIMITED : billing.quotaLimit;
  const remaining =
    limit === UNLIMITED ? UNLIMITED : Math.max(0, limit - used);

  return {
    tier: billing.tier,
    used,
    limit,
    remaining,
    periodEnd: periodEnd ? periodEnd.toISOString() : null,
    periodKey: isUnlimited(billing.tier) ? "unlimited" : periodKey,
  };
}

/** M2 — pre-import gate. Throws a structured `402 quota_exceeded`
 *  HTTPException when `used + neededCount > limit`. Enterprise +
 *  UNLIMITED short-circuit to a no-op return.
 *
 *  Returns the snapshot when the quota is OK so callers don't have
 *  to round-trip through `getUsageSnapshot` a second time. */
export async function assertQuotaAvailable(
  pool: Pool,
  tenantId: string,
  neededCount: number,
): Promise<UsageSnapshot> {
  const snapshot = await getUsageSnapshot(pool, tenantId);
  if (snapshot.limit === UNLIMITED) return snapshot;
  const wouldUse = snapshot.used + Math.max(0, neededCount);
  if (wouldUse <= snapshot.limit) return snapshot;
  // Structured 402 — desktop's GatewayError surfaces `body` to the
  // renderer, the Ingest 402 handler renders the German upgrade CTA.
  throw new HTTPException(402, {
    res: new Response(
      JSON.stringify({
        error: "quota_exceeded",
        tier: snapshot.tier,
        used: snapshot.used,
        limit: snapshot.limit,
        neededCount,
        upgradeUrl: "ava://billing/upgrade",
      }),
      {
        status: 402,
        headers: { "content-type": "application/json" },
      },
    ),
  });
}

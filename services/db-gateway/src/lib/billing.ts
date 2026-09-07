// M1 of monetization plan (v0.1.59), B1 Abrechnungskonto (2026-09-06,
// docs/PLAN_ABRECHNUNG_SEATS.md).
//
// Per-(account, period, company) usage tracking + per-account billing
// state. Wired in three places:
//
//   - persist-bus listener calls `recordUsage(...)` on every successful
//     `tenant.persist.structured-content.v1`. Failures don't fire that
//     event, so failed scrapes don't bill.
//
//   - `GET /v1/usage` calls `getUsageSnapshot(...)` to return the
//     `{tier, used, limit, remaining, periodEnd, entitlement}` envelope
//     the desktop surfaces in Settings + the topbar pill.
//
//   - `/internal/quota/try-reserve` (master-data) resolves the account
//     the same way before it locks the billing row.
//
// B1 — ABRECHNUNGSKONTO vs. DATEN-TENANT. Seit den Organisationen (O1)
// ist der Daten-Tenant eines Mitglieds die Organisation. Die
// Abrechnung haengt aber am Konto: `resolveBillingAccountId()` liefert
// die Organisation nur, wenn sie Sammelabrechnung (mode=seats) oder
// einen Enterprise-Vertrag (mode=enterprise) hat — sonst zaehlt jedes
// Mitglied auf sein persoenliches Konto (id = sub), auch wenn seine
// Daten im Organisations-Tenant liegen. Vorher teilten alle Mitglieder
// stillschweigend die lazily angelegte Free-Zeile der Organisation.
//
// All operations are best-effort wrt persist-bus: a billing-table
// failure must NEVER block a producer's persist write.

import { Pool, type PoolClient } from "pg";
import type { Logger } from "pino";
import { HTTPException } from "hono/http-exception";
import { TIER_LIMITS } from "./billing-plans";

/** Tier values the gateway recognizes. Stripe webhooks flip a tenant
 *  between these. Schema is `String` so adding a new tier is data-only. */
export type BillingTier = "free" | "starter" | "pro" | "enterprise";
/** B1 — Abrechnungsart des Kontos. */
export type BillingMode = "none" | "subscription" | "seats" | "enterprise";
/** B1 — Zahlungszustand des Kontos. */
export type BillingStatus = "active" | "past_due" | "suspended" | "canceled";

/** Default tier + quota for accounts that have no `TenantBilling` row
 *  yet (i.e. brand-new accounts). 25 lifetime cold companies. */
const FREE_DEFAULT_LIMIT = 25;

type Q = { query: Pool["query"] };

/** Vollstaendige Kontozeile (TenantBilling). */
export interface BillingAccount {
  id: string;
  kind: "personal" | "organisation";
  mode: BillingMode;
  tier: BillingTier;
  quotaLimit: number;
  status: BillingStatus;
  pastDueSince: Date | null;
  suspendedAt: Date | null;
  graceDays: number;
  stripeCustomerId: string | null;
  stripeSubscriptionId: string | null;
  periodEnd: Date | null;
  cancelAtPeriodEnd: boolean;
  seatTier: "starter" | "pro" | null;
  seatBillingSince: Date | null;
  seatBillingEndsAt: Date | null;
  maxSeats: number | null;
  karenzTag: number | null;
}

const ACCOUNT_COLUMNS = `"tenantId", "kind", "mode", tier, "quotaLimit", "status", "pastDueSince", "suspendedAt", "graceDays",
  "stripeCustomerId", "stripeSubscriptionId", "periodEnd", "cancelAtPeriodEnd", "seatTier", "seatBillingSince",
  "seatBillingEndsAt", "maxSeats", "karenzTag"`;

interface AccountRow {
  tenantId: string;
  kind: string;
  mode: string;
  tier: string;
  quotaLimit: number;
  status: string;
  pastDueSince: Date | null;
  suspendedAt: Date | null;
  graceDays: number;
  stripeCustomerId: string | null;
  stripeSubscriptionId: string | null;
  periodEnd: Date | null;
  cancelAtPeriodEnd: boolean;
  seatTier: string | null;
  seatBillingSince: Date | null;
  seatBillingEndsAt: Date | null;
  maxSeats: number | null;
  karenzTag: number | null;
}

function mapAccount(r: AccountRow): BillingAccount {
  return {
    id: r.tenantId,
    kind: r.kind === "organisation" ? "organisation" : "personal",
    mode: (["none", "subscription", "seats", "enterprise"].includes(r.mode) ? r.mode : "none") as BillingMode,
    tier: (["free", "starter", "pro", "enterprise"].includes(r.tier) ? r.tier : "free") as BillingTier,
    quotaLimit: r.quotaLimit,
    status: (["active", "past_due", "suspended", "canceled"].includes(r.status) ? r.status : "active") as BillingStatus,
    pastDueSince: r.pastDueSince,
    suspendedAt: r.suspendedAt,
    graceDays: r.graceDays,
    stripeCustomerId: r.stripeCustomerId,
    stripeSubscriptionId: r.stripeSubscriptionId,
    periodEnd: r.periodEnd,
    cancelAtPeriodEnd: r.cancelAtPeriodEnd,
    seatTier: r.seatTier === "starter" || r.seatTier === "pro" ? r.seatTier : null,
    seatBillingSince: r.seatBillingSince,
    seatBillingEndsAt: r.seatBillingEndsAt,
    maxSeats: r.maxSeats,
    karenzTag: r.karenzTag,
  };
}

/** Kontozeile lesen (null, wenn noch nie angelegt). */
export async function readBillingAccount(q: Q, id: string, forUpdate = false): Promise<BillingAccount | null> {
  const r = await q.query<AccountRow>(
    `SELECT ${ACCOUNT_COLUMNS} FROM "TenantBilling" WHERE "tenantId" = $1${forUpdate ? " FOR UPDATE" : ""}`,
    [id],
  );
  return r.rows[0] ? mapAccount(r.rows[0]) : null;
}

/** Look up or lazily-create a billing account row. Lazy create gives
 *  brand-new accounts the free-tier defaults without an explicit
 *  provisioning step. `kind` wird nur beim Anlegen gesetzt. */
export async function ensureBillingAccount(
  q: Q,
  id: string,
  kind: "personal" | "organisation" = "personal",
  forUpdate = false,
): Promise<BillingAccount> {
  const existing = await readBillingAccount(q, id, forUpdate);
  if (existing) return existing;
  await q.query(
    `INSERT INTO "TenantBilling" ("tenantId", "kind", "mode", tier, "quotaLimit", "updatedAt", "createdAt")
     VALUES ($1, $2, 'none', 'free', $3, NOW(), NOW())
     ON CONFLICT ("tenantId") DO NOTHING`,
    [id, kind, FREE_DEFAULT_LIMIT],
  );
  return (await readBillingAccount(q, id, forUpdate)) ?? {
    id,
    kind,
    mode: "none",
    tier: "free",
    quotaLimit: FREE_DEFAULT_LIMIT,
    status: "active",
    pastDueSince: null,
    suspendedAt: null,
    graceDays: 14,
    stripeCustomerId: null,
    stripeSubscriptionId: null,
    periodEnd: null,
    cancelAtPeriodEnd: false,
    seatTier: null,
    seatBillingSince: null,
    seatBillingEndsAt: null,
    maxSeats: null,
    karenzTag: null,
  };
}

// ---- B1 — Aufloesung Daten-Tenant → Abrechnungskonto ------------------------

const RESOLVE_TTL_MS = 60_000;
const orgModeCache = new Map<string, { zahltFuerMitglieder: boolean; bis: number }>();

/** Cache leeren, wenn sich der Modus einer Organisation aendert. */
export function invalidateBillingResolution(tenantId: string): void {
  orgModeCache.delete(tenantId);
}

/** Zahlt der Tenant fuer seine Mitglieder (Sammelabrechnung/Enterprise)? */
export async function tenantPaysForMembers(q: Q, tenantId: string): Promise<boolean> {
  const hit = orgModeCache.get(tenantId);
  if (hit && hit.bis > Date.now()) return hit.zahltFuerMitglieder;
  const acc = await readBillingAccount(q, tenantId);
  const zahlt = !!acc && (acc.mode === "seats" || acc.mode === "enterprise");
  orgModeCache.set(tenantId, { zahltFuerMitglieder: zahlt, bis: Date.now() + RESOLVE_TTL_MS });
  return zahlt;
}

/** Konto fuer (Daten-Tenant, Akteur). Ohne Akteur (Alt-Clients,
 *  Operator-Aufrufe) bleibt es der Tenant — das entspricht dem Verhalten
 *  vor B1 und ist fuer persoenliche Tenants (id = sub) ohnehin identisch. */
export async function resolveBillingAccountId(
  q: Q,
  ctx: { tenantId: string; actorId?: string | null },
): Promise<string> {
  const actorId = ctx.actorId ?? null;
  if (!actorId || actorId === ctx.tenantId) return ctx.tenantId;
  return (await tenantPaysForMembers(q, ctx.tenantId)) ? ctx.tenantId : actorId;
}

/** True when this tier shouldn't be enforced — today: only "enterprise". */
export function isUnlimited(tier: BillingTier): boolean {
  return tier === "enterprise";
}

/** Wirksames Tier eines Kontos (aus Modus + Spalten). */
export function effectiveTier(acc: BillingAccount): BillingTier {
  if (acc.mode === "enterprise") return "enterprise";
  if (acc.mode === "seats") return acc.seatTier ?? "starter";
  if (acc.mode === "subscription") return acc.tier;
  // mode none: Operator kann tier trotzdem gesetzt haben (Altbestand).
  return acc.tier;
}

/** Compute the right `periodKey` for a tier at a given moment.
 *  - free: a single bucket forever ("lifetime")
 *  - paid tiers: rolling-monthly, keyed on UTC YYYY-MM. */
export function periodKeyFor(tier: BillingTier, now: Date = new Date()): string {
  if (tier === "free") return "lifetime";
  const y = now.getUTCFullYear();
  const m = String(now.getUTCMonth() + 1).padStart(2, "0");
  return `${y}-${m}`;
}

/** First moment AFTER the current period. Returns null for free +
 *  enterprise — they don't roll. */
export function periodEndFor(tier: BillingTier, now: Date = new Date()): Date | null {
  if (tier === "free" || tier === "enterprise") return null;
  return new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() + 1, 1));
}

/** Aktuelle Mitgliederzahl einer Organisation (fuer das Seat-Kontingent). */
export async function currentMemberCount(q: Q, tenantId: string): Promise<number> {
  const r = await q.query<{ n: string }>(`SELECT COUNT(*)::text AS n FROM "TenantMember" WHERE "tenantId" = $1`, [tenantId]);
  return Number(r.rows[0]?.n ?? "0");
}

/** Kontingent eines Kontos im laufenden Monat. Seats: Summe der
 *  Seat-Kontingente aller aktuellen Mitglieder (R9). */
export async function quotaLimitFor(q: Q, acc: BillingAccount): Promise<number> {
  const tier = effectiveTier(acc);
  if (isUnlimited(tier)) return UNLIMITED;
  if (acc.mode === "seats") {
    const seats = await currentMemberCount(q, acc.id);
    return Math.max(1, seats) * TIER_LIMITS[tier];
  }
  return acc.quotaLimit;
}

/** Shape of the billing-row decision input. Exported alongside
 *  `ensureBillingRowForQuota` so the internal-quota route can re-use
 *  the same lazy-create logic from within an explicit transaction. */
export interface BillingRowSnapshot {
  tier: BillingTier;
  quotaLimit: number;
  periodEnd: Date | null;
  cancelAtPeriodEnd: boolean;
  status: BillingStatus;
  mode: BillingMode;
}

/** Q-track v0.1.137 — Same lazy-create-or-read but takes an explicit
 *  `PoolClient` so the caller can wrap it in `BEGIN…COMMIT` and lock the
 *  row (`FOR UPDATE`) to serialize the try-reserve decision. */
export async function ensureBillingRowForQuota(
  client: PoolClient,
  billingAccountId: string,
): Promise<BillingRowSnapshot> {
  const acc = await ensureBillingAccount(client, billingAccountId, "personal", true);
  return {
    tier: effectiveTier(acc),
    quotaLimit: await quotaLimitFor(client, acc),
    periodEnd: acc.periodEnd,
    cancelAtPeriodEnd: acc.cancelAtPeriodEnd,
    status: acc.status,
    mode: acc.mode,
  };
}

/** Record a usage credit for a successful structured-content persist.
 *  Idempotent on (billingAccountId, periodKey, companyId). */
export async function recordUsage(
  pool: Pool,
  log: Logger,
  args: {
    tenantId: string;
    actorId?: string | null;
    companyId: string;
    source: "structured-content";
  },
): Promise<void> {
  try {
    const billingAccountId = await resolveBillingAccountId(pool, { tenantId: args.tenantId, actorId: args.actorId });
    // Organisationskonten existieren bereits (Aktivierung); lazily
    // angelegt werden nur persoenliche Konten.
    const acc = await ensureBillingAccount(pool, billingAccountId, "personal");
    const periodKey = periodKeyFor(effectiveTier(acc));
    const res = await pool.query(
      `INSERT INTO "UsageEntry"
         ("billingAccountId", "periodKey", "companyId", source, "createdAt")
       VALUES ($1, $2, $3, $4, NOW())
       ON CONFLICT ("billingAccountId", "periodKey", "companyId") DO NOTHING`,
      [billingAccountId, periodKey, args.companyId, args.source],
    );
    log.info(
      {
        tenantId: args.tenantId,
        billingAccountId,
        companyId: args.companyId,
        periodKey,
        billed: (res.rowCount ?? 0) > 0,
        tier: effectiveTier(acc),
      },
      (res.rowCount ?? 0) > 0 ? "usage debited" : "usage already debited (no-op)",
    );
  } catch (err) {
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

/** B1 — Berechtigungsquelle, die der Desktop anzeigt. */
export interface Entitlement {
  tier: BillingTier;
  /** personal = eigenes Konto; seat = Sammelabrechnung der Organisation; enterprise = Vertrag. */
  source: "personal" | "seat" | "enterprise";
  billingAccountId: string;
  /** Name der zahlenden Organisation (nur bei seat/enterprise ueber eine Organisation). */
  paidBy: string | null;
  status: BillingStatus;
  mode: BillingMode;
  /** Sammelabrechnung: Details fuer die Anzeige. */
  seats: {
    tier: "starter" | "pro";
    count: number;
    since: string | null;
    endsAt: string | null;
    tierNext: "starter" | "pro" | null;
    tierNextFrom: string | null;
    maxSeats: number | null;
  } | null;
  /** Persoenliches Stripe-Abo laeuft (noch), obwohl ein Seat traegt. */
  personalSubscription: { tier: BillingTier; cancelAtPeriodEnd: boolean; periodEnd: string | null } | null;
}

/** Snapshot returned by `getUsageSnapshot` and shipped to clients
 *  via `GET /v1/usage`. The desktop renders this directly. */
export interface UsageSnapshot {
  tier: BillingTier;
  used: number;
  /** -1 sentinel = no enforcement (enterprise). */
  limit: number;
  remaining: number;
  /** ISO-8601. null for free + enterprise (no rolling reset). */
  periodEnd: string | null;
  /** "lifetime" | "YYYY-MM" | "unlimited" */
  periodKey: string;
  cancelAtPeriodEnd: boolean;
  /** Q-track v0.1.137 — count of `ParkedCompany` rows waiting on quota headroom. */
  parkedCount: number;
  /** B1 */
  status: BillingStatus;
  entitlement: Entitlement;
}

export const UNLIMITED = -1;

async function pendingSeatTierChange(
  q: Q,
  tenantId: string,
): Promise<{ tier: string; validFrom: Date } | null> {
  const r = await q.query<{ tier: string; validFrom: Date }>(
    `SELECT "tier", "validFrom" FROM "SeatTierChange" WHERE "tenantId" = $1 AND "validFrom" > NOW() ORDER BY "validFrom" LIMIT 1`,
    [tenantId],
  );
  return r.rows[0] ?? null;
}

/** Compute the usage snapshot for the account that (tenantId, actorId)
 *  resolves to. Backed by the index on ("billingAccountId", "periodKey"). */
export async function getUsageSnapshot(
  pool: Pool,
  ctx: { tenantId: string; actorId?: string | null },
): Promise<UsageSnapshot> {
  const billingAccountId = await resolveBillingAccountId(pool, ctx);
  const istOrgKonto = billingAccountId === ctx.tenantId && !!ctx.actorId && ctx.actorId !== ctx.tenantId;
  const acc = await ensureBillingAccount(pool, billingAccountId, istOrgKonto ? "organisation" : "personal");
  const tier = effectiveTier(acc);
  const periodKey = periodKeyFor(tier);
  const periodEnd = acc.mode === "seats" ? periodEndFor(tier) : (acc.periodEnd ?? periodEndFor(tier));

  const countRes = await pool.query<{ used: string }>(
    `SELECT COUNT(*)::text AS used FROM "UsageEntry" WHERE "billingAccountId" = $1 AND "periodKey" = $2`,
    [billingAccountId, periodKey],
  );
  const used = Number(countRes.rows[0]?.used ?? 0);

  // Parked rows live on the DATA tenant (the import belongs there).
  const parkedRes = await pool.query<{ parked: string }>(
    `SELECT COUNT(*)::text AS parked FROM "ParkedCompany" WHERE "tenantId" = $1`,
    [ctx.tenantId],
  );
  const parkedCount = Number(parkedRes.rows[0]?.parked ?? 0);

  const limit = await quotaLimitFor(pool, acc);
  const remaining = limit === UNLIMITED ? UNLIMITED : Math.max(0, limit - used);

  // Entitlement
  let paidBy: string | null = null;
  let seats: Entitlement["seats"] = null;
  let personalSubscription: Entitlement["personalSubscription"] = null;
  if (istOrgKonto) {
    const t = await pool.query<{ name: string | null }>(`SELECT "name" FROM "Tenant" WHERE "id" = $1`, [billingAccountId]);
    paidBy = t.rows[0]?.name ?? null;
    if (ctx.actorId) {
      const pers = await readBillingAccount(pool, ctx.actorId);
      if (pers && pers.mode === "subscription" && pers.stripeSubscriptionId && pers.status !== "canceled") {
        personalSubscription = {
          tier: pers.tier,
          cancelAtPeriodEnd: pers.cancelAtPeriodEnd,
          periodEnd: pers.periodEnd ? pers.periodEnd.toISOString() : null,
        };
      }
    }
  }
  if (acc.mode === "seats") {
    const pending = await pendingSeatTierChange(pool, acc.id);
    seats = {
      tier: acc.seatTier ?? "starter",
      count: await currentMemberCount(pool, acc.id),
      since: acc.seatBillingSince ? acc.seatBillingSince.toISOString() : null,
      endsAt: acc.seatBillingEndsAt ? acc.seatBillingEndsAt.toISOString() : null,
      tierNext: pending && (pending.tier === "starter" || pending.tier === "pro") ? pending.tier : null,
      tierNextFrom: pending && pending.tier !== "none" ? pending.validFrom.toISOString() : null,
      maxSeats: acc.maxSeats,
    };
  }

  return {
    tier,
    used,
    limit,
    remaining,
    periodEnd: periodEnd ? periodEnd.toISOString() : null,
    periodKey: isUnlimited(tier) ? "unlimited" : periodKey,
    cancelAtPeriodEnd: acc.mode === "subscription" ? acc.cancelAtPeriodEnd : false,
    parkedCount,
    status: acc.status,
    entitlement: {
      tier,
      source: acc.mode === "enterprise" ? "enterprise" : istOrgKonto ? "seat" : "personal",
      billingAccountId,
      paidBy,
      status: acc.status,
      mode: acc.mode,
      seats,
      personalSubscription,
    },
  };
}

/** M2 — pre-import gate. Throws a structured `402` HTTPException when
 *  the account is suspended or `used + neededCount > limit`. */
export async function assertQuotaAvailable(
  pool: Pool,
  ctx: { tenantId: string; actorId?: string | null },
  neededCount: number,
): Promise<UsageSnapshot> {
  const snapshot = await getUsageSnapshot(pool, ctx);
  if (snapshot.status === "suspended") {
    throw new HTTPException(402, {
      res: new Response(
        JSON.stringify({ error: "billing_suspended", tier: snapshot.tier, upgradeUrl: "ava://billing/upgrade" }),
        { status: 402, headers: { "content-type": "application/json" } },
      ),
    });
  }
  if (snapshot.limit === UNLIMITED) return snapshot;
  const wouldUse = snapshot.used + Math.max(0, neededCount);
  if (wouldUse <= snapshot.limit) return snapshot;
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

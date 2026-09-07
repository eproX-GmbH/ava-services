// B2 (docs/PLAN_ABRECHNUNG_SEATS.md) — Seat-Sammelabrechnung „Belegungsmonat".
//
// Regeln (§3.1):
//   R1  Periode = UTC-Kalendermonat (= periodKey YYYY-MM), Datensatz am 1.
//   R2  Seat zaehlt, wenn die Mitgliedschaft an >= 1 Tages-Stichtag
//       (00:00 UTC) des Monats bestand — je Person, nicht je Platz.
//   R3  Tier je Seat = hoechstes Tier an einem gezaehlten Stichtag.
//   R4  Downgrade/Deaktivierung wirken zum naechsten Monatsersten.
//   R5/R6  Austritt sofort, Seat bleibt gezaehlt; Beitritt zaehlt ab dem
//       ersten Stichtag; gleicher Tag rein/raus = kein Seat.
//   A-2 (2026-09-06): Nur der Datensatz wird erzeugt (SeatInvoice*),
//       Stripe Invoicing kommt spaeter — status "recorded".
//   A-3 Karenzband: Operator-Schalter karenzTag; Seats, deren erster
//       Stichtag nach diesem Tag liegt, zaehlen erst im Folgemonat.
//
// Die reine Zaehlung (computeSeats) ist DB-frei und wird von
// scripts/test-seat-billing.mjs mit den Beispielen aus §3.2/§7 geprueft.

import type pg from "pg";
import { createHash, randomBytes } from "node:crypto";
import type { AuthContext } from "../middleware/auth";
import { TenantError } from "./tenant-error";
import { TIER_LIMITS, seatPriceCents, isSeatTier, type SeatTier } from "./billing-plans";
import { ensureBillingAccount, readBillingAccount, invalidateBillingResolution, type BillingAccount } from "./billing";
import { recordBillingEvent, listBillingEvents, type BillingEventRow } from "./billing-events";
import { logger } from "./logger";

type Q = { query: pg.Pool["query"] };

// ---- Perioden ----------------------------------------------------------------

export function periodKeyOf(d: Date): string {
  return `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, "0")}`;
}

export function periodBounds(periodKey: string): { start: Date; end: Date; days: number } {
  const m = /^(\d{4})-(\d{2})$/.exec(periodKey);
  if (!m) throw new TenantError(400, `Ungueltige Periode: ${periodKey}`);
  const y = Number(m[1]);
  const mo = Number(m[2]) - 1;
  const start = new Date(Date.UTC(y, mo, 1));
  const end = new Date(Date.UTC(y, mo + 1, 1));
  return { start, end, days: Math.round((end.getTime() - start.getTime()) / 86_400_000) };
}

export function nextPeriodStart(now: Date = new Date()): Date {
  return new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() + 1, 1));
}

export function previousPeriodKey(now: Date = new Date()): string {
  return periodKeyOf(new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() - 1, 1)));
}

function dayKey(d: Date): string {
  return d.toISOString().slice(0, 10);
}

// ---- Reine Zaehlung -------------------------------------------------------------

export type TimelineTier = SeatTier | "none";

export interface MembershipInterval {
  actorId: string;
  email: string | null;
  name: string | null;
  joinedAt: Date;
  leftAt: Date | null;
}

export interface TierChange {
  tier: TimelineTier;
  validFrom: Date;
}

export interface SeatRow {
  actorId: string;
  email: string | null;
  name: string | null;
  tier: SeatTier;
  firstCountedDay: string;
  lastCountedDay: string;
  countedDays: number;
}

export interface LineRow {
  tier: SeatTier;
  seats: number;
  unitPriceCents: number;
  amountCents: number;
}

export interface SeatComputation {
  periodKey: string;
  seats: SeatRow[];
  lines: LineRow[];
  seatCount: number;
  subtotalCents: number;
  computeHash: string;
}

/** Tier an einem Zeitpunkt: letzte Aenderung mit validFrom <= t; ohne Eintrag "none". */
export function tierAt(timeline: TierChange[], t: Date): TimelineTier {
  let tier: TimelineTier = "none";
  for (const c of timeline) {
    if (c.validFrom.getTime() <= t.getTime()) tier = c.tier;
    else break;
  }
  return tier;
}

const TIER_RANK: Record<SeatTier, number> = { starter: 1, pro: 2 };

export function computeSeats(input: {
  periodKey: string;
  memberships: MembershipInterval[];
  timeline: TierChange[];
  karenzTag?: number | null;
  prices?: (tier: SeatTier) => number;
}): SeatComputation {
  const { start, days } = periodBounds(input.periodKey);
  const timeline = [...input.timeline].sort((a, b) => a.validFrom.getTime() - b.validFrom.getTime());
  const prices = input.prices ?? seatPriceCents;
  const acc = new Map<string, SeatRow>();
  // Identitaet je Akteur: juengstes Intervall liefert E-Mail/Name.
  const ident = new Map<string, { email: string | null; name: string | null; at: number }>();
  for (const m of input.memberships) {
    const prev = ident.get(m.actorId);
    if (!prev || m.joinedAt.getTime() > prev.at) ident.set(m.actorId, { email: m.email, name: m.name, at: m.joinedAt.getTime() });
  }
  for (let k = 0; k < days; k++) {
    const D = new Date(start.getTime() + k * 86_400_000);
    const tier = tierAt(timeline, D);
    if (tier === "none") continue;
    for (const m of input.memberships) {
      if (m.joinedAt.getTime() > D.getTime()) continue;
      if (m.leftAt && m.leftAt.getTime() <= D.getTime()) continue;
      const day = dayKey(D);
      const row = acc.get(m.actorId);
      if (!row) {
        const id = ident.get(m.actorId);
        acc.set(m.actorId, {
          actorId: m.actorId,
          email: id?.email ?? null,
          name: id?.name ?? null,
          tier,
          firstCountedDay: day,
          lastCountedDay: day,
          countedDays: 1,
        });
      } else if (row.lastCountedDay !== day) {
        row.lastCountedDay = day;
        row.countedDays += 1;
        if (TIER_RANK[tier] > TIER_RANK[row.tier]) row.tier = tier;
      }
    }
  }
  let seats = Array.from(acc.values());
  if (input.karenzTag && input.karenzTag >= 1 && input.karenzTag <= 31) {
    const grenze = input.karenzTag;
    seats = seats.filter((s) => Number(s.firstCountedDay.slice(8, 10)) <= grenze);
  }
  seats.sort((a, b) => (a.name ?? a.email ?? a.actorId).localeCompare(b.name ?? b.email ?? b.actorId, "de"));
  const lines: LineRow[] = [];
  for (const tier of ["starter", "pro"] as SeatTier[]) {
    const n = seats.filter((s) => s.tier === tier).length;
    if (n === 0) continue;
    const unit = prices(tier);
    lines.push({ tier, seats: n, unitPriceCents: unit, amountCents: n * unit });
  }
  const subtotalCents = lines.reduce((s, l) => s + l.amountCents, 0);
  const canonical = JSON.stringify({
    periodKey: input.periodKey,
    seats: seats.map((s) => [s.actorId, s.tier, s.firstCountedDay, s.lastCountedDay, s.countedDays]),
    lines: lines.map((l) => [l.tier, l.seats, l.unitPriceCents]),
  });
  return {
    periodKey: input.periodKey,
    seats,
    lines,
    seatCount: seats.length,
    subtotalCents,
    computeHash: createHash("sha256").update(canonical).digest("hex"),
  };
}

// ---- DB-Zugriffe --------------------------------------------------------------

export async function loadTimeline(q: Q, tenantId: string): Promise<TierChange[]> {
  const r = await q.query<{ tier: string; validFrom: Date }>(
    `SELECT "tier", "validFrom" FROM "SeatTierChange" WHERE "tenantId" = $1 ORDER BY "validFrom", "createdAt"`,
    [tenantId],
  );
  return r.rows.map((x) => ({ tier: (isSeatTier(x.tier) ? x.tier : "none") as TimelineTier, validFrom: new Date(x.validFrom) }));
}

export async function loadMemberships(q: Q, tenantId: string, start: Date, end: Date): Promise<MembershipInterval[]> {
  const r = await q.query<{ actorId: string; email: string | null; name: string | null; joinedAt: Date; leftAt: Date | null }>(
    `SELECT "actorId", "email", "name", "joinedAt", "leftAt" FROM "TenantMembership"
      WHERE "tenantId" = $1 AND "joinedAt" < $3 AND ("leftAt" IS NULL OR "leftAt" > $2)`,
    [tenantId, start, end],
  );
  return r.rows.map((x) => ({ ...x, joinedAt: new Date(x.joinedAt), leftAt: x.leftAt ? new Date(x.leftAt) : null }));
}

export async function computeSeatsForPeriod(q: Q, tenantId: string, periodKey: string, karenzTag?: number | null): Promise<SeatComputation> {
  const { start, end } = periodBounds(periodKey);
  const [memberships, timeline] = await Promise.all([loadMemberships(q, tenantId, start, end), loadTimeline(q, tenantId)]);
  return computeSeats({ periodKey, memberships, timeline, karenzTag });
}

// ---- Rollen -----------------------------------------------------------------------

async function rolle(q: Q, tenantId: string, actorId: string): Promise<string | null> {
  const r = await q.query<{ role: string }>(`SELECT "role" FROM "TenantMember" WHERE "tenantId" = $1 AND "actorId" = $2`, [tenantId, actorId]);
  return r.rows[0]?.role ?? null;
}

async function requireOwner(q: Q, auth: AuthContext): Promise<void> {
  if ((await rolle(q, auth.tenantId, auth.actorId)) !== "owner") throw new TenantError(403, "Nur der Owner darf die Abrechnung aendern.");
}

async function requireAdmin(q: Q, auth: AuthContext): Promise<void> {
  const r = await rolle(q, auth.tenantId, auth.actorId);
  if (r !== "owner" && r !== "admin") throw new TenantError(403, "Nur Admins sehen die Abrechnung.");
}

async function requireOrganisation(q: Q, tenantId: string): Promise<{ name: string | null }> {
  const r = await q.query<{ kind: string; name: string | null }>(`SELECT "kind", "name" FROM "Tenant" WHERE "id" = $1`, [tenantId]);
  if (r.rows[0]?.kind !== "organisation") throw new TenantError(409, "Sammelabrechnung gibt es nur fuer Organisationen.");
  return { name: r.rows[0].name };
}

// ---- Zustand fuer die Anzeige --------------------------------------------------------

export interface SeatInvoiceSummary {
  id: string;
  periodKey: string;
  status: string;
  currency: string;
  seatCount: number;
  subtotalCents: number;
  totalCents: number;
  computedAt: string;
  computeHash: string;
  lines: LineRow[];
}

export interface SeatInvoiceDetail extends SeatInvoiceSummary {
  seats: SeatRow[];
  note: string | null;
}

export interface SeatBillingState {
  tenantId: string;
  tenantName: string | null;
  mode: BillingAccount["mode"];
  status: BillingAccount["status"];
  seatTier: SeatTier | null;
  since: string | null;
  endsAt: string | null;
  tierNext: SeatTier | null;
  tierNextFrom: string | null;
  maxSeats: number | null;
  karenzTag: number | null;
  memberCount: number;
  prices: Record<SeatTier, number>;
  /** Laufender Monat: bisher gezaehlte Seats (Stichtage bis heute). */
  currentPeriod: SeatComputation;
  /** Prognose: alle aktuellen Mitglieder × aktuelles Tier (Stand jetzt). */
  projectedCents: number;
  invoices: SeatInvoiceSummary[];
  events: BillingEventRow[];
}

async function pendingChange(q: Q, tenantId: string): Promise<{ tier: TimelineTier; validFrom: Date; id: string } | null> {
  const r = await q.query<{ id: string; tier: string; validFrom: Date }>(
    `SELECT "id", "tier", "validFrom" FROM "SeatTierChange" WHERE "tenantId" = $1 AND "validFrom" > NOW() ORDER BY "validFrom" LIMIT 1`,
    [tenantId],
  );
  const row = r.rows[0];
  return row ? { id: row.id, tier: (isSeatTier(row.tier) ? row.tier : "none") as TimelineTier, validFrom: new Date(row.validFrom) } : null;
}

export async function getSeatBillingState(pool: pg.Pool, auth: AuthContext): Promise<SeatBillingState> {
  const { name } = await requireOrganisation(pool, auth.tenantId);
  await requireAdmin(pool, auth);
  const acc = await ensureBillingAccount(pool, auth.tenantId, "organisation");
  const members = await pool.query<{ n: string }>(`SELECT COUNT(*)::text AS n FROM "TenantMember" WHERE "tenantId" = $1`, [auth.tenantId]);
  const memberCount = Number(members.rows[0]?.n ?? "0");
  const now = new Date();
  const current = await computeSeatsForPeriod(pool, auth.tenantId, periodKeyOf(now), acc.karenzTag);
  const pending = await pendingChange(pool, auth.tenantId);
  const tier = acc.seatTier;
  const projectedCents = acc.mode === "seats" && tier ? Math.max(memberCount, current.seatCount) * seatPriceCents(tier) : 0;
  return {
    tenantId: auth.tenantId,
    tenantName: name,
    mode: acc.mode,
    status: acc.status,
    seatTier: tier,
    since: acc.seatBillingSince ? acc.seatBillingSince.toISOString() : null,
    endsAt: acc.seatBillingEndsAt ? acc.seatBillingEndsAt.toISOString() : null,
    tierNext: pending && isSeatTier(pending.tier) ? pending.tier : null,
    tierNextFrom: pending && isSeatTier(pending.tier) ? pending.validFrom.toISOString() : null,
    maxSeats: acc.maxSeats,
    karenzTag: acc.karenzTag,
    memberCount,
    prices: { starter: seatPriceCents("starter"), pro: seatPriceCents("pro") },
    currentPeriod: current,
    projectedCents,
    invoices: await listSeatInvoices(pool, auth.tenantId),
    events: await listBillingEvents(pool, auth.tenantId, 30),
  };
}

// ---- Admin-Operationen ----------------------------------------------------------

function idFor(prefix: string): string {
  return `${prefix}_${randomBytes(9).toString("base64url")}`;
}

/** Sammelabrechnung aktivieren (Owner). Wirkt sofort (R7). */
export async function activateSeats(
  pool: pg.Pool,
  auth: AuthContext,
  tier: SeatTier,
): Promise<{ memberCount: number; personalSubscriptionsScheduled: string[] }> {
  await requireOrganisation(pool, auth.tenantId);
  await requireOwner(pool, auth);
  const client = await pool.connect();
  let memberIds: string[] = [];
  try {
    await client.query("BEGIN");
    const acc = await ensureBillingAccount(client, auth.tenantId, "organisation", true);
    if (acc.mode === "seats") throw new TenantError(409, "Sammelabrechnung ist bereits aktiv.");
    if (acc.mode === "enterprise") throw new TenantError(409, "Diese Organisation hat einen Enterprise-Vertrag; die Abrechnung pflegt der Betreiber.");
    await client.query(
      `UPDATE "TenantBilling" SET "kind" = 'organisation', "mode" = 'seats', "seatTier" = $2, tier = $2, "quotaLimit" = $3,
              "seatBillingSince" = NOW(), "seatBillingEndsAt" = NULL, "status" = 'active', "updatedAt" = NOW()
        WHERE "tenantId" = $1`,
      [auth.tenantId, tier, TIER_LIMITS[tier]],
    );
    await client.query(
      `INSERT INTO "SeatTierChange" ("id", "tenantId", "tier", "validFrom", "createdBy") VALUES ($1, $2, $3, NOW(), $4)`,
      [idFor("stc"), auth.tenantId, tier, auth.actorId],
    );
    const m = await client.query<{ actorId: string }>(`SELECT "actorId" FROM "TenantMember" WHERE "tenantId" = $1`, [auth.tenantId]);
    memberIds = m.rows.map((x) => x.actorId);
    await recordBillingEvent(client, {
      billingAccountId: auth.tenantId,
      kind: "seat_billing_activated",
      source: "admin",
      actorId: auth.actorId,
      payload: { tier, memberCount: memberIds.length, unitPriceCents: seatPriceCents(tier) },
    });
    await client.query("COMMIT");
  } catch (err) {
    await client.query("ROLLBACK").catch(() => undefined);
    throw err;
  } finally {
    client.release();
  }
  invalidateBillingResolution(auth.tenantId);
  // A-5 — persoenliche Abos der Mitglieder zum Periodenende kuendigen (best-effort).
  const scheduled = await scheduleCancelPersonalSubscriptions(pool, memberIds, { orgId: auth.tenantId, actorId: auth.actorId });
  return { memberCount: memberIds.length, personalSubscriptionsScheduled: scheduled };
}

/** Deaktivierung zum naechsten Monatsersten vormerken bzw. zuruecknehmen (Owner, R8). */
export async function deactivateSeats(pool: pg.Pool, auth: AuthContext, revoke = false): Promise<{ endsAt: string | null }> {
  await requireOrganisation(pool, auth.tenantId);
  await requireOwner(pool, auth);
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    const acc = await ensureBillingAccount(client, auth.tenantId, "organisation", true);
    if (acc.mode !== "seats") throw new TenantError(409, "Sammelabrechnung ist nicht aktiv.");
    // Vorgemerkte Aenderungen zum naechsten 1. ersetzen.
    await client.query(`DELETE FROM "SeatTierChange" WHERE "tenantId" = $1 AND "validFrom" > NOW()`, [auth.tenantId]);
    let endsAt: Date | null = null;
    if (!revoke) {
      endsAt = nextPeriodStart();
      await client.query(
        `INSERT INTO "SeatTierChange" ("id", "tenantId", "tier", "validFrom", "createdBy") VALUES ($1, $2, 'none', $3, $4)`,
        [idFor("stc"), auth.tenantId, endsAt, auth.actorId],
      );
    }
    await client.query(`UPDATE "TenantBilling" SET "seatBillingEndsAt" = $2, "updatedAt" = NOW() WHERE "tenantId" = $1`, [auth.tenantId, endsAt]);
    await recordBillingEvent(client, {
      billingAccountId: auth.tenantId,
      kind: revoke ? "seat_billing_deactivation_revoked" : "seat_billing_deactivation_scheduled",
      source: "admin",
      actorId: auth.actorId,
      payload: { endsAt: endsAt ? endsAt.toISOString() : null },
    });
    await client.query("COMMIT");
    return { endsAt: endsAt ? endsAt.toISOString() : null };
  } catch (err) {
    await client.query("ROLLBACK").catch(() => undefined);
    throw err;
  } finally {
    client.release();
  }
}

/** Organisations-Tier setzen (Owner): Upgrade sofort, Downgrade zum naechsten 1. (R3/R4). */
export async function setSeatTier(pool: pg.Pool, auth: AuthContext, tier: SeatTier): Promise<{ effectiveFrom: string; immediate: boolean }> {
  await requireOrganisation(pool, auth.tenantId);
  await requireOwner(pool, auth);
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    const acc = await ensureBillingAccount(client, auth.tenantId, "organisation", true);
    if (acc.mode !== "seats" || !acc.seatTier) throw new TenantError(409, "Sammelabrechnung ist nicht aktiv.");
    const pending = await pendingChange(client, auth.tenantId);
    if (pending && pending.tier === "none") throw new TenantError(409, "Die Sammelabrechnung ist zum Monatsende vorgemerkt beendet. Erst die Beendigung zuruecknehmen.");
    const upgrade = TIER_RANK[tier] > TIER_RANK[acc.seatTier];
    await client.query(`DELETE FROM "SeatTierChange" WHERE "tenantId" = $1 AND "validFrom" > NOW()`, [auth.tenantId]);
    let from: Date;
    if (upgrade) {
      from = new Date();
      await client.query(
        `INSERT INTO "SeatTierChange" ("id", "tenantId", "tier", "validFrom", "createdBy") VALUES ($1, $2, $3, NOW(), $4)`,
        [idFor("stc"), auth.tenantId, tier, auth.actorId],
      );
      await client.query(
        `UPDATE "TenantBilling" SET "seatTier" = $2, tier = $2, "quotaLimit" = $3, "updatedAt" = NOW() WHERE "tenantId" = $1`,
        [auth.tenantId, tier, TIER_LIMITS[tier]],
      );
    } else if (tier !== acc.seatTier) {
      from = nextPeriodStart();
      await client.query(
        `INSERT INTO "SeatTierChange" ("id", "tenantId", "tier", "validFrom", "createdBy") VALUES ($1, $2, $3, $4, $5)`,
        [idFor("stc"), auth.tenantId, tier, from, auth.actorId],
      );
    } else {
      // Gleiches Tier: nur eine vorgemerkte Aenderung zuruecknehmen.
      from = new Date();
    }
    await recordBillingEvent(client, {
      billingAccountId: auth.tenantId,
      kind: upgrade ? "seat_tier_upgraded" : tier !== acc.seatTier ? "seat_tier_downgrade_scheduled" : "seat_tier_change_revoked",
      source: "admin",
      actorId: auth.actorId,
      payload: { from: acc.seatTier, to: tier, effectiveFrom: from.toISOString() },
    });
    await client.query("COMMIT");
    invalidateBillingResolution(auth.tenantId);
    return { effectiveFrom: from.toISOString(), immediate: upgrade };
  } catch (err) {
    await client.query("ROLLBACK").catch(() => undefined);
    throw err;
  } finally {
    client.release();
  }
}

/** Seat-Deckel (Owner). null = kein Deckel. Bestehende Mitglieder bleiben (K17). */
export async function setSeatSettings(pool: pg.Pool, auth: AuthContext, patch: { maxSeats?: number | null }): Promise<void> {
  await requireOrganisation(pool, auth.tenantId);
  await requireOwner(pool, auth);
  if (patch.maxSeats !== undefined) {
    if (patch.maxSeats !== null && (patch.maxSeats < 1 || patch.maxSeats > 10_000)) throw new TenantError(400, "Seat-Deckel: 1 bis 10000 oder leer.");
    await ensureBillingAccount(pool, auth.tenantId, "organisation");
    await pool.query(`UPDATE "TenantBilling" SET "maxSeats" = $2, "updatedAt" = NOW() WHERE "tenantId" = $1`, [auth.tenantId, patch.maxSeats]);
    await recordBillingEvent(pool, { billingAccountId: auth.tenantId, kind: "max_seats_set", source: "admin", actorId: auth.actorId, payload: { maxSeats: patch.maxSeats } });
  }
}

/** Beitrittspruefung (K17): Deckel nur fuer neue Aufnahmen. */
export async function assertSeatAvailable(q: Q, tenantId: string): Promise<void> {
  const acc = await readBillingAccount(q, tenantId);
  if (!acc || acc.mode !== "seats" || acc.maxSeats == null) return;
  const n = await q.query<{ n: string }>(`SELECT COUNT(*)::text AS n FROM "TenantMember" WHERE "tenantId" = $1`, [tenantId]);
  if (Number(n.rows[0]?.n ?? "0") >= acc.maxSeats) {
    throw new TenantError(409, `Seat-Deckel erreicht (${acc.maxSeats}). Der Owner kann ihn unter Organisation → Abrechnung anheben.`);
  }
}

// ---- A-5 — persoenliche Abos beim Beitritt/Aktivierung ----------------------------------

/** Persoenliche Stripe-Abos zum Periodenende kuendigen (kein Refund, im
 *  Portal widerrufbar). Liefert die Akteure, bei denen es gesetzt wurde. */
export async function scheduleCancelPersonalSubscriptions(
  pool: pg.Pool,
  actorIds: string[],
  ctx: { orgId: string; actorId: string },
): Promise<string[]> {
  const done: string[] = [];
  for (const actorId of actorIds) {
    const pers = await readBillingAccount(pool, actorId);
    if (!pers || pers.mode !== "subscription" || !pers.stripeSubscriptionId || pers.cancelAtPeriodEnd || pers.status === "canceled") continue;
    try {
      const { getStripe } = await import("./stripe-client");
      const stripe = getStripe();
      await stripe.subscriptions.update(pers.stripeSubscriptionId, {
        cancel_at_period_end: true,
        metadata: { cancelReason: "org_seat_billing", orgId: ctx.orgId },
      });
      await pool.query(`UPDATE "TenantBilling" SET "cancelAtPeriodEnd" = TRUE, "updatedAt" = NOW() WHERE "tenantId" = $1`, [actorId]);
      await recordBillingEvent(pool, {
        billingAccountId: actorId,
        kind: "personal_subscription_cancel_scheduled",
        source: "system",
        actorId: ctx.actorId,
        payload: { reason: "org_seat_billing", orgId: ctx.orgId, subscriptionId: pers.stripeSubscriptionId, periodEnd: pers.periodEnd?.toISOString() ?? null },
      });
      done.push(actorId);
    } catch (err) {
      logger.warn({ actorId, err: err instanceof Error ? err.message : String(err) }, "[seat-billing] persoenliches Abo konnte nicht vorgemerkt werden");
      await recordBillingEvent(pool, {
        billingAccountId: actorId,
        kind: "personal_subscription_cancel_failed",
        source: "system",
        actorId: ctx.actorId,
        payload: { reason: "org_seat_billing", orgId: ctx.orgId, error: err instanceof Error ? err.message : String(err) },
      });
    }
  }
  return done;
}

// ---- Monatsabschluss ---------------------------------------------------------------------

/** Datensatz fuer eine abgeschlossene Periode schreiben (idempotent, gesperrt). */
export async function closePeriod(
  pool: pg.Pool,
  tenantId: string,
  periodKey: string,
  source: "cron" | "admin" | "operator" = "cron",
  actorId: string | null = null,
): Promise<{ created: boolean; invoiceId: string; seatCount: number; subtotalCents: number }> {
  const { end } = periodBounds(periodKey);
  if (end.getTime() > Date.now()) throw new TenantError(409, `Periode ${periodKey} ist noch nicht abgeschlossen.`);
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    await client.query(`SELECT pg_advisory_xact_lock(hashtext($1))`, [`seat-invoice:${tenantId}:${periodKey}`]);
    const ex = await client.query<{ id: string; seatCount: number; subtotalCents: number }>(
      `SELECT "id", "seatCount", "subtotalCents" FROM "SeatInvoice" WHERE "tenantId" = $1 AND "periodKey" = $2`,
      [tenantId, periodKey],
    );
    if (ex.rows[0]) {
      await client.query("COMMIT");
      return { created: false, invoiceId: ex.rows[0].id, seatCount: ex.rows[0].seatCount, subtotalCents: ex.rows[0].subtotalCents };
    }
    const acc = await readBillingAccount(client, tenantId);
    const comp = await computeSeatsForPeriod(client, tenantId, periodKey, acc?.karenzTag);
    const status = acc?.mode === "enterprise" ? "enterprise_export" : "recorded";
    const id = idFor("si");
    await client.query(
      `INSERT INTO "SeatInvoice" ("id", "tenantId", "periodKey", "status", "currency", "subtotalCents", "totalCents", "seatCount", "computeHash")
       VALUES ($1, $2, $3, $4, 'EUR', $5, $5, $6, $7)`,
      [id, tenantId, periodKey, status, comp.subtotalCents, comp.seatCount, comp.computeHash],
    );
    for (const l of comp.lines) {
      await client.query(
        `INSERT INTO "SeatInvoiceLine" ("id", "invoiceId", "tier", "seats", "unitPriceCents", "amountCents") VALUES ($1, $2, $3, $4, $5, $6)`,
        [idFor("sl"), id, l.tier, l.seats, l.unitPriceCents, l.amountCents],
      );
    }
    for (const s of comp.seats) {
      await client.query(
        `INSERT INTO "SeatInvoiceSeat" ("id", "invoiceId", "actorId", "email", "name", "tier", "firstCountedDay", "lastCountedDay", "countedDays")
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)`,
        [idFor("ss"), id, s.actorId, s.email, s.name, s.tier, s.firstCountedDay, s.lastCountedDay, s.countedDays],
      );
    }
    await recordBillingEvent(client, {
      billingAccountId: tenantId,
      kind: "seat_invoice_recorded",
      source,
      actorId,
      payload: { periodKey, invoiceId: id, seatCount: comp.seatCount, subtotalCents: comp.subtotalCents, status, computeHash: comp.computeHash },
    });
    await client.query("COMMIT");
    return { created: true, invoiceId: id, seatCount: comp.seatCount, subtotalCents: comp.subtotalCents };
  } catch (err) {
    await client.query("ROLLBACK").catch(() => undefined);
    throw err;
  } finally {
    client.release();
  }
}

/** Alle Organisationen mit Tier-Zeitachse: fehlende Datensaetze fuer
 *  abgeschlossene Monate seit der ersten Aktivierung nachholen (K14). */
export async function closeCompletedPeriods(pool: pg.Pool, now: Date = new Date()): Promise<{ created: number; checked: number }> {
  const r = await pool.query<{ tenantId: string; first: Date }>(
    `SELECT "tenantId", MIN("validFrom") AS first FROM "SeatTierChange" GROUP BY "tenantId"`,
  );
  let created = 0;
  let checked = 0;
  const lastCompleted = previousPeriodKey(now);
  for (const row of r.rows) {
    const first = new Date(row.first);
    let cur = new Date(Date.UTC(first.getUTCFullYear(), first.getUTCMonth(), 1));
    // Hoechstens 36 Monate rueckwaerts — Schutz vor Endlosschleifen bei kaputten Daten.
    let guard = 0;
    while (periodKeyOf(cur) <= lastCompleted && guard++ < 36) {
      const pk = periodKeyOf(cur);
      checked++;
      try {
        const res = await closePeriod(pool, row.tenantId, pk, "cron");
        if (res.created) created++;
      } catch (err) {
        logger.warn({ tenantId: row.tenantId, periodKey: pk, err: err instanceof Error ? err.message : String(err) }, "[seat-billing] Monatsabschluss fehlgeschlagen");
      }
      cur = new Date(Date.UTC(cur.getUTCFullYear(), cur.getUTCMonth() + 1, 1));
    }
  }
  return { created, checked };
}

/** Vorgemerkte Tier-Aenderungen/Deaktivierungen, deren validFrom erreicht
 *  ist, auf das Konto anwenden (Spalten seatTier/tier/mode spiegeln die
 *  Zeitachse fuer alle Alt-Leser von TenantBilling.tier). */
export async function applyScheduledSeatChanges(pool: pg.Pool, now: Date = new Date()): Promise<number> {
  const r = await pool.query<{ tenantId: string }>(`SELECT DISTINCT "tenantId" FROM "SeatTierChange" WHERE "validFrom" <= $1`, [now]);
  let applied = 0;
  for (const { tenantId } of r.rows) {
    const acc = await readBillingAccount(pool, tenantId);
    if (!acc) continue;
    const tier = tierAt(await loadTimeline(pool, tenantId), now);
    if (tier === "none") {
      if (acc.mode === "seats") {
        await pool.query(
          `UPDATE "TenantBilling" SET "mode" = 'none', tier = 'free', "quotaLimit" = 25, "seatTier" = NULL, "seatBillingSince" = NULL,
                  "seatBillingEndsAt" = NULL, "updatedAt" = NOW() WHERE "tenantId" = $1`,
          [tenantId],
        );
        await recordBillingEvent(pool, { billingAccountId: tenantId, kind: "seat_billing_deactivated", source: "cron", payload: { at: now.toISOString() } });
        invalidateBillingResolution(tenantId);
        applied++;
      }
      continue;
    }
    if (acc.mode === "seats" && acc.seatTier !== tier) {
      await pool.query(
        `UPDATE "TenantBilling" SET "seatTier" = $2, tier = $2, "quotaLimit" = $3, "updatedAt" = NOW() WHERE "tenantId" = $1`,
        [tenantId, tier, TIER_LIMITS[tier]],
      );
      await recordBillingEvent(pool, { billingAccountId: tenantId, kind: "seat_tier_applied", source: "cron", payload: { from: acc.seatTier, to: tier, at: now.toISOString() } });
      invalidateBillingResolution(tenantId);
      applied++;
    }
  }
  return applied;
}

// ---- Rechnungsdatensaetze lesen ------------------------------------------------------------

export async function listSeatInvoices(q: Q, tenantId: string): Promise<SeatInvoiceSummary[]> {
  const r = await q.query<{ id: string; periodKey: string; status: string; currency: string; seatCount: number; subtotalCents: number; totalCents: number; computedAt: Date; computeHash: string }>(
    `SELECT "id", "periodKey", "status", "currency", "seatCount", "subtotalCents", "totalCents", "computedAt", "computeHash"
       FROM "SeatInvoice" WHERE "tenantId" = $1 ORDER BY "periodKey" DESC`,
    [tenantId],
  );
  const out: SeatInvoiceSummary[] = [];
  for (const row of r.rows) {
    const lines = await q.query<{ tier: string; seats: number; unitPriceCents: number; amountCents: number }>(
      `SELECT "tier", "seats", "unitPriceCents", "amountCents" FROM "SeatInvoiceLine" WHERE "invoiceId" = $1 ORDER BY "tier"`,
      [row.id],
    );
    out.push({
      ...row,
      computedAt: new Date(row.computedAt).toISOString(),
      lines: lines.rows.map((l) => ({ tier: (isSeatTier(l.tier) ? l.tier : "starter") as SeatTier, seats: l.seats, unitPriceCents: l.unitPriceCents, amountCents: l.amountCents })),
    });
  }
  return out;
}

export async function getSeatInvoice(q: Q, tenantId: string, periodKey: string): Promise<SeatInvoiceDetail | null> {
  const list = await listSeatInvoices(q, tenantId);
  const inv = list.find((x) => x.periodKey === periodKey);
  if (!inv) return null;
  const seats = await q.query<{ actorId: string; email: string | null; name: string | null; tier: string; firstCountedDay: string; lastCountedDay: string; countedDays: number }>(
    `SELECT "actorId", "email", "name", "tier", "firstCountedDay", "lastCountedDay", "countedDays" FROM "SeatInvoiceSeat" WHERE "invoiceId" = $1 ORDER BY "name", "email", "actorId"`,
    [inv.id],
  );
  const note = await q.query<{ note: string | null }>(`SELECT "note" FROM "SeatInvoice" WHERE "id" = $1`, [inv.id]);
  return {
    ...inv,
    note: note.rows[0]?.note ?? null,
    seats: seats.rows.map((s) => ({ ...s, tier: (isSeatTier(s.tier) ? s.tier : "starter") as SeatTier })),
  };
}

/** CSV (Semikolon, deutsch) fuer Buchhaltung/Export. */
export function seatInvoiceCsv(inv: SeatInvoiceDetail, tenantName: string | null): string {
  const esc = (v: unknown) => `"${String(v ?? "").replace(/"/g, '""')}"`;
  const eur = (c: number) => (c / 100).toFixed(2).replace(".", ",");
  const lines: string[] = [];
  lines.push(["Organisation", "Periode", "Status", "Seats", "Netto EUR", "Hash"].map(esc).join(";"));
  lines.push([tenantName ?? inv.id, inv.periodKey, inv.status, inv.seatCount, eur(inv.subtotalCents), inv.computeHash].map(esc).join(";"));
  lines.push("");
  lines.push(["Position", "Tier", "Seats", "Einzelpreis EUR", "Betrag EUR"].map(esc).join(";"));
  inv.lines.forEach((l, i) => lines.push([i + 1, l.tier, l.seats, eur(l.unitPriceCents), eur(l.amountCents)].map(esc).join(";")));
  lines.push("");
  lines.push(["Nutzer-ID", "Name", "E-Mail", "Tier", "Erster Stichtag", "Letzter Stichtag", "Stichtage"].map(esc).join(";"));
  for (const s of inv.seats) lines.push([s.actorId, s.name, s.email, s.tier, s.firstCountedDay, s.lastCountedDay, s.countedDays].map(esc).join(";"));
  return lines.join("\r\n");
}

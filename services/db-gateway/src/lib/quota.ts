// O6 — Limits und Verbrauch fuer Stellvertreter-Aufrufe (LlmUsage).
//
// Nur Aufrufe ueber den Organisationsschluessel sind messbar; eigene
// Schluessel bleiben unlimitiert (Entscheidung 2026-09-04). Betraege in
// US-Cent, weil die Preistabelle in USD gefuehrt wird (Schaetzwerte).

import type pg from "pg";
import type { AuthContext } from "../middleware/auth";
import { TenantError } from "./tenants";

export type QuotaMode = "off" | "org_total" | "per_user_daily";

export interface TenantQuotaShape {
  mode: QuotaMode;
  orgMonthlyCents: number | null;
  userDailyCents: number | null;
  hardStop: boolean;
}

export const DEFAULT_QUOTA: TenantQuotaShape = { mode: "off", orgMonthlyCents: null, userDailyCents: null, hardStop: true };

const TTL_MS = 60_000;
const cache = new Map<string, { q: TenantQuotaShape; bis: number }>();

export async function getQuota(pool: pg.Pool, tenantId: string): Promise<TenantQuotaShape> {
  const hit = cache.get(tenantId);
  if (hit && hit.bis > Date.now()) return hit.q;
  const r = await pool.query<{ mode: string; orgMonthlyCents: number | null; userDailyCents: number | null; hardStop: boolean }>(
    `SELECT "mode", "orgMonthlyCents", "userDailyCents", "hardStop" FROM "TenantQuota" WHERE "tenantId" = $1`,
    [tenantId],
  );
  const row = r.rows[0];
  const q: TenantQuotaShape = row
    ? {
        mode: row.mode === "org_total" || row.mode === "per_user_daily" ? row.mode : "off",
        orgMonthlyCents: row.orgMonthlyCents,
        userDailyCents: row.userDailyCents,
        hardStop: row.hardStop,
      }
    : DEFAULT_QUOTA;
  cache.set(tenantId, { q, bis: Date.now() + TTL_MS });
  return q;
}

async function istAdmin(pool: pg.Pool, tenantId: string, actorId: string): Promise<boolean> {
  const r = await pool.query<{ role: string }>(`SELECT "role" FROM "TenantMember" WHERE "tenantId" = $1 AND "actorId" = $2`, [tenantId, actorId]);
  return r.rows[0]?.role === "owner" || r.rows[0]?.role === "admin";
}

export async function setQuota(pool: pg.Pool, auth: AuthContext, patch: Partial<TenantQuotaShape>): Promise<TenantQuotaShape> {
  if (!(await istAdmin(pool, auth.tenantId, auth.actorId))) throw new TenantError(403, "Nur Admins duerfen Limits setzen.");
  const alt = await getQuota(pool, auth.tenantId);
  const neu: TenantQuotaShape = {
    mode: patch.mode ?? alt.mode,
    orgMonthlyCents: patch.orgMonthlyCents === undefined ? alt.orgMonthlyCents : patch.orgMonthlyCents,
    userDailyCents: patch.userDailyCents === undefined ? alt.userDailyCents : patch.userDailyCents,
    hardStop: patch.hardStop ?? alt.hardStop,
  };
  if (neu.mode === "org_total" && !(neu.orgMonthlyCents && neu.orgMonthlyCents > 0)) {
    throw new TenantError(400, "Monatsbudget der Organisation fehlt oder ist 0.");
  }
  if (neu.mode === "per_user_daily" && !(neu.userDailyCents && neu.userDailyCents > 0)) {
    throw new TenantError(400, "Tagesbudget je Mitglied fehlt oder ist 0.");
  }
  await pool.query(
    `INSERT INTO "TenantQuota" ("tenantId", "mode", "orgMonthlyCents", "userDailyCents", "hardStop", "updatedAt", "updatedBy")
     VALUES ($1, $2, $3, $4, $5, CURRENT_TIMESTAMP, $6)
     ON CONFLICT ("tenantId") DO UPDATE SET "mode" = EXCLUDED."mode", "orgMonthlyCents" = EXCLUDED."orgMonthlyCents",
       "userDailyCents" = EXCLUDED."userDailyCents", "hardStop" = EXCLUDED."hardStop", "updatedAt" = CURRENT_TIMESTAMP, "updatedBy" = EXCLUDED."updatedBy"`,
    [auth.tenantId, neu.mode, neu.orgMonthlyCents, neu.userDailyCents, neu.hardStop, auth.actorId],
  );
  cache.delete(auth.tenantId);
  return neu;
}

export interface QuotaCheck {
  allowed: boolean;
  scope: QuotaMode;
  limitCents: number | null;
  usedCents: number;
  resetAt: string | null;
  hardStop: boolean;
}

function monatsanfang(d = new Date()): Date {
  return new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), 1));
}
function naechsterMonat(d = new Date()): Date {
  return new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth() + 1, 1));
}
function tagesanfang(d = new Date()): Date {
  return new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate()));
}
function naechsterTag(d = new Date()): Date {
  return new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate() + 1));
}

/** Vorabpruefung je Aufruf. */
export async function checkQuota(pool: pg.Pool, tenantId: string, actorId: string): Promise<QuotaCheck> {
  const q = await getQuota(pool, tenantId);
  if (q.mode === "off") return { allowed: true, scope: "off", limitCents: null, usedCents: 0, resetAt: null, hardStop: q.hardStop };
  if (q.mode === "org_total") {
    const r = await pool.query<{ sum: string | null }>(
      `SELECT SUM("costMicroUsd")::text AS sum FROM "LlmUsage" WHERE "tenantId" = $1 AND "createdAt" >= $2`,
      [tenantId, monatsanfang()],
    );
    const usedCents = Math.round(Number(r.rows[0]?.sum ?? "0") / 10_000);
    const limit = q.orgMonthlyCents ?? 0;
    return { allowed: usedCents < limit, scope: "org_total", limitCents: limit, usedCents, resetAt: naechsterMonat().toISOString(), hardStop: q.hardStop };
  }
  const r = await pool.query<{ sum: string | null }>(
    `SELECT SUM("costMicroUsd")::text AS sum FROM "LlmUsage" WHERE "tenantId" = $1 AND "actorId" = $2 AND "createdAt" >= $3`,
    [tenantId, actorId, tagesanfang()],
  );
  const usedCents = Math.round(Number(r.rows[0]?.sum ?? "0") / 10_000);
  const limit = q.userDailyCents ?? 0;
  return { allowed: usedCents < limit, scope: "per_user_daily", limitCents: limit, usedCents, resetAt: naechsterTag().toISOString(), hardStop: q.hardStop };
}

export interface UsageRow {
  actorId: string;
  day: string;
  calls: number;
  inputTokens: number;
  outputTokens: number;
  costCents: number;
}

/** Verbrauch je Mitglied und Tag (Admins: alle; Mitglieder: nur sich selbst). */
export async function usageSummary(pool: pg.Pool, auth: AuthContext, days: number): Promise<{ rows: UsageRow[]; monthCents: number; todayCents: number; adminView: boolean }> {
  const admin = await istAdmin(pool, auth.tenantId, auth.actorId);
  const seit = new Date(Date.now() - Math.max(1, Math.min(days, 90)) * 86_400_000);
  const params: unknown[] = [auth.tenantId, seit];
  let filter = "";
  if (!admin) {
    params.push(auth.actorId);
    filter = ` AND "actorId" = $3`;
  }
  const r = await pool.query<{ actorId: string; day: Date; calls: string; inputTokens: string; outputTokens: string; cost: string | null }>(
    `SELECT "actorId", date_trunc('day', "createdAt") AS day, COUNT(*)::text AS calls,
            SUM("inputTokens")::text AS "inputTokens", SUM("outputTokens")::text AS "outputTokens", SUM("costMicroUsd")::text AS cost
     FROM "LlmUsage" WHERE "tenantId" = $1 AND "createdAt" >= $2${filter}
     GROUP BY "actorId", day ORDER BY day DESC, "actorId"`,
    params,
  );
  const rows: UsageRow[] = r.rows.map((x) => ({
    actorId: x.actorId,
    day: new Date(x.day).toISOString().slice(0, 10),
    calls: Number(x.calls),
    inputTokens: Number(x.inputTokens),
    outputTokens: Number(x.outputTokens),
    costCents: Math.round(Number(x.cost ?? "0") / 10_000),
  }));
  const m = await pool.query<{ sum: string | null }>(
    `SELECT SUM("costMicroUsd")::text AS sum FROM "LlmUsage" WHERE "tenantId" = $1 AND "createdAt" >= $2${filter.replace("$3", `$${params.length}`)}`,
    admin ? [auth.tenantId, monatsanfang()] : [auth.tenantId, monatsanfang(), auth.actorId],
  );
  const t = await pool.query<{ sum: string | null }>(
    `SELECT SUM("costMicroUsd")::text AS sum FROM "LlmUsage" WHERE "tenantId" = $1 AND "actorId" = $2 AND "createdAt" >= $3`,
    [auth.tenantId, auth.actorId, tagesanfang()],
  );
  return {
    rows,
    monthCents: Math.round(Number(m.rows[0]?.sum ?? "0") / 10_000),
    todayCents: Math.round(Number(t.rows[0]?.sum ?? "0") / 10_000),
    adminView: admin,
  };
}

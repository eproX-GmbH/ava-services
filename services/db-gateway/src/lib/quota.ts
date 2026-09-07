// O6 — Limits und Verbrauch fuer Stellvertreter-Aufrufe (LlmUsage).
//
// Nur Aufrufe ueber den Organisationsschluessel sind messbar; eigene
// Schluessel bleiben unlimitiert (Entscheidung 2026-09-04). Betraege in
// US-Cent, weil die Preistabelle in USD gefuehrt wird (Schaetzwerte).
//
// O6b (2026-09-07) — Kanaltrennung. Jeder Aufruf traegt einen Kanal
// (`chat` = Hauptmodell im Chat, `background` = Hintergrund-Verarbeitung
// durch Producer und Hauptprozess-Jobs). Mit `split = true` hat jeder Kanal
// sein eigenes Budget: ein aufgebrauchtes Hintergrund-Budget laesst den
// Chat weiterlaufen. Ohne split gilt wie bisher EIN gemeinsames Budget.

import type pg from "pg";
import type { AuthContext } from "../middleware/auth";
import { TenantError } from "./tenants";

export type QuotaMode = "off" | "org_total" | "per_user_daily";
export type LlmChannel = "chat" | "background";

export interface TenantQuotaShape {
  mode: QuotaMode;
  /** Budget fuer alles (split=false) bzw. fuer die Hintergrund-Verarbeitung (split=true). */
  orgMonthlyCents: number | null;
  userDailyCents: number | null;
  hardStop: boolean;
  /** Chat und Hintergrund getrennt begrenzen. */
  split: boolean;
  /** Chat-Budget bei split=true; null = Chat unbegrenzt. */
  chatOrgMonthlyCents: number | null;
  chatUserDailyCents: number | null;
}

export const DEFAULT_QUOTA: TenantQuotaShape = {
  mode: "off",
  orgMonthlyCents: null,
  userDailyCents: null,
  hardStop: true,
  split: false,
  chatOrgMonthlyCents: null,
  chatUserDailyCents: null,
};

/** Kanal aus dem Request-Header; alles Unbekannte ist Hintergrund (Producer
 *  und aeltere Desktop-Versionen senden keinen Header). */
export function parseChannel(raw: string | undefined | null): LlmChannel {
  return raw?.trim().toLowerCase() === "chat" ? "chat" : "background";
}

const TTL_MS = 60_000;
const cache = new Map<string, { q: TenantQuotaShape; bis: number }>();

interface QuotaRow {
  mode: string;
  orgMonthlyCents: number | null;
  userDailyCents: number | null;
  hardStop: boolean;
  split: boolean;
  chatOrgMonthlyCents: number | null;
  chatUserDailyCents: number | null;
}

export async function getQuota(pool: pg.Pool, tenantId: string): Promise<TenantQuotaShape> {
  const hit = cache.get(tenantId);
  if (hit && hit.bis > Date.now()) return hit.q;
  const r = await pool.query<QuotaRow>(
    `SELECT "mode", "orgMonthlyCents", "userDailyCents", "hardStop", "split", "chatOrgMonthlyCents", "chatUserDailyCents"
     FROM "TenantQuota" WHERE "tenantId" = $1`,
    [tenantId],
  );
  const row = r.rows[0];
  const q: TenantQuotaShape = row
    ? {
        mode: row.mode === "org_total" || row.mode === "per_user_daily" ? row.mode : "off",
        orgMonthlyCents: row.orgMonthlyCents,
        userDailyCents: row.userDailyCents,
        hardStop: row.hardStop,
        split: row.split === true,
        chatOrgMonthlyCents: row.chatOrgMonthlyCents,
        chatUserDailyCents: row.chatUserDailyCents,
      }
    : DEFAULT_QUOTA;
  cache.set(tenantId, { q, bis: Date.now() + TTL_MS });
  return q;
}

async function istAdmin(pool: pg.Pool, tenantId: string, actorId: string): Promise<boolean> {
  const r = await pool.query<{ role: string }>(`SELECT "role" FROM "TenantMember" WHERE "tenantId" = $1 AND "actorId" = $2`, [tenantId, actorId]);
  return r.rows[0]?.role === "owner" || r.rows[0]?.role === "admin";
}

function positiv(n: number | null | undefined): boolean {
  return typeof n === "number" && n > 0;
}

export async function setQuota(pool: pg.Pool, auth: AuthContext, patch: Partial<TenantQuotaShape>): Promise<TenantQuotaShape> {
  if (!(await istAdmin(pool, auth.tenantId, auth.actorId))) throw new TenantError(403, "Nur Admins duerfen Limits setzen.");
  const alt = await getQuota(pool, auth.tenantId);
  const neu: TenantQuotaShape = {
    mode: patch.mode ?? alt.mode,
    orgMonthlyCents: patch.orgMonthlyCents === undefined ? alt.orgMonthlyCents : patch.orgMonthlyCents,
    userDailyCents: patch.userDailyCents === undefined ? alt.userDailyCents : patch.userDailyCents,
    hardStop: patch.hardStop ?? alt.hardStop,
    split: patch.split ?? alt.split,
    chatOrgMonthlyCents: patch.chatOrgMonthlyCents === undefined ? alt.chatOrgMonthlyCents : patch.chatOrgMonthlyCents,
    chatUserDailyCents: patch.chatUserDailyCents === undefined ? alt.chatUserDailyCents : patch.chatUserDailyCents,
  };
  if (neu.mode === "org_total" && !positiv(neu.orgMonthlyCents)) {
    throw new TenantError(400, neu.split ? "Monatsbudget fuer die Hintergrund-Verarbeitung fehlt oder ist 0." : "Monatsbudget der Organisation fehlt oder ist 0.");
  }
  if (neu.mode === "per_user_daily" && !positiv(neu.userDailyCents)) {
    throw new TenantError(400, neu.split ? "Tagesbudget je Mitglied fuer die Hintergrund-Verarbeitung fehlt oder ist 0." : "Tagesbudget je Mitglied fehlt oder ist 0.");
  }
  if (neu.split && neu.mode === "org_total" && neu.chatOrgMonthlyCents != null && !positiv(neu.chatOrgMonthlyCents)) {
    throw new TenantError(400, "Monatsbudget fuer den Chat ist 0 — leer lassen fuer unbegrenzt.");
  }
  if (neu.split && neu.mode === "per_user_daily" && neu.chatUserDailyCents != null && !positiv(neu.chatUserDailyCents)) {
    throw new TenantError(400, "Tagesbudget je Mitglied fuer den Chat ist 0 — leer lassen fuer unbegrenzt.");
  }
  await pool.query(
    `INSERT INTO "TenantQuota" ("tenantId", "mode", "orgMonthlyCents", "userDailyCents", "hardStop", "split", "chatOrgMonthlyCents", "chatUserDailyCents", "updatedAt", "updatedBy")
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, CURRENT_TIMESTAMP, $9)
     ON CONFLICT ("tenantId") DO UPDATE SET "mode" = EXCLUDED."mode", "orgMonthlyCents" = EXCLUDED."orgMonthlyCents",
       "userDailyCents" = EXCLUDED."userDailyCents", "hardStop" = EXCLUDED."hardStop", "split" = EXCLUDED."split",
       "chatOrgMonthlyCents" = EXCLUDED."chatOrgMonthlyCents", "chatUserDailyCents" = EXCLUDED."chatUserDailyCents",
       "updatedAt" = CURRENT_TIMESTAMP, "updatedBy" = EXCLUDED."updatedBy"`,
    [auth.tenantId, neu.mode, neu.orgMonthlyCents, neu.userDailyCents, neu.hardStop, neu.split, neu.chatOrgMonthlyCents, neu.chatUserDailyCents, auth.actorId],
  );
  cache.delete(auth.tenantId);
  return neu;
}

export interface QuotaCheck {
  allowed: boolean;
  scope: QuotaMode;
  /** Kanal, gegen den geprueft wurde; null = gemeinsames Budget (kein split). */
  channel: LlmChannel | null;
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

async function summeCents(pool: pg.Pool, where: string, params: unknown[]): Promise<number> {
  const r = await pool.query<{ sum: string | null }>(`SELECT SUM("costMicroUsd")::text AS sum FROM "LlmUsage" WHERE ${where}`, params);
  return Math.round(Number(r.rows[0]?.sum ?? "0") / 10_000);
}

/** Vorabpruefung je Aufruf. Mit split zaehlt nur der eigene Kanal. */
export async function checkQuota(pool: pg.Pool, tenantId: string, actorId: string, channel: LlmChannel = "background"): Promise<QuotaCheck> {
  const q = await getQuota(pool, tenantId);
  if (q.mode === "off") return { allowed: true, scope: "off", channel: null, limitCents: null, usedCents: 0, resetAt: null, hardStop: q.hardStop };
  const kanalFilter = q.split ? ` AND "channel" = $${q.mode === "org_total" ? 3 : 4}` : "";
  const kanalParam = q.split ? [channel] : [];
  const geprueft: LlmChannel | null = q.split ? channel : null;
  if (q.mode === "org_total") {
    const limit = q.split && channel === "chat" ? q.chatOrgMonthlyCents : q.orgMonthlyCents;
    if (limit == null) return { allowed: true, scope: "org_total", channel: geprueft, limitCents: null, usedCents: 0, resetAt: naechsterMonat().toISOString(), hardStop: q.hardStop };
    const usedCents = await summeCents(pool, `"tenantId" = $1 AND "createdAt" >= $2${kanalFilter}`, [tenantId, monatsanfang(), ...kanalParam]);
    return { allowed: usedCents < limit, scope: "org_total", channel: geprueft, limitCents: limit, usedCents, resetAt: naechsterMonat().toISOString(), hardStop: q.hardStop };
  }
  const limit = q.split && channel === "chat" ? q.chatUserDailyCents : q.userDailyCents;
  if (limit == null) return { allowed: true, scope: "per_user_daily", channel: geprueft, limitCents: null, usedCents: 0, resetAt: naechsterTag().toISOString(), hardStop: q.hardStop };
  const usedCents = await summeCents(pool, `"tenantId" = $1 AND "actorId" = $2 AND "createdAt" >= $3${kanalFilter}`, [tenantId, actorId, tagesanfang(), ...kanalParam]);
  return { allowed: usedCents < limit, scope: "per_user_daily", channel: geprueft, limitCents: limit, usedCents, resetAt: naechsterTag().toISOString(), hardStop: q.hardStop };
}

export interface UsageRow {
  actorId: string;
  day: string;
  calls: number;
  inputTokens: number;
  outputTokens: number;
  costCents: number;
  /** Anteil des Chats an costCents (Rest = Hintergrund). */
  chatCents: number;
}

export interface UsageSummary {
  rows: UsageRow[];
  monthCents: number;
  todayCents: number;
  /** O6b — Aufteilung nach Kanal (gleiche Sicht wie monthCents/todayCents). */
  monthChatCents: number;
  monthBackgroundCents: number;
  todayChatCents: number;
  todayBackgroundCents: number;
  adminView: boolean;
}

/** Verbrauch je Mitglied und Tag (Admins: alle; Mitglieder: nur sich selbst). */
export async function usageSummary(pool: pg.Pool, auth: AuthContext, days: number): Promise<UsageSummary> {
  const admin = await istAdmin(pool, auth.tenantId, auth.actorId);
  const seit = new Date(Date.now() - Math.max(1, Math.min(days, 90)) * 86_400_000);
  const params: unknown[] = [auth.tenantId, seit];
  let filter = "";
  if (!admin) {
    params.push(auth.actorId);
    filter = ` AND "actorId" = $3`;
  }
  const r = await pool.query<{ actorId: string; day: Date; calls: string; inputTokens: string; outputTokens: string; cost: string | null; chat: string | null }>(
    `SELECT "actorId", date_trunc('day', "createdAt") AS day, COUNT(*)::text AS calls,
            SUM("inputTokens")::text AS "inputTokens", SUM("outputTokens")::text AS "outputTokens", SUM("costMicroUsd")::text AS cost,
            SUM(CASE WHEN "channel" = 'chat' THEN "costMicroUsd" ELSE 0 END)::text AS chat
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
    chatCents: Math.round(Number(x.chat ?? "0") / 10_000),
  }));

  const kanalSumme = async (where: string, p: unknown[]): Promise<{ gesamt: number; chat: number }> => {
    const s = await pool.query<{ sum: string | null; chat: string | null }>(
      `SELECT SUM("costMicroUsd")::text AS sum, SUM(CASE WHEN "channel" = 'chat' THEN "costMicroUsd" ELSE 0 END)::text AS chat
       FROM "LlmUsage" WHERE ${where}`,
      p,
    );
    return { gesamt: Math.round(Number(s.rows[0]?.sum ?? "0") / 10_000), chat: Math.round(Number(s.rows[0]?.chat ?? "0") / 10_000) };
  };
  const monat = admin
    ? await kanalSumme(`"tenantId" = $1 AND "createdAt" >= $2`, [auth.tenantId, monatsanfang()])
    : await kanalSumme(`"tenantId" = $1 AND "createdAt" >= $2 AND "actorId" = $3`, [auth.tenantId, monatsanfang(), auth.actorId]);
  const heute = await kanalSumme(`"tenantId" = $1 AND "actorId" = $2 AND "createdAt" >= $3`, [auth.tenantId, auth.actorId, tagesanfang()]);
  return {
    rows,
    monthCents: monat.gesamt,
    todayCents: heute.gesamt,
    monthChatCents: monat.chat,
    monthBackgroundCents: monat.gesamt - monat.chat,
    todayChatCents: heute.chat,
    todayBackgroundCents: heute.gesamt - heute.chat,
    adminView: admin,
  };
}

// B1 (docs/PLAN_ABRECHNUNG_SEATS.md §8 H5) — Audit je Abrechnungskonto.
//
// Jede Zustandsaenderung (Tier, Abo, Seats, Zahlung, Abgleich) schreibt
// eine Zeile. Best-effort: ein Fehler hier darf den Hauptpfad nie
// brechen, wird aber geloggt (Konvention docs/ZUVERLAESSIGKEIT.md §2).

import type pg from "pg";
import { logger } from "./logger";

export type BillingEventSource = "webhook" | "admin" | "cron" | "operator" | "system";

export interface BillingEventInput {
  billingAccountId: string;
  kind: string;
  source: BillingEventSource;
  actorId?: string | null;
  stripeEventId?: string | null;
  payload?: Record<string, unknown> | null;
}

type Q = { query: pg.Pool["query"] };

export async function recordBillingEvent(q: Q, ev: BillingEventInput): Promise<void> {
  try {
    await q.query(
      `INSERT INTO "BillingEvent" ("billingAccountId", "kind", "source", "actorId", "stripeEventId", "payload")
       VALUES ($1, $2, $3, $4, $5, $6::jsonb)`,
      [ev.billingAccountId, ev.kind, ev.source, ev.actorId ?? null, ev.stripeEventId ?? null, ev.payload ? JSON.stringify(ev.payload) : null],
    );
  } catch (err) {
    logger.warn({ err: err instanceof Error ? err.message : String(err), kind: ev.kind, billingAccountId: ev.billingAccountId }, "billing event write failed (best-effort)");
  }
}

export interface BillingEventRow {
  id: string;
  ts: string;
  kind: string;
  source: string;
  actorId: string | null;
  stripeEventId: string | null;
  payload: unknown;
}

export async function listBillingEvents(q: Q, billingAccountId: string, limit = 50): Promise<BillingEventRow[]> {
  const r = await q.query<{ id: string; ts: Date; kind: string; source: string; actorId: string | null; stripeEventId: string | null; payload: unknown }>(
    `SELECT "id"::text, "ts", "kind", "source", "actorId", "stripeEventId", "payload"
       FROM "BillingEvent" WHERE "billingAccountId" = $1 ORDER BY "ts" DESC, "id" DESC LIMIT $2`,
    [billingAccountId, Math.min(Math.max(limit, 1), 500)],
  );
  return r.rows.map((x) => ({ ...x, ts: new Date(x.ts).toISOString() }));
}

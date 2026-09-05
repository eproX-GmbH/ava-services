// O8 — Freigaben innerhalb der Organisation (Transaktionen, Radar-Firmen).
//
// Eine Freigabe gilt fuer die ganze Organisation (Entscheidung 2026-09-05).
// Zuruecknehmen setzt revokedAt; bereits uebernommene Kopien bleiben.
// Persoenliche Tenants koennen nichts teilen (kein Empfaenger).

import type pg from "pg";
import type { AuthContext } from "../middleware/auth";
import { TenantError } from "./tenants";

export type ShareKind = "transaction" | "radar_company";

export interface OrgShareRow {
  id: string;
  kind: ShareKind;
  refId: string;
  sharedBy: string;
  sharedByName: string | null;
  sharedAt: string;
  note: string | null;
  seenAt: string | null;
  dismissedAt: string | null;
}

async function istOrganisation(pool: pg.Pool, tenantId: string): Promise<boolean> {
  const r = await pool.query<{ kind: string }>(`SELECT "kind" FROM "Tenant" WHERE "id" = $1`, [tenantId]);
  return r.rows[0]?.kind === "organisation";
}

async function istAdmin(pool: pg.Pool, tenantId: string, actorId: string): Promise<boolean> {
  const r = await pool.query<{ role: string }>(`SELECT "role" FROM "TenantMember" WHERE "tenantId" = $1 AND "actorId" = $2`, [tenantId, actorId]);
  return r.rows[0]?.role === "owner" || r.rows[0]?.role === "admin";
}

export async function createShare(pool: pg.Pool, auth: AuthContext, kind: ShareKind, refId: string, note: string | null): Promise<OrgShareRow> {
  if (!(await istOrganisation(pool, auth.tenantId))) throw new TenantError(409, "Teilen geht nur innerhalb einer Organisation.");
  const id = `sh_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 10)}`;
  await pool.query(
    `INSERT INTO "OrgShare" ("id", "tenantId", "kind", "refId", "sharedBy", "note")
     VALUES ($1, $2, $3, $4, $5, $6)
     ON CONFLICT ("tenantId", "kind", "refId") DO UPDATE SET "revokedAt" = NULL, "sharedBy" = EXCLUDED."sharedBy",
       "sharedAt" = CURRENT_TIMESTAMP, "note" = EXCLUDED."note"`,
    [id, auth.tenantId, kind, refId, auth.actorId, note],
  );
  const rows = await listShares(pool, auth, { kind, includeDismissed: true });
  const row = rows.find((r) => r.refId === refId);
  if (!row) throw new TenantError(404, "Freigabe nicht gefunden.");
  return row;
}

export async function revokeShare(pool: pg.Pool, auth: AuthContext, shareId: string): Promise<void> {
  const r = await pool.query<{ sharedBy: string }>(`SELECT "sharedBy" FROM "OrgShare" WHERE "id" = $1 AND "tenantId" = $2`, [shareId, auth.tenantId]);
  const row = r.rows[0];
  if (!row) throw new TenantError(404, "Freigabe nicht gefunden.");
  if (row.sharedBy !== auth.actorId && !(await istAdmin(pool, auth.tenantId, auth.actorId))) {
    throw new TenantError(403, "Nur wer geteilt hat oder ein Admin darf die Freigabe zuruecknehmen.");
  }
  await pool.query(`UPDATE "OrgShare" SET "revokedAt" = CURRENT_TIMESTAMP WHERE "id" = $1`, [shareId]);
}

export async function markShare(pool: pg.Pool, auth: AuthContext, shareId: string, was: "seen" | "dismiss"): Promise<void> {
  const r = await pool.query(`SELECT 1 FROM "OrgShare" WHERE "id" = $1 AND "tenantId" = $2`, [shareId, auth.tenantId]);
  if (r.rows.length === 0) throw new TenantError(404, "Freigabe nicht gefunden.");
  await pool.query(
    `INSERT INTO "OrgShareSeen" ("shareId", "actorId", "dismissedAt") VALUES ($1, $2, $3)
     ON CONFLICT ("shareId", "actorId") DO UPDATE SET "seenAt" = CURRENT_TIMESTAMP,
       "dismissedAt" = COALESCE(EXCLUDED."dismissedAt", "OrgShareSeen"."dismissedAt")`,
    [shareId, auth.actorId, was === "dismiss" ? new Date() : null],
  );
}

export async function listShares(
  pool: pg.Pool,
  auth: AuthContext,
  opts: { kind?: ShareKind; unseenOnly?: boolean; includeDismissed?: boolean; includeRevoked?: boolean } = {},
): Promise<OrgShareRow[]> {
  const params: unknown[] = [auth.tenantId, auth.actorId];
  const cond: string[] = [`s."tenantId" = $1`];
  if (!opts.includeRevoked) cond.push(`s."revokedAt" IS NULL`);
  if (opts.kind) {
    params.push(opts.kind);
    cond.push(`s."kind" = $${params.length}`);
  }
  if (opts.unseenOnly) cond.push(`x."seenAt" IS NULL`);
  if (!opts.includeDismissed) cond.push(`x."dismissedAt" IS NULL`);
  const r = await pool.query<{
    id: string; kind: string; refId: string; sharedBy: string; sharedAt: Date; note: string | null; seenAt: Date | null; dismissedAt: Date | null; sharedByName: string | null;
  }>(
    `SELECT s."id", s."kind", s."refId", s."sharedBy", s."sharedAt", s."note", x."seenAt", x."dismissedAt",
            (SELECT COALESCE(j."name", j."email") FROM "TenantJoinRequest" j WHERE j."actorId" = s."sharedBy" ORDER BY j."requestedAt" DESC LIMIT 1) AS "sharedByName"
       FROM "OrgShare" s
       LEFT JOIN "OrgShareSeen" x ON x."shareId" = s."id" AND x."actorId" = $2
      WHERE ${cond.join(" AND ")}
      ORDER BY s."sharedAt" DESC
      LIMIT 500`,
    params,
  );
  return r.rows.map((x) => ({
    id: x.id,
    kind: x.kind as ShareKind,
    refId: x.refId,
    sharedBy: x.sharedBy,
    sharedByName: x.sharedByName,
    sharedAt: new Date(x.sharedAt).toISOString(),
    note: x.note,
    seenAt: x.seenAt ? new Date(x.seenAt).toISOString() : null,
    dismissedAt: x.dismissedAt ? new Date(x.dismissedAt).toISOString() : null,
  }));
}

/** Aktive Transaktions-Freigabe im Tenant fuer eine transactionId (Lesezugriff fuer Mitglieder). */
export async function activeShareFor(pool: pg.Pool, tenantId: string, kind: ShareKind, refId: string): Promise<{ id: string; sharedBy: string; sharedAt: string; note: string | null } | null> {
  const r = await pool.query<{ id: string; sharedBy: string; sharedAt: Date; note: string | null }>(
    `SELECT "id", "sharedBy", "sharedAt", "note" FROM "OrgShare" WHERE "tenantId" = $1 AND "kind" = $2 AND "refId" = $3 AND "revokedAt" IS NULL`,
    [tenantId, kind, refId],
  );
  const row = r.rows[0];
  return row ? { id: row.id, sharedBy: row.sharedBy, sharedAt: new Date(row.sharedAt).toISOString(), note: row.note } : null;
}

/** O8 — Verarbeitungsfortschritt einer Quelle auf eine neue Transaktion kopieren. */
export async function copyEntityProgress(pool: pg.Pool, fromTx: string, toTx: string): Promise<number> {
  const r = await pool.query(
    `INSERT INTO "EntityProgress" ("transactionId", "companyId", "producer", "state", "errorMessage", "updatedAt", "createdAt")
     SELECT $2, "companyId", "producer", "state", "errorMessage", "updatedAt", CURRENT_TIMESTAMP
       FROM "EntityProgress" WHERE "transactionId" = $1
     ON CONFLICT ("transactionId", "companyId", "producer") DO NOTHING`,
    [fromTx, toTx],
  );
  return r.rowCount ?? 0;
}

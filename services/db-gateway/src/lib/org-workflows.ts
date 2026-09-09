// W7 (docs/PLAN_WORKFLOWS.md) — Workflows mit der Organisation teilen.
//
// Workflows liegen lokal beim Nutzer (Entscheidung 2026-09-09). Teilen
// legt eine Kopie der Definition im Tenant ab; Mitglieder uebernehmen sie
// in ihren eigenen Bestand (Kopie, keine Live-Verknuepfung). Wer teilt,
// kann zurueckziehen; Admins ebenfalls. Definitionen enthalten keine
// Schluessel (Zugaenge kommen aus den Einstellungen des Mitglieds).

import { randomUUID } from "node:crypto";
import type pg from "pg";
import type { AuthContext } from "../middleware/auth";
import { TenantError } from "./tenants";

export interface OrgWorkflowRow {
  id: string;
  sourceId: string;
  name: string;
  description: string;
  version: number;
  sharedBy: string;
  sharedByName: string | null;
  sharedAt: string;
  updatedAt: string;
  /** Nur bei Einzelabruf. */
  definition?: Record<string, unknown>;
  nodeCount: number;
}

async function ensureSchema(pool: pg.Pool): Promise<void> {
  await pool.query(`CREATE TABLE IF NOT EXISTS "TenantWorkflow" (
    "id" TEXT PRIMARY KEY,
    "tenantId" TEXT NOT NULL REFERENCES "Tenant"("id") ON DELETE CASCADE,
    "sourceId" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "description" TEXT NOT NULL DEFAULT '',
    "definition" JSONB NOT NULL,
    "version" INTEGER NOT NULL DEFAULT 1,
    "sharedBy" TEXT NOT NULL,
    "sharedAt" TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    "updatedAt" TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    "revokedAt" TIMESTAMPTZ
  )`);
  await pool.query(`CREATE UNIQUE INDEX IF NOT EXISTS "TenantWorkflow_tenant_source" ON "TenantWorkflow"("tenantId", "sourceId")`);
  await pool.query(`CREATE INDEX IF NOT EXISTS "TenantWorkflow_tenant_shared" ON "TenantWorkflow"("tenantId", "sharedAt")`);
}

const MAX_DEFINITION_BYTES = 512 * 1024;

export async function shareWorkflow(
  pool: pg.Pool,
  auth: AuthContext,
  input: { sourceId: string; name: string; description: string; version: number; definition: Record<string, unknown> },
): Promise<OrgWorkflowRow> {
  await ensureSchema(pool);
  const json = JSON.stringify(input.definition);
  if (json.length > MAX_DEFINITION_BYTES) throw new TenantError(400, "Workflow-Definition zu gross (max 512 KB).");
  const nodes = Array.isArray((input.definition as { nodes?: unknown[] }).nodes) ? ((input.definition as { nodes: unknown[] }).nodes.length ?? 0) : 0;
  const existing = await pool.query<{ id: string; sharedBy: string }>(`SELECT "id", "sharedBy" FROM "TenantWorkflow" WHERE "tenantId" = $1 AND "sourceId" = $2`, [auth.tenantId, input.sourceId]);
  if (existing.rows[0] && existing.rows[0].sharedBy !== auth.actorId) {
    throw new TenantError(403, "Dieser Workflow wurde von jemand anderem geteilt.");
  }
  const id = existing.rows[0]?.id ?? `orgwf_${randomUUID().slice(0, 12)}`;
  await pool.query(
    `INSERT INTO "TenantWorkflow" ("id", "tenantId", "sourceId", "name", "description", "definition", "version", "sharedBy", "sharedAt", "updatedAt", "revokedAt")
     VALUES ($1, $2, $3, $4, $5, $6::jsonb, $7, $8, NOW(), NOW(), NULL)
     ON CONFLICT ("tenantId", "sourceId") DO UPDATE SET "name" = EXCLUDED."name", "description" = EXCLUDED."description", "definition" = EXCLUDED."definition",
       "version" = EXCLUDED."version", "updatedAt" = NOW(), "revokedAt" = NULL`,
    [id, auth.tenantId, input.sourceId, input.name.slice(0, 120), input.description.slice(0, 2000), json, input.version, auth.actorId],
  );
  const row = await getOrgWorkflow(pool, auth, id);
  if (!row) throw new TenantError(409, "Teilen fehlgeschlagen.");
  return { ...row, nodeCount: nodes };
}

export async function listOrgWorkflows(pool: pg.Pool, auth: AuthContext): Promise<OrgWorkflowRow[]> {
  await ensureSchema(pool);
  const r = await pool.query<{
    id: string; sourceId: string; name: string; description: string; version: number; sharedBy: string; sharedByName: string | null; sharedAt: Date; updatedAt: Date; nodeCount: string;
  }>(
    `SELECT w."id", w."sourceId", w."name", w."description", w."version", w."sharedBy", w."sharedAt", w."updatedAt",
            COALESCE(m."name", m."email") AS "sharedByName",
            COALESCE(jsonb_array_length(w."definition"->'nodes'), 0)::text AS "nodeCount"
       FROM "TenantWorkflow" w
       LEFT JOIN "TenantMember" m ON m."tenantId" = w."tenantId" AND m."actorId" = w."sharedBy"
      WHERE w."tenantId" = $1 AND w."revokedAt" IS NULL
      ORDER BY w."updatedAt" DESC
      LIMIT 200`,
    [auth.tenantId],
  );
  return r.rows.map((x) => ({
    id: x.id,
    sourceId: x.sourceId,
    name: x.name,
    description: x.description,
    version: x.version,
    sharedBy: x.sharedBy,
    sharedByName: x.sharedByName,
    sharedAt: x.sharedAt.toISOString(),
    updatedAt: x.updatedAt.toISOString(),
    nodeCount: Number(x.nodeCount),
  }));
}

export async function getOrgWorkflow(pool: pg.Pool, auth: AuthContext, id: string): Promise<OrgWorkflowRow | null> {
  await ensureSchema(pool);
  const r = await pool.query<{
    id: string; sourceId: string; name: string; description: string; version: number; sharedBy: string; sharedByName: string | null; sharedAt: Date; updatedAt: Date; definition: Record<string, unknown>;
  }>(
    `SELECT w."id", w."sourceId", w."name", w."description", w."version", w."sharedBy", w."sharedAt", w."updatedAt", w."definition",
            COALESCE(m."name", m."email") AS "sharedByName"
       FROM "TenantWorkflow" w
       LEFT JOIN "TenantMember" m ON m."tenantId" = w."tenantId" AND m."actorId" = w."sharedBy"
      WHERE w."tenantId" = $1 AND w."id" = $2 AND w."revokedAt" IS NULL`,
    [auth.tenantId, id],
  );
  const x = r.rows[0];
  if (!x) return null;
  const nodes = Array.isArray((x.definition as { nodes?: unknown[] }).nodes) ? (x.definition as { nodes: unknown[] }).nodes.length : 0;
  return {
    id: x.id,
    sourceId: x.sourceId,
    name: x.name,
    description: x.description,
    version: x.version,
    sharedBy: x.sharedBy,
    sharedByName: x.sharedByName,
    sharedAt: x.sharedAt.toISOString(),
    updatedAt: x.updatedAt.toISOString(),
    definition: x.definition,
    nodeCount: nodes,
  };
}

export async function revokeOrgWorkflow(pool: pg.Pool, auth: AuthContext, id: string): Promise<void> {
  await ensureSchema(pool);
  const r = await pool.query<{ sharedBy: string }>(`SELECT "sharedBy" FROM "TenantWorkflow" WHERE "tenantId" = $1 AND "id" = $2 AND "revokedAt" IS NULL`, [auth.tenantId, id]);
  const row = r.rows[0];
  if (!row) throw new TenantError(404, "Geteilter Workflow nicht gefunden.");
  if (row.sharedBy !== auth.actorId) {
    const m = await pool.query<{ role: string }>(`SELECT "role" FROM "TenantMember" WHERE "tenantId" = $1 AND "actorId" = $2`, [auth.tenantId, auth.actorId]);
    const role = m.rows[0]?.role;
    if (role !== "owner" && role !== "admin") throw new TenantError(403, "Nur wer geteilt hat oder ein Admin kann zurueckziehen.");
  }
  await pool.query(`UPDATE "TenantWorkflow" SET "revokedAt" = NOW() WHERE "tenantId" = $1 AND "id" = $2`, [auth.tenantId, id]);
}

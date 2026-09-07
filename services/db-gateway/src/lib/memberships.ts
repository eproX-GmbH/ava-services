// B1 (docs/PLAN_ABRECHNUNG_SEATS.md) — Mitgliedschaftshistorie.
//
// TenantMember bleibt die aktuelle Sicht (genau ein Tenant je User);
// TenantMembership haelt die Intervalle [joinedAt, leftAt) je Organisation.
// Nur Organisationen werden protokolliert — persoenliche Tenants sind
// per Definition der Nutzer selbst und nie abrechnungsrelevant.

import type pg from "pg";
import { randomBytes } from "node:crypto";

type Q = { query: pg.Pool["query"] };

export async function openMembership(
  q: Q,
  m: { tenantId: string; actorId: string; role: string; email?: string | null; name?: string | null },
): Promise<void> {
  // Ein offenes Intervall je (tenant, actor) — ein zweites Oeffnen ist ein No-op.
  const open = await q.query<{ id: string }>(
    `SELECT "id" FROM "TenantMembership" WHERE "tenantId" = $1 AND "actorId" = $2 AND "leftAt" IS NULL LIMIT 1`,
    [m.tenantId, m.actorId],
  );
  if (open.rows[0]) return;
  await q.query(
    `INSERT INTO "TenantMembership" ("id", "tenantId", "actorId", "role", "email", "name")
     VALUES ($1, $2, $3, $4, $5, $6)`,
    [`mb_${randomBytes(9).toString("base64url")}`, m.tenantId, m.actorId, m.role, m.email ?? null, m.name ?? null],
  );
}

/** Alle offenen Intervalle des Akteurs schliessen (optional nur in einem Tenant). */
export async function closeMembership(
  q: Q,
  m: { actorId: string; tenantId?: string; reason: "removed" | "left" | "replaced" },
): Promise<void> {
  await q.query(
    `UPDATE "TenantMembership" SET "leftAt" = CURRENT_TIMESTAMP, "leftReason" = $2
      WHERE "actorId" = $1 AND "leftAt" IS NULL${m.tenantId ? ` AND "tenantId" = $3` : ""}`,
    m.tenantId ? [m.actorId, m.reason, m.tenantId] : [m.actorId, m.reason],
  );
}

export async function updateMembershipRole(q: Q, m: { tenantId: string; actorId: string; role: string }): Promise<void> {
  await q.query(
    `UPDATE "TenantMembership" SET "role" = $3 WHERE "tenantId" = $1 AND "actorId" = $2 AND "leftAt" IS NULL`,
    [m.tenantId, m.actorId, m.role],
  );
}

/** E-Mail/Name nachtragen (whoami-Abgleich), nie mit null ueberschreiben. */
export async function updateMembershipIdentity(q: Q, m: { actorId: string; email: string | null; name: string | null }): Promise<void> {
  if (!m.email && !m.name) return;
  await q.query(
    `UPDATE "TenantMembership" SET "email" = COALESCE($2, "email"), "name" = COALESCE($3, "name") WHERE "actorId" = $1 AND "leftAt" IS NULL`,
    [m.actorId, m.email, m.name],
  );
}

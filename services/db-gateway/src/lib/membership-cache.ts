// O2 — Tenant-Aufloesung ueber die Mitgliedschaft (Gateway-Wahrheit).
//
// Solange das Token keinen tenant_id-Claim traegt (Keycloak-Mapper aus T3
// noch nicht aktiv) oder der Claim hinterherhinkt (bis zum naechsten
// Refresh), liefert TenantMember den gueltigen Tenant. Kurzer Cache je
// User, damit nicht jede Anfrage eine DB-Abfrage kostet; Mutationen in
// lib/tenants.ts invalidieren gezielt.

import type pg from "pg";

const TTL_MS = 60_000;
const cache = new Map<string, { tenantId: string; tenantName: string | null; bis: number }>();

export async function resolveTenantByMembership(
  pool: pg.Pool,
  actorId: string,
): Promise<{ tenantId: string; tenantName: string | null } | null> {
  const hit = cache.get(actorId);
  if (hit && hit.bis > Date.now()) return hit;
  const r = await pool.query<{ tenantId: string; name: string | null }>(
    `SELECT m."tenantId", t."name" FROM "TenantMember" m JOIN "Tenant" t ON t."id" = m."tenantId" WHERE m."actorId" = $1`,
    [actorId],
  );
  const row = r.rows[0];
  if (!row) return null;
  const eintrag = { tenantId: row.tenantId, tenantName: row.name, bis: Date.now() + TTL_MS };
  cache.set(actorId, eintrag);
  return eintrag;
}

export function invalidateMembership(actorId: string): void {
  cache.delete(actorId);
}

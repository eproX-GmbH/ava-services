// T4 (docs/PLAN_TENANT_MULTI_ACCOUNT.md) — Tenant-Zugehoerigkeit.
//
// Tabellen Tenant / TenantMember (Migration 20260903_tenants). Pflege
// vorerst manuell durch den Operator; dieses Modul sorgt nur dafuer,
// dass jeder authentifizierte User einen Tenant-Eintrag und eine
// Mitgliedschaft hat (Upsert beim /whoami-Aufruf, nicht pro Request),
// und liefert die Anzeige-Daten fuer den Desktop.

import type pg from "pg";
import type { AuthContext } from "../middleware/auth";

export interface WhoamiPayload {
  tenantId: string;
  actorId: string;
  scopes: string[];
  tenantName: string | null;
  role: string;
  memberCount: number;
  email: string | null;
  /** "claim" = tenant_id aus dem Token; "sub" = Kompatibilitaets-Fallback. */
  tenantSource: "claim" | "sub";
}

/** Tenant + Mitgliedschaft sicherstellen und Anzeige-Daten lesen. */
export async function ensureTenantForAuth(
  pool: pg.Pool,
  auth: AuthContext,
): Promise<WhoamiPayload> {
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    // Name aus dem Claim uebernehmen, wenn der Tenant noch keinen hat
    // (Operator-Pflege gewinnt: vorhandener Name bleibt).
    await client.query(
      `INSERT INTO "Tenant" ("id", "name") VALUES ($1, $2)
       ON CONFLICT ("id") DO UPDATE
         SET "name" = COALESCE("Tenant"."name", EXCLUDED."name"),
             "updatedAt" = CASE WHEN "Tenant"."name" IS NULL AND EXCLUDED."name" IS NOT NULL
                                THEN CURRENT_TIMESTAMP ELSE "Tenant"."updatedAt" END`,
      [auth.tenantId, auth.tenantName ?? null],
    );
    // Genau ein Tenant je User: eine bestehende Mitgliedschaft in einem
    // ANDEREN Tenant wird NICHT stillschweigend umgehaengt (das ist
    // Operator-Sache) — dann bleibt die alte Zeile und der Claim ist
    // massgeblich fuer die Datenzuordnung; whoami zeigt beides.
    await client.query(
      `INSERT INTO "TenantMember" ("tenantId", "actorId", "role")
       VALUES ($1, $2, $3)
       ON CONFLICT ("actorId") DO NOTHING`,
      [auth.tenantId, auth.actorId, auth.actorId === auth.tenantId ? "owner" : "member"],
    );
    const t = await client.query<{ name: string | null }>(
      `SELECT "name" FROM "Tenant" WHERE "id" = $1`,
      [auth.tenantId],
    );
    const m = await client.query<{ role: string; tenantId: string }>(
      `SELECT "role", "tenantId" FROM "TenantMember" WHERE "actorId" = $1`,
      [auth.actorId],
    );
    const n = await client.query<{ n: string }>(
      `SELECT COUNT(*)::text AS n FROM "TenantMember" WHERE "tenantId" = $1`,
      [auth.tenantId],
    );
    await client.query("COMMIT");
    const membership = m.rows[0];
    return {
      tenantId: auth.tenantId,
      actorId: auth.actorId,
      scopes: auth.scopes,
      tenantName: t.rows[0]?.name ?? auth.tenantName ?? null,
      role: membership && membership.tenantId === auth.tenantId ? membership.role : "member",
      memberCount: Number(n.rows[0]?.n ?? "0"),
      email: auth.email ?? null,
      tenantSource: auth.tenantSource,
    };
  } catch (err) {
    await client.query("ROLLBACK").catch(() => undefined);
    throw err;
  } finally {
    client.release();
  }
}

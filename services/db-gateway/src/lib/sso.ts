// C2 (docs/PLAN_COPILOT_MCP.md): Anmeldung mit dem Microsoft-Konto des
// Unternehmens je Organisation. Konfiguration liegt in TenantSso (ohne
// Geheimnis), der Identity Provider in Keycloak (keycloak-admin.ts).

import type pg from "pg";
import type { AuthContext } from "../middleware/auth";
import { TenantError } from "./tenants";
import { deleteEntraIdp, entraDiscovery, entraIdpAlias, KeycloakAdminError, upsertEntraIdp } from "./keycloak-admin";

export interface SsoStand {
  eingerichtet: boolean;
  anbieter: "entra";
  entraTenantId: string | null;
  clientId: string | null;
  idpAlias: string | null;
  aktiv: boolean;
  zuletztGeprueft: string | null;
  fehler: string | null;
  /** kc_idp_hint fuer Anmeldelinks (app.ava.bi/auth/login?idp=…, admin.ava.bi/auth/login?idp=…). */
  anmeldeHinweis: string | null;
}

async function istAdmin(pool: pg.Pool, tenantId: string, actorId: string): Promise<boolean> {
  const r = await pool.query<{ role: string }>(`SELECT "role" FROM "TenantMember" WHERE "tenantId" = $1 AND "actorId" = $2`, [tenantId, actorId]);
  return r.rows[0]?.role === "owner" || r.rows[0]?.role === "admin";
}

async function istOrganisation(pool: pg.Pool, tenantId: string): Promise<boolean> {
  const r = await pool.query<{ kind: string }>(`SELECT "kind" FROM "Tenant" WHERE "id" = $1`, [tenantId]);
  return r.rows[0]?.kind === "organisation";
}

export async function ssoLesen(pool: pg.Pool, auth: AuthContext): Promise<SsoStand> {
  const r = await pool.query<{ entraTenantId: string; clientId: string; idpAlias: string; aktiv: boolean; zuletztGeprueft: Date | null; fehler: string | null }>(
    `SELECT "entraTenantId", "clientId", "idpAlias", "aktiv", "zuletztGeprueft", "fehler" FROM "TenantSso" WHERE "tenantId" = $1`,
    [auth.tenantId],
  );
  const z = r.rows[0];
  if (!z) return { eingerichtet: false, anbieter: "entra", entraTenantId: null, clientId: null, idpAlias: null, aktiv: false, zuletztGeprueft: null, fehler: null, anmeldeHinweis: null };
  return {
    eingerichtet: true,
    anbieter: "entra",
    entraTenantId: z.entraTenantId,
    clientId: z.clientId,
    idpAlias: z.idpAlias,
    aktiv: z.aktiv,
    zuletztGeprueft: z.zuletztGeprueft ? z.zuletztGeprueft.toISOString() : null,
    fehler: z.fehler,
    anmeldeHinweis: z.aktiv ? z.idpAlias : null,
  };
}

export async function ssoSetzen(
  pool: pg.Pool,
  auth: AuthContext,
  input: { entraTenantId: string; clientId: string; clientSecret?: string; aktiv?: boolean },
): Promise<SsoStand> {
  if (!(await istAdmin(pool, auth.tenantId, auth.actorId))) throw new TenantError(403, "Nur Admins dürfen die Anmeldung einrichten.");
  if (!(await istOrganisation(pool, auth.tenantId))) throw new TenantError(400, "Die Microsoft-Anmeldung gibt es nur für Organisationen.");
  const tenantName = (await pool.query<{ name: string | null }>(`SELECT "name" FROM "Tenant" WHERE "id" = $1`, [auth.tenantId])).rows[0]?.name ?? auth.tenantId;
  let alias: string;
  try {
    alias = (await upsertEntraIdp({ tenantId: auth.tenantId, tenantName, entraTenantId: input.entraTenantId, clientId: input.clientId, clientSecret: input.clientSecret })).alias;
  } catch (err) {
    if (err instanceof KeycloakAdminError) {
      const grund = err.errorKind === "entra_discovery" || err.errorKind === "secret_missing" ? err.message : `Keycloak hat die Einrichtung abgelehnt (${err.status}). Der Betreiber muss dem Dienstkonto die Rolle manage-identity-providers geben.`;
      await pool.query(
        `INSERT INTO "TenantSso" ("tenantId", "entraTenantId", "clientId", "idpAlias", "aktiv", "fehler", "erstelltVon", "zuletztGeprueft")
         VALUES ($1, $2, $3, $4, FALSE, $5, $6, NOW())
         ON CONFLICT ("tenantId") DO UPDATE SET "entraTenantId" = EXCLUDED."entraTenantId", "clientId" = EXCLUDED."clientId", "aktiv" = FALSE, "fehler" = EXCLUDED."fehler", "zuletztGeprueft" = NOW(), "updatedAt" = NOW()`,
        [auth.tenantId, input.entraTenantId, input.clientId, entraIdpAlias(auth.tenantId), grund, auth.actorId],
      );
      throw new TenantError(400, grund);
    }
    throw err;
  }
  await pool.query(
    `INSERT INTO "TenantSso" ("tenantId", "entraTenantId", "clientId", "idpAlias", "aktiv", "fehler", "erstelltVon", "zuletztGeprueft")
     VALUES ($1, $2, $3, $4, $5, NULL, $6, NOW())
     ON CONFLICT ("tenantId") DO UPDATE SET "entraTenantId" = EXCLUDED."entraTenantId", "clientId" = EXCLUDED."clientId", "idpAlias" = EXCLUDED."idpAlias", "aktiv" = EXCLUDED."aktiv", "fehler" = NULL, "zuletztGeprueft" = NOW(), "updatedAt" = NOW()`,
    [auth.tenantId, input.entraTenantId, input.clientId, alias, input.aktiv ?? true, auth.actorId],
  );
  return ssoLesen(pool, auth);
}

export async function ssoPruefen(pool: pg.Pool, auth: AuthContext): Promise<SsoStand> {
  if (!(await istAdmin(pool, auth.tenantId, auth.actorId))) throw new TenantError(403, "Nur Admins dürfen die Anmeldung prüfen.");
  const stand = await ssoLesen(pool, auth);
  if (!stand.eingerichtet || !stand.entraTenantId) throw new TenantError(404, "Keine Microsoft-Anmeldung eingerichtet.");
  let fehler: string | null = null;
  try {
    await entraDiscovery(stand.entraTenantId);
  } catch (err) {
    fehler = err instanceof Error ? err.message : String(err);
  }
  await pool.query(`UPDATE "TenantSso" SET "zuletztGeprueft" = NOW(), "fehler" = $2, "updatedAt" = NOW() WHERE "tenantId" = $1`, [auth.tenantId, fehler]);
  return ssoLesen(pool, auth);
}

export async function ssoEntfernen(pool: pg.Pool, auth: AuthContext): Promise<void> {
  if (!(await istAdmin(pool, auth.tenantId, auth.actorId))) throw new TenantError(403, "Nur Admins dürfen die Anmeldung entfernen.");
  await deleteEntraIdp(auth.tenantId);
  await pool.query(`DELETE FROM "TenantSso" WHERE "tenantId" = $1`, [auth.tenantId]);
}

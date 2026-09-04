// O3 — serverseitige Durchsetzung der Organisationsvorgaben.
//
// `requireFeature(auth, key)` wirft 403 feature_disabled, wenn die
// Organisation die Funktion abgeschaltet hat (fehlender Schluessel =
// erlaubt; persoenliche Tenants haben keine Policy). Kurzer Cache je
// Tenant; setPolicy invalidiert.

import { HTTPException } from "hono/http-exception";
import type pg from "pg";
import type { AuthContext } from "../middleware/auth";

const TTL_MS = 60_000;
const cache = new Map<string, { features: Record<string, boolean>; bis: number }>();

export async function loadFeatures(pool: pg.Pool, tenantId: string): Promise<Record<string, boolean>> {
  const hit = cache.get(tenantId);
  if (hit && hit.bis > Date.now()) return hit.features;
  const r = await pool.query<{ features: unknown }>(`SELECT "features" FROM "TenantPolicy" WHERE "tenantId" = $1`, [tenantId]);
  const feats: Record<string, boolean> = {};
  const raw = r.rows[0]?.features;
  if (raw && typeof raw === "object") {
    for (const [k, v] of Object.entries(raw as Record<string, unknown>)) feats[k] = v !== false;
  }
  cache.set(tenantId, { features: feats, bis: Date.now() + TTL_MS });
  return feats;
}

export function invalidateFeatures(tenantId: string): void {
  cache.delete(tenantId);
}

export async function requireFeature(pool: pg.Pool, auth: AuthContext, key: string): Promise<void> {
  const feats = await loadFeatures(pool, auth.tenantId);
  if (feats[key] === false) {
    throw new HTTPException(403, { message: `feature_disabled:${key}` });
  }
}

/** Fuer Persist-Ereignisse: tenantId kann Organisation ODER Nutzer-ID sein
 *  (persoenlicher Tenant, Alt-Token). Beides pruefen — gesperrt, sobald
 *  eine der beiden Vorgaben die Funktion abschaltet. */
export async function featureEnabledForEventTenant(pool: pg.Pool, tenantId: string, key: string): Promise<boolean> {
  const direkt = await loadFeatures(pool, tenantId);
  if (direkt[key] === false) return false;
  const { resolveTenantByMembership } = await import("./membership-cache");
  const m = await resolveTenantByMembership(pool, tenantId);
  if (m && m.tenantId !== tenantId) {
    const org = await loadFeatures(pool, m.tenantId);
    if (org[key] === false) return false;
  }
  return true;
}

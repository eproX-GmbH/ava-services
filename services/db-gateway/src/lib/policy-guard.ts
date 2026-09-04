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

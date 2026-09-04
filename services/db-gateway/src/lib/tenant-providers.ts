// O4 — Organisationsschluessel je Anbieter (verschluesselt, nie auslesbar).

import type pg from "pg";
import type { AuthContext } from "../middleware/auth";
import { decryptSecret, encryptSecret, keyHint } from "./tenant-secrets";
import { TenantError } from "./tenants";

export const PROVIDER_KINDS = ["openai", "anthropic", "google", "mistral", "deepseek", "xai", "qwen", "apify"] as const;
export type ProviderKind = (typeof PROVIDER_KINDS)[number];

export function isProviderKind(v: string): v is ProviderKind {
  return (PROVIDER_KINDS as readonly string[]).includes(v);
}

const TTL_MS = 60_000;
const cache = new Map<string, { key: string | null; bis: number }>();

async function istAdmin(pool: pg.Pool, tenantId: string, actorId: string): Promise<boolean> {
  const r = await pool.query<{ role: string }>(`SELECT "role" FROM "TenantMember" WHERE "tenantId" = $1 AND "actorId" = $2`, [tenantId, actorId]);
  return r.rows[0]?.role === "owner" || r.rows[0]?.role === "admin";
}

export interface ProviderInfo {
  kind: ProviderKind;
  keyHint: string;
  updatedAt: string;
}

export async function listProviders(pool: pg.Pool, tenantId: string): Promise<ProviderInfo[]> {
  const r = await pool.query<{ kind: string; keyHint: string; updatedAt: Date }>(
    `SELECT "kind", "keyHint", "updatedAt" FROM "TenantProvider" WHERE "tenantId" = $1 ORDER BY "kind"`,
    [tenantId],
  );
  return r.rows
    .filter((x) => isProviderKind(x.kind))
    .map((x) => ({ kind: x.kind as ProviderKind, keyHint: x.keyHint, updatedAt: new Date(x.updatedAt).toISOString() }));
}

export async function setProviderKey(pool: pg.Pool, auth: AuthContext, kind: ProviderKind, apiKey: string): Promise<ProviderInfo> {
  if (!(await istAdmin(pool, auth.tenantId, auth.actorId))) throw new TenantError(403, "Nur Admins duerfen Organisationsschluessel setzen.");
  const t = await pool.query<{ kind: string }>(`SELECT "kind" FROM "Tenant" WHERE "id" = $1`, [auth.tenantId]);
  if (t.rows[0]?.kind !== "organisation") throw new TenantError(409, "Organisationsschluessel gibt es nur in einer Organisation.");
  const plain = apiKey.trim();
  if (plain.length < 8) throw new TenantError(400, "Schluessel zu kurz.");
  const ciphertext = encryptSecret(plain, `${auth.tenantId}:${kind}`);
  const hint = keyHint(plain);
  await pool.query(
    `INSERT INTO "TenantProvider" ("tenantId", "kind", "keyCiphertext", "keyHint", "updatedAt", "updatedBy")
     VALUES ($1, $2, $3, $4, CURRENT_TIMESTAMP, $5)
     ON CONFLICT ("tenantId", "kind") DO UPDATE SET "keyCiphertext" = EXCLUDED."keyCiphertext", "keyHint" = EXCLUDED."keyHint",
       "updatedAt" = CURRENT_TIMESTAMP, "updatedBy" = EXCLUDED."updatedBy"`,
    [auth.tenantId, kind, ciphertext, hint, auth.actorId],
  );
  cache.delete(`${auth.tenantId}:${kind}`);
  return { kind, keyHint: hint, updatedAt: new Date().toISOString() };
}

export async function deleteProviderKey(pool: pg.Pool, auth: AuthContext, kind: ProviderKind): Promise<boolean> {
  if (!(await istAdmin(pool, auth.tenantId, auth.actorId))) throw new TenantError(403, "Nur Admins duerfen Organisationsschluessel entfernen.");
  const r = await pool.query(`DELETE FROM "TenantProvider" WHERE "tenantId" = $1 AND "kind" = $2`, [auth.tenantId, kind]);
  cache.delete(`${auth.tenantId}:${kind}`);
  return (r.rowCount ?? 0) > 0;
}

/** Klartext NUR fuer den Proxy-Aufruf; null, wenn nicht hinterlegt. */
export async function getProviderKey(pool: pg.Pool, tenantId: string, kind: ProviderKind): Promise<string | null> {
  const ck = `${tenantId}:${kind}`;
  const hit = cache.get(ck);
  if (hit && hit.bis > Date.now()) return hit.key;
  const r = await pool.query<{ keyCiphertext: string }>(`SELECT "keyCiphertext" FROM "TenantProvider" WHERE "tenantId" = $1 AND "kind" = $2`, [tenantId, kind]);
  const row = r.rows[0];
  const key = row ? decryptSecret(row.keyCiphertext, ck) : null;
  cache.set(ck, { key, bis: Date.now() + TTL_MS });
  return key;
}

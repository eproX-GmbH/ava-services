// O4 — Organisationsschluessel je Anbieter (verschluesselt, nie auslesbar).

import type pg from "pg";
import type { AuthContext } from "../middleware/auth";
import { decryptSecret, encryptSecret, keyHint } from "./tenant-secrets";
import { TenantError } from "./tenants";
import { azureEndpointNormalisieren, deploymentsNormalisieren, type AzureOpenAIConfig } from "./azure-openai";

export const PROVIDER_KINDS = ["openai", "anthropic", "google", "mistral", "deepseek", "xai", "qwen", "apify"] as const;
export type ProviderKind = (typeof PROVIDER_KINDS)[number];

export function isProviderKind(v: string): v is ProviderKind {
  return (PROVIDER_KINDS as readonly string[]).includes(v);
}

const TTL_MS = 60_000;
const cache = new Map<string, { zugang: ProviderZugang | null; bis: number }>();

/** Klartext-Schluessel plus Azure-Konfiguration (nur kind openai). */
export interface ProviderZugang {
  key: string;
  azure: AzureOpenAIConfig | null;
}

async function istAdmin(pool: pg.Pool, tenantId: string, actorId: string): Promise<boolean> {
  const r = await pool.query<{ role: string }>(`SELECT "role" FROM "TenantMember" WHERE "tenantId" = $1 AND "actorId" = $2`, [tenantId, actorId]);
  return r.rows[0]?.role === "owner" || r.rows[0]?.role === "admin";
}

export interface ProviderInfo {
  kind: ProviderKind;
  keyHint: string;
  updatedAt: string;
  /** Azure OpenAI (nur openai): Endpunkt; null = OpenAI direkt. */
  endpoint?: string | null;
  deployments?: Record<string, string> | null;
}

export async function listProviders(pool: pg.Pool, tenantId: string): Promise<ProviderInfo[]> {
  const r = await pool.query<{ kind: string; keyHint: string; updatedAt: Date; endpoint: string | null; deployments: Record<string, string> | null }>(
    `SELECT "kind", "keyHint", "updatedAt", "endpoint", "deployments" FROM "TenantProvider" WHERE "tenantId" = $1 ORDER BY "kind"`,
    [tenantId],
  );
  return r.rows
    .filter((x) => isProviderKind(x.kind))
    .map((x) => ({
      kind: x.kind as ProviderKind,
      keyHint: x.keyHint,
      updatedAt: new Date(x.updatedAt).toISOString(),
      ...(x.kind === "openai" ? { endpoint: x.endpoint ?? null, deployments: x.deployments ?? null } : {}),
    }));
}

/**
 * Organisationsschluessel setzen. `apiKey` darf fehlen, wenn schon einer
 * hinterlegt ist (nur Azure-Einstellungen aendern). `azure` nur fuer openai:
 * Objekt = Azure OpenAI, null = zurueck auf OpenAI direkt, undefined = unveraendert.
 */
export async function setProviderKey(
  pool: pg.Pool,
  auth: AuthContext,
  kind: ProviderKind,
  apiKey: string | undefined,
  azure?: { endpoint: string; deployments?: Record<string, unknown> | null } | null,
): Promise<ProviderInfo> {
  if (!(await istAdmin(pool, auth.tenantId, auth.actorId))) throw new TenantError(403, "Nur Admins duerfen Organisationsschluessel setzen.");
  const t = await pool.query<{ kind: string }>(`SELECT "kind" FROM "Tenant" WHERE "id" = $1`, [auth.tenantId]);
  if (t.rows[0]?.kind !== "organisation") throw new TenantError(409, "Organisationsschluessel gibt es nur in einer Organisation.");
  if (azure !== undefined && kind !== "openai") throw new TenantError(400, "Azure-Einstellungen gibt es nur fuer OpenAI.");
  let az: AzureOpenAIConfig | null | undefined = undefined;
  if (azure) {
    try {
      az = { endpoint: azureEndpointNormalisieren(azure.endpoint), deployments: deploymentsNormalisieren(azure.deployments ?? {}) };
    } catch (err) {
      throw new TenantError(400, err instanceof Error ? err.message : String(err));
    }
  } else if (azure === null) {
    az = null;
  }
  const plain = apiKey?.trim();
  if (plain !== undefined && plain.length < 8) throw new TenantError(400, "Schluessel zu kurz.");
  if (!plain && az === undefined) throw new TenantError(400, "Schluessel oder Azure-Einstellungen angeben.");
  if (!plain) {
    // Nur die Azure-Einstellungen aendern; dafuer muss ein Schluessel existieren.
    const r = await pool.query<{ keyHint: string }>(
      `UPDATE "TenantProvider" SET "endpoint" = $3, "deployments" = $4::jsonb, "updatedAt" = CURRENT_TIMESTAMP, "updatedBy" = $5
       WHERE "tenantId" = $1 AND "kind" = $2 RETURNING "keyHint"`,
      [auth.tenantId, kind, az?.endpoint ?? null, az ? JSON.stringify(az.deployments) : null, auth.actorId],
    );
    if (!r.rows[0]) throw new TenantError(400, "Erst einen Schluessel hinterlegen.");
    cache.delete(`${auth.tenantId}:${kind}`);
    return { kind, keyHint: r.rows[0].keyHint, updatedAt: new Date().toISOString(), ...(kind === "openai" ? { endpoint: az?.endpoint ?? null, deployments: az?.deployments ?? null } : {}) };
  }
  const ciphertext = encryptSecret(plain, `${auth.tenantId}:${kind}`);
  const hint = keyHint(plain);
  await pool.query(
    `INSERT INTO "TenantProvider" ("tenantId", "kind", "keyCiphertext", "keyHint", "updatedAt", "updatedBy", "endpoint", "deployments")
     VALUES ($1, $2, $3, $4, CURRENT_TIMESTAMP, $5, $6, $7::jsonb)
     ON CONFLICT ("tenantId", "kind") DO UPDATE SET "keyCiphertext" = EXCLUDED."keyCiphertext", "keyHint" = EXCLUDED."keyHint",
       "updatedAt" = CURRENT_TIMESTAMP, "updatedBy" = EXCLUDED."updatedBy"${az !== undefined ? `, "endpoint" = EXCLUDED."endpoint", "deployments" = EXCLUDED."deployments"` : ""}`,
    [auth.tenantId, kind, ciphertext, hint, auth.actorId, az?.endpoint ?? null, az ? JSON.stringify(az.deployments) : null],
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

/** Klartext und Azure-Konfiguration NUR fuer den Proxy-Aufruf; null, wenn nicht hinterlegt. */
export async function getProviderZugang(pool: pg.Pool, tenantId: string, kind: ProviderKind): Promise<ProviderZugang | null> {
  const ck = `${tenantId}:${kind}`;
  const hit = cache.get(ck);
  if (hit && hit.bis > Date.now()) return hit.zugang;
  const r = await pool.query<{ keyCiphertext: string; endpoint: string | null; deployments: Record<string, string> | null }>(
    `SELECT "keyCiphertext", "endpoint", "deployments" FROM "TenantProvider" WHERE "tenantId" = $1 AND "kind" = $2`,
    [tenantId, kind],
  );
  const row = r.rows[0];
  const zugang: ProviderZugang | null = row
    ? { key: decryptSecret(row.keyCiphertext, ck), azure: kind === "openai" && row.endpoint ? { endpoint: row.endpoint, deployments: row.deployments ?? {} } : null }
    : null;
  cache.set(ck, { zugang, bis: Date.now() + TTL_MS });
  return zugang;
}

/** Klartext NUR fuer den Proxy-Aufruf; null, wenn nicht hinterlegt. */
export async function getProviderKey(pool: pg.Pool, tenantId: string, kind: ProviderKind): Promise<string | null> {
  return (await getProviderZugang(pool, tenantId, kind))?.key ?? null;
}

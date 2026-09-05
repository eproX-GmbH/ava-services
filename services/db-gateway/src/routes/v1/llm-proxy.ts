// O4 (docs/PLAN_ORGANISATIONEN.md §5) — Stellvertreter-Proxy.
//
//   GET    /v1/tenants/me/providers          Welche Organisationsschluessel gibt es (nur Hinweis, letzte 4 Zeichen)
//   PUT    /v1/tenants/me/providers/{kind}   Schluessel setzen (Admin) — Klartext kommt rein, geht nie wieder raus
//   DELETE /v1/tenants/me/providers/{kind}   Schluessel entfernen (Admin)
//   ALL    /v1/llm/{kind}/*                  Pfad-Passthrough auf die Anbieter-API mit Organisationsschluessel
//   ALL    /v1/proxy/apify/*                 Passthrough auf api.apify.com mit Organisations-Token
//
// Nur fuer Mitglieder, deren Organisation den Schluessel hinterlegt hat
// (sonst 404 provider_not_configured). Streaming wird durchgereicht; die
// Token-Zaehler werden aus der Antwort gelesen (LlmUsage). Prompts werden
// NUR gespeichert, wenn TenantPolicy.promptAudit gesetzt ist.

import { OpenAPIHono, createRoute, z } from "@hono/zod-openapi";
import { HTTPException } from "hono/http-exception";
import type { Context } from "hono";
import { getGatewayPool } from "../../lib/producer-pools";
import { logger } from "../../lib/logger";
import { TenantError } from "../../lib/tenants";
import { SecretsUnconfiguredError, secretsConfigured } from "../../lib/tenant-secrets";
import {
  PROVIDER_KINDS,
  isProviderKind,
  listProviders,
  setProviderKey,
  deleteProviderKey,
  getProviderKey,
  type ProviderKind,
} from "../../lib/tenant-providers";
import { estimateMicroUsd } from "../../lib/llm-pricing";
import { parseUsageFromJson, parseUsageFromSse, extractTextFromSse, type UsageCounts } from "../../lib/llm-usage-parse";
import { checkQuota, getQuota, setQuota, usageSummary } from "../../lib/quota";

export const llmProxyRouter = new OpenAPIHono();

const UPSTREAM: Record<Exclude<ProviderKind, "apify">, string> = {
  openai: "https://api.openai.com/v1",
  anthropic: "https://api.anthropic.com",
  google: "https://generativelanguage.googleapis.com",
  mistral: "https://api.mistral.ai/v1",
  deepseek: "https://api.deepseek.com/v1",
  xai: "https://api.x.ai/v1",
  qwen: "https://dashscope-intl.aliyuncs.com/compatible-mode/v1",
};
const APIFY_UPSTREAM = "https://api.apify.com";

const MAX_BODY_BYTES = 8 * 1024 * 1024;
const AUDIT_MAX_CHARS = 200_000;

function wrap<T>(fn: () => Promise<T>): Promise<T> {
  return fn().catch((err: unknown) => {
    if (err instanceof TenantError) throw new HTTPException(err.status, { message: err.message });
    if (err instanceof SecretsUnconfiguredError) throw new HTTPException(503, { message: "secrets_unconfigured" });
    throw err;
  });
}

const KindParam = z.object({ kind: z.enum(PROVIDER_KINDS) });

llmProxyRouter.openapi(
  createRoute({
    method: "get",
    path: "/tenants/me/providers",
    tags: ["tenants"],
    summary: "Hinterlegte Organisationsschluessel (nur Anbieter + letzte 4 Zeichen).",
    responses: { 200: { content: { "application/json": { schema: z.object({}).passthrough() } }, description: "ok" } },
  }),
  async (c) => {
    const auth = c.get("auth");
    return c.json({ configured: secretsConfigured(), providers: await listProviders(getGatewayPool(), auth.tenantId) });
  },
);

llmProxyRouter.openapi(
  createRoute({
    method: "put",
    path: "/tenants/me/providers/{kind}",
    tags: ["tenants"],
    summary: "Organisationsschluessel setzen (Admin). Der Klartext wird verschluesselt abgelegt und nie zurueckgegeben.",
    request: { params: KindParam, body: { content: { "application/json": { schema: z.object({ apiKey: z.string().min(8).max(4096) }) } } } },
    responses: { 200: { content: { "application/json": { schema: z.object({}).passthrough() } }, description: "gesetzt" } },
  }),
  async (c) => {
    const { kind } = c.req.valid("param");
    const { apiKey } = c.req.valid("json");
    const info = await wrap(() => setProviderKey(getGatewayPool(), c.get("auth"), kind, apiKey));
    return c.json({ ok: true, ...info });
  },
);

llmProxyRouter.openapi(
  createRoute({
    method: "delete",
    path: "/tenants/me/providers/{kind}",
    tags: ["tenants"],
    summary: "Organisationsschluessel entfernen (Admin).",
    request: { params: KindParam },
    responses: { 200: { content: { "application/json": { schema: z.object({}).passthrough() } }, description: "entfernt" } },
  }),
  async (c) => {
    const { kind } = c.req.valid("param");
    const removed = await wrap(() => deleteProviderKey(getGatewayPool(), c.get("auth"), kind));
    return c.json({ ok: true, removed });
  },
);

// ---- O6 — Limits und Verbrauch --------------------------------------------

const QuotaShape = z.object({
  mode: z.enum(["off", "org_total", "per_user_daily"]).optional(),
  orgMonthlyCents: z.number().int().min(0).max(100_000_000).nullable().optional(),
  userDailyCents: z.number().int().min(0).max(100_000_000).nullable().optional(),
  hardStop: z.boolean().optional(),
});

llmProxyRouter.openapi(
  createRoute({
    method: "get",
    path: "/tenants/me/quota",
    tags: ["tenants"],
    summary: "Limit fuer Stellvertreter-Aufrufe (US-Cent) und aktueller Stand.",
    responses: { 200: { content: { "application/json": { schema: z.object({}).passthrough() } }, description: "ok" } },
  }),
  async (c) => {
    const auth = c.get("auth");
    const pool = getGatewayPool();
    return c.json({ quota: await getQuota(pool, auth.tenantId), stand: await checkQuota(pool, auth.tenantId, auth.actorId) });
  },
);

llmProxyRouter.openapi(
  createRoute({
    method: "put",
    path: "/tenants/me/quota",
    tags: ["tenants"],
    summary: "Limit setzen (Admin): Monatsbudget der Organisation oder Tagesbudget je Mitglied, harter Stopp oder Hinweis.",
    request: { body: { content: { "application/json": { schema: QuotaShape } } } },
    responses: { 200: { content: { "application/json": { schema: z.object({}).passthrough() } }, description: "gesetzt" } },
  }),
  async (c) => c.json(await wrap(() => setQuota(getGatewayPool(), c.get("auth"), c.req.valid("json")))),
);

llmProxyRouter.openapi(
  createRoute({
    method: "get",
    path: "/tenants/me/usage",
    tags: ["tenants"],
    summary: "Verbrauch ueber Organisationsschluessel je Mitglied und Tag (Admins: alle, Mitglieder: nur eigener).",
    request: { query: z.object({ days: z.coerce.number().int().min(1).max(90).default(30) }) },
    responses: { 200: { content: { "application/json": { schema: z.object({}).passthrough() } }, description: "ok" } },
  }),
  async (c) => {
    const { days } = c.req.valid("query");
    return c.json(await usageSummary(getGatewayPool(), c.get("auth"), days));
  },
);

// ---- Passthrough --------------------------------------------------------

const HOP_BY_HOP = new Set([
  "authorization", "host", "connection", "content-length", "keep-alive", "proxy-authorization",
  "te", "trailer", "transfer-encoding", "upgrade", "x-api-key", "x-goog-api-key", "cookie",
]);
const RESPONSE_DROP = new Set(["content-encoding", "content-length", "transfer-encoding", "connection", "set-cookie"]);

function authHeaders(kind: ProviderKind, key: string): Record<string, string> {
  if (kind === "anthropic") return { "x-api-key": key };
  if (kind === "google") return { "x-goog-api-key": key };
  return { authorization: `Bearer ${key}` };
}

async function readBody(c: Context): Promise<Buffer | null> {
  if (c.req.method === "GET" || c.req.method === "HEAD") return null;
  const buf = Buffer.from(await c.req.arrayBuffer());
  if (buf.length > MAX_BODY_BYTES) throw new HTTPException(413, { message: "body_too_large" });
  return buf;
}

async function passthrough(c: Context, kind: ProviderKind, base: string, rest: string, meter: boolean): Promise<Response> {
  const auth = c.get("auth");
  const pool = getGatewayPool();
  if (!secretsConfigured()) throw new HTTPException(503, { message: "secrets_unconfigured" });
  const key = await getProviderKey(pool, auth.tenantId, kind);
  if (!key) throw new HTTPException(404, { message: `provider_not_configured:${kind}` });

  // O6 — Vorabpruefung des Limits (nur messbare Stellvertreter-Aufrufe).
  let quotaWarnung: string | null = null;
  if (meter) {
    const q = await checkQuota(pool, auth.tenantId, auth.actorId);
    if (!q.allowed) {
      const info = { error: "org_quota_exceeded", scope: q.scope, limitCents: q.limitCents, usedCents: q.usedCents, resetAt: q.resetAt, hardStop: q.hardStop };
      if (q.hardStop) {
        logger.info({ tenantId: auth.tenantId, actorId: auth.actorId, scope: q.scope }, "llm-proxy: org quota exceeded (hard stop)");
        return new Response(JSON.stringify(info), {
          status: 429,
          headers: { "content-type": "application/json", "retry-after": String(Math.max(60, Math.round(((q.resetAt ? Date.parse(q.resetAt) : Date.now() + 3_600_000) - Date.now()) / 1000))) },
        });
      }
      quotaWarnung = JSON.stringify(info);
    }
  }

  const url = new URL(c.req.url);
  const target = `${base}/${rest.replace(/^\/+/, "")}${url.search}`;
  const body = await readBody(c);
  const headers: Record<string, string> = {};
  for (const [k, v] of Object.entries(c.req.header())) {
    if (!HOP_BY_HOP.has(k.toLowerCase())) headers[k] = v;
  }
  Object.assign(headers, authHeaders(kind, key));
  if (kind === "google" && url.searchParams.has("key")) {
    // Google akzeptiert den Schluessel auch als Query-Parameter — Client-
    // Werte dort entfernen, damit nie ein fremder Schluessel durchgeht.
    url.searchParams.delete("key");
  }

  let model: string | null = null;
  let requestJson: unknown = null;
  if (body && (headers["content-type"] ?? "").includes("application/json")) {
    try {
      requestJson = JSON.parse(body.toString("utf8"));
      const m = (requestJson as Record<string, unknown>)["model"];
      if (typeof m === "string") model = m;
    } catch {
      /* kein JSON */
    }
  }
  if (!model && kind === "google") {
    const mm = /models\/([^:/]+)/.exec(rest);
    if (mm) model = mm[1] ?? null;
  }

  const start = Date.now();
  let upstream: Response;
  try {
    upstream = await fetch(target, { method: c.req.method, headers, body: body ? new Uint8Array(body) : undefined, redirect: "manual" });
  } catch (err) {
    logger.warn({ kind, err: err instanceof Error ? err.message : String(err) }, "llm-proxy upstream fetch failed");
    throw new HTTPException(502, { message: "upstream_unreachable" });
  }

  const outHeaders = new Headers();
  upstream.headers.forEach((v, k) => {
    if (!RESPONSE_DROP.has(k.toLowerCase())) outHeaders.set(k, v);
  });
  if (quotaWarnung) outHeaders.set("x-ava-org-quota", quotaWarnung);
  const ctype = upstream.headers.get("content-type") ?? "";
  const streamed = ctype.includes("text/event-stream");
  const promptAudit = meter ? await promptAuditAktiv(pool, auth.tenantId) : false;

  const abschluss = (text: string, status: number) => {
    const latencyMs = Date.now() - start;
    if (!meter) {
      void recordUsage(pool, { tenantId: auth.tenantId, actorId: auth.actorId, kind, model: rest.split("/")[0] ?? null, usage: null, status, latencyMs, streamed: false });
      return;
    }
    const usage = streamed ? parseUsageFromSse(text) : parseUsageFromJson(text);
    void recordUsage(pool, { tenantId: auth.tenantId, actorId: auth.actorId, kind, model: usage?.model ?? model, usage, status, latencyMs, streamed });
    if (promptAudit && status < 400) {
      const response = streamed ? extractTextFromSse(text) : text.slice(0, AUDIT_MAX_CHARS);
      void pool
        .query(
          `INSERT INTO "PromptAudit" ("id", "tenantId", "actorId", "kind", "model", "request", "response") VALUES ($1, $2, $3, $4, $5, $6::jsonb, $7)`,
          [`pa_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 10)}`, auth.tenantId, auth.actorId, kind, usage?.model ?? model, JSON.stringify(requestJson ?? { raw: body?.toString("utf8").slice(0, AUDIT_MAX_CHARS) ?? null }), response],
        )
        .catch((err: unknown) => logger.warn({ err: err instanceof Error ? err.message : String(err) }, "prompt-audit insert failed"));
    }
  };

  if (!upstream.body) {
    abschluss("", upstream.status);
    return new Response(null, { status: upstream.status, headers: outHeaders });
  }
  if (!streamed) {
    const text = await upstream.text();
    abschluss(text, upstream.status);
    return new Response(text, { status: upstream.status, headers: outHeaders });
  }
  // SSE: Bytes unveraendert weiterreichen, parallel Text sammeln.
  const decoder = new TextDecoder();
  let acc = "";
  const status = upstream.status;
  const tee = new TransformStream<Uint8Array, Uint8Array>({
    transform(chunk, ctrl) {
      if (acc.length < 4 * AUDIT_MAX_CHARS) acc += decoder.decode(chunk, { stream: true });
      ctrl.enqueue(chunk);
    },
    flush() {
      abschluss(acc, status);
    },
  });
  return new Response(upstream.body.pipeThrough(tee), { status, headers: outHeaders });
}

async function promptAuditAktiv(pool: ReturnType<typeof getGatewayPool>, tenantId: string): Promise<boolean> {
  const r = await pool.query<{ promptAudit: boolean }>(`SELECT "promptAudit" FROM "TenantPolicy" WHERE "tenantId" = $1`, [tenantId]);
  return r.rows[0]?.promptAudit === true;
}

async function recordUsage(
  pool: ReturnType<typeof getGatewayPool>,
  e: { tenantId: string; actorId: string; kind: ProviderKind; model: string | null; usage: UsageCounts | null; status: number; latencyMs: number; streamed: boolean },
): Promise<void> {
  const input = e.usage?.inputTokens ?? 0;
  const output = e.usage?.outputTokens ?? 0;
  const cache = e.usage?.cacheReadTokens ?? 0;
  const cost = e.kind === "apify" ? null : estimateMicroUsd({ provider: e.kind, model: e.model, inputTokens: input, outputTokens: output, cacheReadTokens: cache });
  try {
    await pool.query(
      `INSERT INTO "LlmUsage" ("id", "tenantId", "actorId", "kind", "model", "inputTokens", "outputTokens", "cacheReadTokens", "costMicroUsd", "status", "latencyMs", "streamed")
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12)`,
      [`lu_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 10)}`, e.tenantId, e.actorId, e.kind, e.model, input, output, cache, cost, e.status, e.latencyMs, e.streamed],
    );
  } catch (err) {
    logger.warn({ err: err instanceof Error ? err.message : String(err) }, "llm-usage insert failed");
  }
}

llmProxyRouter.all("/llm/:kind/*", async (c) => {
  const kind = c.req.param("kind");
  if (!isProviderKind(kind) || kind === "apify") throw new HTTPException(404, { message: "unknown_provider" });
  const rest = c.req.path.replace(/^\/v1\/llm\/[^/]+\/?/, "");
  return passthrough(c, kind, UPSTREAM[kind], rest, true);
});

llmProxyRouter.all("/proxy/apify/*", async (c) => {
  const rest = c.req.path.replace(/^\/v1\/proxy\/apify\/?/, "");
  return passthrough(c, "apify", APIFY_UPSTREAM, rest, false);
});

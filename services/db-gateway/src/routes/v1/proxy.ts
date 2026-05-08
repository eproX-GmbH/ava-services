// §8.v3 — operator-paid API key proxies (today: valueserp).
//
// Some producer code paths use APIs the operator pays for, not the
// user (today: only valueserp). Localizing those producers naively
// would require shipping the operator's key inside the desktop
// binary, which is a fundamental DRM problem — any user who reads
// the binary recovers the key. We mediate instead: the desktop POSTs
// to `/v1/proxy/<service>` with a JWT, the gateway reads its own
// fly-secret, makes the upstream call, and returns the response.
//
// Hardening on top of the bare proxy (added 2026-05-06):
//
//   1. JWT scope gate — `valueserp:enabled` must be present. Keycloak
//      grants it to every realm user by default; the operator can
//      flip it off per-user/per-role from the admin UI to disable a
//      tenant's access without redeploying.
//
//   2. Per-tenant rate limit — token bucket implemented as a count
//      of `ProxyAudit` rows in four overlapping windows (minute /
//      hour / day / month). The first window that's saturated wins.
//      Limits live in env (`VALUESERP_RATE_*`) so the operator can
//      tune via `fly secrets set` — no code change. Per-tenant
//      overrides come from `ProxyQuotaOverride`; null override =
//      env default. The override row also carries an `enabled`
//      kill-switch for incident response.
//
//   3. Same-query cache — sha256(canonicalized request body) keyed
//      `ProxyCache` row, TTL `VALUESERP_CACHE_TTL_HOURS`. Set TTL=0
//      to disable. Cache hits still get an audit row (with
//      `cacheHit=true`) so the rate-limit window includes them —
//      otherwise a tenant could hammer cached queries to bypass the
//      cap. Audit row's `latencyMs` is the local lookup time, not
//      the (saved) upstream call.
//
//   4. Per-call audit — `ProxyAudit` row written for every accepted
//      and every denied request. `qHash` (sha256 of canonicalized
//      params) lets the operator correlate spikes / bill back
//      without storing the literal query (PII risk).
//
//   5. Param whitelist — same as before; prevents a malicious client
//      from pointing the upstream call at e.g. a different valueserp
//      endpoint.
//
// Compute (parsing/scoring/classification) still runs locally in the
// producer subprocess. Only the upstream HTTP hop is server-mediated.

import { OpenAPIHono } from "@hono/zod-openapi";
import { HTTPException } from "hono/http-exception";
import { createHash } from "node:crypto";
import type pg from "pg";
import { loadEnv } from "../../lib/env";
import { logger } from "../../lib/logger";
import { getGatewayPool } from "../../lib/producer-pools";
import { requireScope } from "../../middleware/auth";

export const proxyRouter = new OpenAPIHono();

const env = loadEnv();

// ---- valueserp ------------------------------------------------------------

interface ValueserpRequest {
  q: string;
  // Pass-through whitelist. Caller-supplied values override the
  // operator's gateway defaults.
  search_type?: string;
  engine?: string;
  num?: number;
  location?: string;
  location_auto?: boolean;
  gl?: string;
  hl?: string;
  google_domain?: string;
}

const VALUESERP_ENDPOINT = "https://api.valueserp.com/search";

const ALLOWED_PARAMS: ReadonlySet<keyof ValueserpRequest> = new Set([
  "q",
  "search_type",
  "engine",
  "num",
  "location",
  "location_auto",
  "gl",
  "hl",
  "google_domain",
]);

interface RateLimitDecision {
  allowed: boolean;
  // Which window failed, for the 429 response body. Helps the
  // producer log a useful "wait until X" rather than a generic 429.
  failedWindow?: "minute" | "hour" | "day" | "month";
  retryAfterSeconds?: number;
}

interface EffectiveLimits {
  perMinute: number;
  perHour: number;
  perDay: number;
  perMonth: number;
  enabled: boolean;
}

interface QuotaOverrideRow {
  enabled: boolean;
  perMinute: number | null;
  perHour: number | null;
  perDay: number | null;
  perMonth: number | null;
}

const PROXY_NAME = "valueserp";

/**
 * Resolve the effective per-(tenant, proxy) limits by overlaying
 * `ProxyQuotaOverride` (if any) on top of the env defaults. Each
 * override column is independently nullable — null = "use env
 * default" — so a tenant can have e.g. only `perMonth` raised
 * without touching the smaller windows.
 */
async function effectiveLimits(
  pool: pg.Pool,
  tenantId: string,
): Promise<EffectiveLimits> {
  const res = await pool.query<QuotaOverrideRow>(
    `SELECT enabled, "perMinute", "perHour", "perDay", "perMonth"
     FROM "ProxyQuotaOverride"
     WHERE "tenantId" = $1 AND proxy = $2`,
    [tenantId, PROXY_NAME],
  );
  const o = res.rows[0];
  return {
    enabled: o ? o.enabled : true,
    perMinute: o?.perMinute ?? env.VALUESERP_RATE_PER_MINUTE,
    perHour:   o?.perHour   ?? env.VALUESERP_RATE_PER_HOUR,
    perDay:    o?.perDay    ?? env.VALUESERP_RATE_PER_DAY,
    perMonth:  o?.perMonth  ?? env.VALUESERP_RATE_PER_MONTH,
  };
}

/**
 * Single-pass rate check. We issue ONE query that returns four
 * counts via FILTER clauses — much cheaper than four sequential
 * round-trips and the count windows don't drift between them.
 *
 * Returns the first window that's saturated (smallest window first
 * — minute beats month for the 429 message), or `allowed:true` when
 * everything is clear.
 */
async function checkRateLimit(
  pool: pg.Pool,
  tenantId: string,
  limits: EffectiveLimits,
): Promise<RateLimitDecision> {
  if (!limits.enabled) {
    return {
      allowed: false,
      failedWindow: "minute",
      retryAfterSeconds: 60,
    };
  }
  const res = await pool.query<{
    last_minute: string;
    last_hour: string;
    last_day: string;
    last_month: string;
  }>(
    `SELECT
       COUNT(*) FILTER (WHERE "createdAt" > NOW() - INTERVAL '1 minute') AS last_minute,
       COUNT(*) FILTER (WHERE "createdAt" > NOW() - INTERVAL '1 hour')   AS last_hour,
       COUNT(*) FILTER (WHERE "createdAt" > NOW() - INTERVAL '1 day')    AS last_day,
       COUNT(*) FILTER (WHERE "createdAt" > NOW() - INTERVAL '30 days')  AS last_month
     FROM "ProxyAudit"
     WHERE proxy = $1 AND "tenantId" = $2`,
    [PROXY_NAME, tenantId],
  );
  const row = res.rows[0]!;
  const m = Number(row.last_minute);
  const h = Number(row.last_hour);
  const d = Number(row.last_day);
  const mo = Number(row.last_month);

  if (m >= limits.perMinute) return { allowed: false, failedWindow: "minute", retryAfterSeconds: 60 };
  if (h >= limits.perHour)   return { allowed: false, failedWindow: "hour",   retryAfterSeconds: 3600 };
  if (d >= limits.perDay)    return { allowed: false, failedWindow: "day",    retryAfterSeconds: 86400 };
  if (mo >= limits.perMonth) return { allowed: false, failedWindow: "month",  retryAfterSeconds: 30 * 86400 };
  return { allowed: true };
}

/**
 * Canonicalize the request body before hashing, so two callers
 * sending the same params in different key order hash to the same
 * value (and hit the same cache). Drop nullish, sort keys, JSON.
 */
function canonicalizeBody(body: ValueserpRequest): string {
  const filtered: Record<string, string | number | boolean> = {};
  for (const k of Object.keys(body).sort()) {
    if (!ALLOWED_PARAMS.has(k as keyof ValueserpRequest)) continue;
    const v = (body as unknown as Record<string, unknown>)[k];
    if (v == null) continue;
    filtered[k] = v as string | number | boolean;
  }
  return JSON.stringify(filtered);
}

function sha256(s: string): string {
  return createHash("sha256").update(s).digest("hex");
}

async function readCache(
  pool: pg.Pool,
  cacheKey: string,
): Promise<unknown | null> {
  if (env.VALUESERP_CACHE_TTL_HOURS <= 0) return null;
  const res = await pool.query<{ responseJson: string }>(
    `SELECT "responseJson" FROM "ProxyCache"
     WHERE "cacheKey" = $1 AND "expiresAt" > NOW()`,
    [cacheKey],
  );
  if (res.rowCount === 0) return null;
  try {
    return JSON.parse(res.rows[0]!.responseJson);
  } catch {
    // Bad row — ignore + let the upstream call refresh it.
    return null;
  }
}

async function writeCache(
  pool: pg.Pool,
  cacheKey: string,
  responseJson: string,
): Promise<void> {
  if (env.VALUESERP_CACHE_TTL_HOURS <= 0) return;
  await pool
    .query(
      `INSERT INTO "ProxyCache" ("cacheKey", proxy, "responseJson", "expiresAt", "createdAt")
       VALUES ($1, $2, $3, NOW() + ($4 || ' hours')::interval, NOW())
       ON CONFLICT ("cacheKey") DO UPDATE
       SET "responseJson" = EXCLUDED."responseJson",
           "expiresAt"    = EXCLUDED."expiresAt"`,
      [cacheKey, PROXY_NAME, responseJson, String(env.VALUESERP_CACHE_TTL_HOURS)],
    )
    .catch((err: unknown) => {
      // Cache write failures are non-fatal — log + drop.
      logger.warn(
        { err: err instanceof Error ? err.message : String(err) },
        "valueserp: cache write failed",
      );
    });
}

async function recordAudit(
  pool: pg.Pool,
  row: {
    tenantId: string;
    actorId: string;
    qHash: string;
    status: number;
    latencyMs: number;
    cacheHit: boolean;
  },
): Promise<void> {
  await pool
    .query(
      `INSERT INTO "ProxyAudit"
         (proxy, "tenantId", "actorId", "qHash", status, "latencyMs", "cacheHit", "createdAt")
       VALUES ($1, $2, $3, $4, $5, $6, $7, NOW())`,
      [
        PROXY_NAME,
        row.tenantId,
        row.actorId,
        row.qHash,
        row.status,
        row.latencyMs,
        row.cacheHit,
      ],
    )
    .catch((err: unknown) => {
      // Audit failures are non-fatal — we'd rather serve the call than
      // 500. The accounting is still on the upstream's bill, so this
      // is a logging gap, not a money gap.
      logger.warn(
        { err: err instanceof Error ? err.message : String(err) },
        "valueserp: audit write failed",
      );
    });
}

// Path is RELATIVE to the proxyRouter's mount point (`v1.route("/", proxyRouter)`
// inside `/v1` app). Don't prefix with `/v1` here — Hono would concatenate
// to `/v1/v1/proxy/valueserp` and producers (which hit `/v1/proxy/valueserp`)
// would 404. v0.1.58 cosmetic fix.
proxyRouter.post(
  "/proxy/valueserp",
  requireScope("valueserp:enabled"),
  async (c) => {
    if (!env.VALUESERP_API_KEY) {
      logger.error("VALUESERP_API_KEY not set on gateway");
      throw new HTTPException(503, { message: "valueserp_proxy_unconfigured" });
    }

    let body: ValueserpRequest;
    try {
      body = (await c.req.json()) as ValueserpRequest;
    } catch {
      throw new HTTPException(400, { message: "invalid_json" });
    }
    if (!body?.q || typeof body.q !== "string") {
      throw new HTTPException(400, { message: "missing_query_param_q" });
    }

    const auth = c.get("auth");
    if (!auth?.tenantId || !auth?.actorId) {
      throw new HTTPException(401, { message: "auth_context_missing" });
    }
    const { tenantId, actorId } = auth;

    const pool = getGatewayPool();

    // ---- 1. Rate limit -----------------------------------------------------
    const limits = await effectiveLimits(pool, tenantId);
    const decision = await checkRateLimit(pool, tenantId, limits);
    if (!decision.allowed) {
      const qHash = sha256(canonicalizeBody(body));
      // Audit the denied request too — counts toward operator's
      // visibility, doesn't count toward valueserp's bill (no
      // upstream call). Status=429 to distinguish from upstream 429.
      await recordAudit(pool, {
        tenantId,
        actorId,
        qHash,
        status: 429,
        latencyMs: 0,
        cacheHit: false,
      });
      logger.warn(
        {
          tenantId,
          actorId,
          window: decision.failedWindow,
          enabled: limits.enabled,
        },
        "valueserp: rate-limit deny",
      );
      c.header(
        "retry-after",
        String(decision.retryAfterSeconds ?? 60),
      );
      return c.json(
        {
          error: limits.enabled ? "rate_limited" : "tenant_disabled",
          window: decision.failedWindow,
          retryAfterSeconds: decision.retryAfterSeconds,
        },
        429,
      );
    }

    // ---- 2. Cache lookup ---------------------------------------------------
    const canonical = canonicalizeBody(body);
    const qHash = sha256(canonical);
    const cacheKey = sha256(`${PROXY_NAME}:${canonical}`);

    const cacheStart = Date.now();
    const cached = await readCache(pool, cacheKey);
    if (cached !== null) {
      const latencyMs = Date.now() - cacheStart;
      await recordAudit(pool, {
        tenantId,
        actorId,
        qHash,
        status: 200,
        latencyMs,
        cacheHit: true,
      });
      return c.json(cached);
    }

    // ---- 3. Upstream call --------------------------------------------------
    const params = new URLSearchParams();
    params.set("api_key", env.VALUESERP_API_KEY);

    if (env.VALUESERP_DOMAIN) params.set("google_domain", env.VALUESERP_DOMAIN);
    if (env.VALUESERP_UI_LANGUAGE) params.set("hl", env.VALUESERP_UI_LANGUAGE);
    if (env.VALUESERP_LOCATION) params.set("gl", env.VALUESERP_LOCATION);
    if (env.VALUESERP_COUNTRY) params.set("location", env.VALUESERP_COUNTRY);
    if (env.VALUESERP_PAGINATION_SIZE) {
      params.set("num", String(env.VALUESERP_PAGINATION_SIZE));
    }
    params.set("engine", "google");
    params.set("location_auto", "false");

    for (const [k, v] of Object.entries(body)) {
      if (v == null) continue;
      if (!ALLOWED_PARAMS.has(k as keyof ValueserpRequest)) continue;
      params.set(k, String(v));
    }

    const url = `${VALUESERP_ENDPOINT}?${params.toString()}`;
    const upstreamStart = Date.now();
    const upstream = await fetch(url, { method: "GET" });
    const text = await upstream.text();
    const latencyMs = Date.now() - upstreamStart;

    if (!upstream.ok) {
      await recordAudit(pool, {
        tenantId,
        actorId,
        qHash,
        status: upstream.status,
        latencyMs,
        cacheHit: false,
      });
      logger.warn(
        {
          tenantId,
          actorId,
          status: upstream.status,
          // Don't log `q` at warn level — it's user search content
          // (potentially PII / business-sensitive).
          bodySnippet: text.slice(0, 200),
        },
        "valueserp upstream non-2xx",
      );
      if (upstream.status === 401 || upstream.status === 403) {
        throw new HTTPException(503, { message: "valueserp_auth_failed" });
      }
      if (upstream.status === 429) {
        throw new HTTPException(429, { message: "valueserp_rate_limited" });
      }
      throw new HTTPException(502, { message: "valueserp_upstream_failed" });
    }

    let parsed: unknown;
    try {
      parsed = JSON.parse(text);
    } catch {
      await recordAudit(pool, {
        tenantId,
        actorId,
        qHash,
        status: 502,
        latencyMs,
        cacheHit: false,
      });
      throw new HTTPException(502, {
        message: "valueserp_upstream_invalid_json",
      });
    }

    await recordAudit(pool, {
      tenantId,
      actorId,
      qHash,
      status: 200,
      latencyMs,
      cacheHit: false,
    });
    await writeCache(pool, cacheKey, text);

    return c.json(parsed);
  },
);

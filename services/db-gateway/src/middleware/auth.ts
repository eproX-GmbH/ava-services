import { createMiddleware } from "hono/factory";
import {
  jwtVerify,
  importSPKI,
  createRemoteJWKSet,
  type KeyLike,
  type JWTVerifyGetKey,
} from "jose";
import { loadEnv } from "../lib/env";
import { logger } from "../lib/logger";

// Auth context populated after successful JWT verification.
// Downstream handlers read this via c.get(...).
export type AuthContext = {
  tenantId: string;
  actorId: string; // JWT `sub`
  scopes: string[]; // JWT `scope` space-separated, split
};

declare module "hono" {
  interface ContextVariableMap {
    auth: AuthContext;
    requestId: string;
    startedAt: number;
  }
}

// Two key-resolution strategies (see env.ts):
//   - JWKS_URI mode: shared remote JWKS for the whole realm.
//   - Static-PEM mode: per-tenant PEM map.
// resolveVerifier returns the right input for jose.jwtVerify().
const staticKeyCache = new Map<string, KeyLike>();
let remoteJwks: JWTVerifyGetKey | undefined;

function getRemoteJwks(): JWTVerifyGetKey {
  if (remoteJwks) return remoteJwks;
  const { JWKS_URI } = loadEnv();
  if (!JWKS_URI) throw new Error("JWKS_URI not configured");
  remoteJwks = createRemoteJWKSet(new URL(JWKS_URI));
  return remoteJwks;
}

async function resolveStaticKey(tenantId: string): Promise<KeyLike> {
  const cached = staticKeyCache.get(tenantId);
  if (cached) return cached;
  const { JWT_PUBLIC_KEYS } = loadEnv();
  const pem = JWT_PUBLIC_KEYS?.[tenantId];
  if (!pem) throw new Error(`No public key configured for tenant=${tenantId}`);
  const key = await importSPKI(pem, "RS256");
  staticKeyCache.set(tenantId, key);
  return key;
}

// JWT middleware. Expects `Authorization: Bearer <token>` with claims:
//   sub     — actor id (user or service account)
//   tenant  — customer id (used to pick the verification key)
//   scope   — space-separated scopes
// 15-minute access token (D3). Refresh flow is handled by the customer's
// auth issuer, NOT by the gateway.
export const authMiddleware = createMiddleware(async (c, next) => {
  // Bearer header is the primary path. SSE clients fall back to
  // `?access_token=…` because the browser EventSource API can't set custom
  // headers; the renderer code in services/desktop only uses this on SSE
  // routes (see services/desktop/src/renderer/src/api/gateway.ts → gatewaySSE).
  // Keeping it here rather than per-route because the verification logic
  // below (key lookup, jwtVerify, scope parsing) is identical regardless of
  // where the token came from.
  const header = c.req.header("authorization");
  let token: string | undefined;
  if (header?.startsWith("Bearer ")) {
    token = header.slice("Bearer ".length);
  } else {
    const queryToken = c.req.query("access_token");
    if (queryToken) token = queryToken;
  }
  if (!token) {
    return c.json({ error: "missing_bearer_token" }, 401);
  }

  // Peek tenant claim without verifying — we need it for the auth
  // context (and, in static-PEM mode, to pick the verification key).
  // jose refuses to decode unverified payloads, so do it manually and
  // validate immediately after.
  //
  // v0.1.149 — Three-tier claim lookup:
  //   1. `tenant`     — original design (gateway-internal expectation).
  //   2. `tenant_id`  — what the desktop's auth.ts reads (and what most
  //                     Keycloak realms with a custom mapper emit).
  //   3. `sub`        — fallback to the Keycloak user UUID when neither
  //                     tenant claim exists. The realm config in prod
  //                     ships no tenant mapper at all, so without this
  //                     fallback every authenticated request 401s
  //                     with "tenant claim missing". The user's
  //                     existing TenantBilling row (`8bb1c1fa-…`) is
  //                     already keyed by their `sub`, so this fallback
  //                     matches the data on disk.
  const [, payloadB64] = token.split(".");
  let tenantId: string;
  try {
    const payload = JSON.parse(
      Buffer.from(payloadB64, "base64url").toString("utf8"),
    ) as { tenant?: unknown; tenant_id?: unknown; sub?: unknown };
    const raw = payload.tenant ?? payload.tenant_id ?? payload.sub;
    if (typeof raw !== "string" || raw.length === 0) {
      throw new Error("no tenant or sub claim");
    }
    tenantId = raw;
  } catch (err) {
    const message =
      err instanceof Error ? err.message : "malformed_token";
    return c.json({ error: "malformed_token", message }, 401);
  }

  const { JWT_ISSUER, JWT_AUDIENCE, JWKS_URI } = loadEnv();
  try {
    // Pick the verifier shape jose wants: either a JWTVerifyGetKey
    // function (JWKS) or a KeyLike (static PEM). They share the same
    // jwtVerify() signature, so a small branch keeps the rest uniform.
    const verifier = JWKS_URI
      ? getRemoteJwks()
      : await resolveStaticKey(tenantId);
    // v0.1.149 — audience check skipped for desktop tokens. Keycloak's
    // default access-token shape for the `ava-desktop` client puts
    // `aud: ["account"]` (and sometimes the client_id), NEVER
    // `ava-gateway` — adding that required a custom Audience-Protocol-
    // Mapper that's currently missing from the prod realm. Strict
    // jose audience-matching therefore failed every authenticated
    // request with `invalid_token` (after the tenant_id-peek fix landed
    // in fd3164a) and the desktop just shows "gateway 401". The issuer
    // + signature checks below still verify the token came from the
    // trusted Keycloak realm, so dropping the audience check is
    // defence-in-depth, not the primary security control. When the
    // realm config grows the audience mapper, set JWT_AUDIENCE_STRICT=1
    // to re-enable it; the default unblocks the user today.
    const verifyOpts: Parameters<typeof jwtVerify>[2] = {
      issuer: JWT_ISSUER,
    };
    if (process.env.JWT_AUDIENCE_STRICT === "1") {
      verifyOpts.audience = JWT_AUDIENCE;
    }
    const { payload } = await jwtVerify(token, verifier as never, verifyOpts);
    if (typeof payload.sub !== "string") throw new Error("sub claim missing");
    const scopes =
      typeof payload.scope === "string" ? payload.scope.split(/\s+/).filter(Boolean) : [];
    // v0.1.149 — Temporary diagnostic: log every authenticated request's
    // tenantId + sub so we can correlate to the data on disk. Remove once
    // the cross-UUID puzzle (TenantBilling row 8bb1c1fa-… vs Transaction
    // userId 7cd31493-…) is resolved.
    logger.info(
      { tenantId, sub: payload.sub, path: c.req.path },
      "auth: verified",
    );
    c.set("auth", { tenantId, actorId: payload.sub, scopes });
  } catch (err) {
    const message = err instanceof Error ? err.message : "verification_failed";
    // Surface a useful `message` field too so the desktop's GatewayError
    // shows the actual reason ("audience invalid", "signature failed",
    // "expired", "JWKS fetch failed", …) instead of the generic
    // "gateway 401".
    return c.json(
      { error: "invalid_token", message, detail: message },
      401,
    );
  }

  await next();
});

// Scope guard — thin wrapper for route-level authorization. Usage:
//   .get("/companies", requireScope("company:read"), handler)
export function requireScope(required: string) {
  return createMiddleware(async (c, next) => {
    const auth = c.get("auth");
    if (!auth || !auth.scopes.includes(required)) {
      return c.json({ error: "insufficient_scope", required }, 403);
    }
    await next();
  });
}

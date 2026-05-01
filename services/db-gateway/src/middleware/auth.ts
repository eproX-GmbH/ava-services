import { createMiddleware } from "hono/factory";
import {
  jwtVerify,
  importSPKI,
  createRemoteJWKSet,
  type KeyLike,
  type JWTVerifyGetKey,
} from "jose";
import { loadEnv } from "../lib/env";

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
  const [, payloadB64] = token.split(".");
  let tenantId: string;
  try {
    const payload = JSON.parse(
      Buffer.from(payloadB64, "base64url").toString("utf8"),
    ) as { tenant?: unknown };
    if (typeof payload.tenant !== "string") throw new Error("tenant claim missing");
    tenantId = payload.tenant;
  } catch {
    return c.json({ error: "malformed_token" }, 401);
  }

  const { JWT_ISSUER, JWT_AUDIENCE, JWKS_URI } = loadEnv();
  try {
    // Pick the verifier shape jose wants: either a JWTVerifyGetKey
    // function (JWKS) or a KeyLike (static PEM). They share the same
    // jwtVerify() signature, so a small branch keeps the rest uniform.
    const verifier = JWKS_URI
      ? getRemoteJwks()
      : await resolveStaticKey(tenantId);
    const { payload } = await jwtVerify(token, verifier as never, {
      issuer: JWT_ISSUER,
      audience: JWT_AUDIENCE,
    });
    if (typeof payload.sub !== "string") throw new Error("sub claim missing");
    const scopes =
      typeof payload.scope === "string" ? payload.scope.split(/\s+/).filter(Boolean) : [];
    c.set("auth", { tenantId, actorId: payload.sub, scopes });
  } catch (err) {
    const message = err instanceof Error ? err.message : "verification_failed";
    return c.json({ error: "invalid_token", detail: message }, 401);
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

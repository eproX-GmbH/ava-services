// Q-track v0.1.137 — HMAC middleware for the gateway's `/internal/*`
// surface.
//
// The gateway and master-data exchange quota/park-state messages over a
// shared HMAC-signed channel that lives outside the JWT-auth chain (the
// peer is a service, not a user). Header format:
//
//   X-Internal-Signature: <hex(hmac-sha256(secret, body))>
//
// The body is read once via `c.req.text()`, verified, and cached on the
// context so the downstream handler can re-parse it without consuming
// the stream a second time. Constant-time comparison guards against
// timing oracles.
//
// Fails closed: when `INTERNAL_HMAC_SECRET` isn't configured, every
// `/internal/*` request returns 503. This is the deliberate
// dev-without-peer mode — the gateway boots fine, but the internal
// surface is offline until the operator sets the secret.

import { createMiddleware } from "hono/factory";
import { createHmac, timingSafeEqual } from "node:crypto";
import { loadEnv } from "../lib/env";
import { logger } from "../lib/logger";

declare module "hono" {
  interface ContextVariableMap {
    /** Raw request body, captured by `internalAuthMiddleware` so
     *  handlers can re-parse without consuming the stream twice. */
    internalRawBody: string;
  }
}

export const internalAuthMiddleware = createMiddleware(async (c, next) => {
  const { INTERNAL_HMAC_SECRET } = loadEnv();
  if (!INTERNAL_HMAC_SECRET) {
    return c.json({ error: "internal_hmac_secret_not_configured" }, 503);
  }
  const sig = c.req.header("x-internal-signature");
  if (!sig) {
    return c.json({ error: "missing_signature" }, 401);
  }
  const raw = await c.req.text();
  const expected = createHmac("sha256", INTERNAL_HMAC_SECRET)
    .update(raw, "utf8")
    .digest();
  let provided: Buffer;
  try {
    provided = Buffer.from(sig, "hex");
  } catch {
    return c.json({ error: "bad_signature_encoding" }, 401);
  }
  if (provided.length !== expected.length || !timingSafeEqual(provided, expected)) {
    logger.warn({ path: c.req.path }, "internal-auth: invalid signature");
    return c.json({ error: "invalid_signature" }, 401);
  }
  c.set("internalRawBody", raw);
  await next();
});

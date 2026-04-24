import { createMiddleware } from "hono/factory";
import { loadEnv } from "../lib/env";

// In-memory sliding-window rate limiter. Keyed by tenantId from the
// authenticated context, so it MUST run after authMiddleware. Per D3 we
// accept the in-memory limitation for now (single instance per customer on
// fly.io); swap to Redis once we scale past that.

type Bucket = { count: number; windowStart: number };
const buckets = new Map<string, Bucket>();
const WINDOW_MS = 60_000;

export const rateLimitMiddleware = createMiddleware(async (c, next) => {
  const auth = c.get("auth");
  if (!auth) {
    // auth middleware should run first; fail closed if it didn't
    return c.json({ error: "rate_limit_requires_auth" }, 500);
  }
  const { RATE_LIMIT_PER_MIN } = loadEnv();
  const key = auth.tenantId;
  const now = Date.now();
  const bucket = buckets.get(key);
  if (!bucket || now - bucket.windowStart >= WINDOW_MS) {
    buckets.set(key, { count: 1, windowStart: now });
  } else {
    bucket.count++;
    if (bucket.count > RATE_LIMIT_PER_MIN) {
      const retryAfter = Math.ceil((WINDOW_MS - (now - bucket.windowStart)) / 1000);
      c.header("Retry-After", String(retryAfter));
      return c.json(
        { error: "rate_limited", limit: RATE_LIMIT_PER_MIN, retryAfterSeconds: retryAfter },
        429,
      );
    }
  }
  await next();
});

// In-Memory per-IP rate limit for the registration endpoint.
//
// Cheap, deliberately not Redis: we accept that on a multi-instance
// deploy each pod tracks its own counts. The downside is "5 per hour
// per pod" instead of "5 per hour per cluster" — for self-serve
// registration that's fine, an attacker would have to coordinate
// across all backends to evade it. If we ever scale past a couple of
// pods, swap this for a Redis-backed counter.
//
// Sliding window: not a true sliding window, but a per-hour bucket
// that resets at the top of each request's `resetAt`. Good enough
// for abuse-prevention granularity.

const WINDOW_MS = 60 * 60 * 1000; // 1 hour
const MAX_PER_WINDOW = 5;

interface Bucket {
  count: number;
  /** Unix-ms when this IP's counter resets to zero. */
  resetAt: number;
}

const buckets = new Map<string, Bucket>();

export interface RateLimitDecision {
  allowed: boolean;
  /** Seconds until the IP can try again. Only meaningful when allowed === false. */
  retryAfterSeconds: number;
}

/** Increments the count for `ip`. Returns whether the request is
 *  allowed. Call this AFTER input validation but BEFORE any
 *  external call (Keycloak admin), so a malformed payload doesn't
 *  burn an attempt. */
export function takeRegistrationSlot(ip: string): RateLimitDecision {
  const now = Date.now();
  const existing = buckets.get(ip);
  if (!existing || existing.resetAt <= now) {
    buckets.set(ip, { count: 1, resetAt: now + WINDOW_MS });
    return { allowed: true, retryAfterSeconds: 0 };
  }
  if (existing.count >= MAX_PER_WINDOW) {
    return {
      allowed: false,
      retryAfterSeconds: Math.max(
        1,
        Math.ceil((existing.resetAt - now) / 1000),
      ),
    };
  }
  existing.count += 1;
  return { allowed: true, retryAfterSeconds: 0 };
}

/** Test-only: clear the bucket map. */
export function _resetRateLimitForTests(): void {
  buckets.clear();
}

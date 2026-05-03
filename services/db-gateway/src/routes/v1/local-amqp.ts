import { OpenAPIHono } from "@hono/zod-openapi";
import { loadEnv } from "../../lib/env";

const env = loadEnv();

// §local-amqp — Bearer-gated CloudAMQP credential handout for the
// desktop's local producer subprocesses (Phase 8.v1.3).
//
// AVA's Plan-B architecture (see desktop/AGENT_PLAN.md §8.v) runs
// per-tenant producer Node services on the user's machine. They
// need an AMQP connection to the shared CloudAMQP broker so the
// gateway can dispatch transaction events to them and they can
// publish results back. The desktop must NOT carry the broker URL
// in plaintext (it would survive `unzip AVA.dmg`); instead the
// desktop calls this endpoint after an authenticated login and
// caches the URL via Electron's safeStorage (Keychain/DPAPI).
//
// v1 returns the SAME admin URL the gateway itself uses
// (`EVENT_BUS_URL`). On free-tier CloudAMQP there's only one vhost,
// so per-tenant isolation via the Mgmt API would mean creating
// per-tenant USERS with topic-pattern permissions — meaningful but
// non-trivial and not strictly required for a single-tenant pilot.
// 8.v1.4+ will swap this stub for the Mgmt-API-driven flow:
//
//   1. Read tenant from JWT
//   2. PUT /api/users/tenant-<id>-<rand>?password=<rand> tags="amqp"
//   3. PUT /api/permissions/<vhost>/<user> with read/write regexes
//      scoped to `tenant.<id>.*` routing keys
//   4. Return the scoped URL with TTL
//
// Until then this endpoint is auth-gated (Bearer JWT, any scope) so
// only authenticated tenants can fetch the URL. It still leaks the
// admin credential to a compromised desktop, which is acceptable
// for a closed pilot but logged here as a known limitation.

export const localAmqpRouter = new OpenAPIHono();

localAmqpRouter.get("/local-amqp-url", (c) => {
  const auth = c.get("auth");
  if (!auth || !auth.actorId) {
    return c.json({ error: "unauthenticated" }, 401);
  }
  return c.json({
    amqpUrl: env.EVENT_BUS_URL,
    // Hint to clients: re-fetch within this window. We don't enforce
    // it server-side yet; once we move to per-tenant credentials in
    // 8.v1.4 the TTL becomes meaningful (CloudAMQP user lifetime).
    expiresAt: new Date(Date.now() + 24 * 60 * 60 * 1000).toISOString(),
    // Surface the limitation to clients/operators reading the
    // response so nobody mistakes this for proper tenant isolation.
    isolation: "shared-vhost-pilot",
  });
});

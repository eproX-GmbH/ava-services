import { OpenAPIHono } from "@hono/zod-openapi";
import { loadEnv } from "../../lib/env";

const env = loadEnv();

// §local-credentials — Bearer-gated handout of broker + per-producer
// database URLs the desktop's ProducerSupervisor injects into spawned
// local producer Node subprocesses (Phase 8.v1.3 + 8.v1.5).
//
// Architecture (D5/D6 + clarified 8.v1.5):
//
//   - Cloud-side: shared CloudAMQP broker, fly-managed Postgres
//     cluster with one DB per producer service.
//   - Local-side: per-tenant producer Node subprocesses on the
//     user's device. They are pure compute workers — connect
//     outbound to the cloud broker for events and to the cloud DB
//     for state. No local persistence.
//
// The desktop never bakes these URLs into the .dmg/.exe (a
// signed/notarised bundle survives `unzip` and would leak admin
// creds). Instead it pulls them after an authenticated login and
// caches via Electron's safeStorage (Keychain/DPAPI).
//
// v1 returns the SAME admin URLs the gateway itself uses. On
// free-tier CloudAMQP and the shared MPG cluster there's no
// per-tenant isolation; per-user CloudAMQP users + per-tenant DB
// schemas land in 8.v1.4+ once the pilot validates the routing.
// Auth-gating via Bearer JWT is the floor of "compromised desktop"
// blast-radius.

export const localAmqpRouter = new OpenAPIHono();

// Per-producer database name on the fly MPG cluster. Mirrors the
// PRODUCER_REGISTRY in services/desktop/src/main/index.ts. When a
// new producer is added there, mirror it here.
const PRODUCER_DATABASE_NAMES: Record<string, string> = {
  "company-profile": "ava_company_profile",
  "structured-content": "ava_structured_content",
  "company-publication": "ava_company_publication",
  "company-evaluation": "ava_company_evaluation",
  "company-contact": "ava_company_contact",
};

/**
 * Build per-producer DATABASE_URLs from the gateway's own
 * DATABASE_URL secret. The MPG cluster + auth + host are shared;
 * only the database segment differs.
 */
function buildProducerDatabaseUrls(): Record<string, string> {
  const gatewayUrl = env.DATABASE_URL;
  // Replace the path segment (database name) with each producer's name.
  // Falls back to URL parsing so query parameters survive.
  let parsed: URL;
  try {
    parsed = new URL(gatewayUrl);
  } catch {
    return {};
  }
  const result: Record<string, string> = {};
  for (const [producer, dbName] of Object.entries(PRODUCER_DATABASE_NAMES)) {
    parsed.pathname = `/${dbName}`;
    result[producer] = parsed.toString();
  }
  return result;
}

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

/**
 * Combined local-producer credentials handout (8.v1.5).
 *
 * Returns:
 *   - amqpUrl:        same as /v1/local-amqp-url (deprecation pending)
 *   - databaseUrls:   { producer-name: postgres-url }
 *   - jwksUri:        Keycloak JWKS endpoint
 *   - expiresAt:      ISO timestamp; clients refresh within this window
 *
 * The desktop fetches this once on auth and re-fetches on the
 * supervisor's next start cycle. Tenant-scoping is a no-op for the
 * pilot — every authenticated tenant gets the same URLs.
 */
localAmqpRouter.get("/local-credentials", (c) => {
  const auth = c.get("auth");
  if (!auth || !auth.actorId) {
    return c.json({ error: "unauthenticated" }, 401);
  }
  return c.json({
    amqpUrl: env.EVENT_BUS_URL,
    databaseUrls: buildProducerDatabaseUrls(),
    jwksUri: env.JWKS_URI,
    expiresAt: new Date(Date.now() + 24 * 60 * 60 * 1000).toISOString(),
    isolation: "shared-vhost-pilot",
  });
});

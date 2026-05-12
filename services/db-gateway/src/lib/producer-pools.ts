// Shared producer pg.Pool registry (§8.v3).
//
// The persist-bus and direct-MPG read routes both need a `pg.Pool`
// per producer database. Lazy-init on first access, cache for the
// process lifetime. Kept small intentionally — no SQL templating or
// anything fancy; consumers run their own raw queries.
//
// Each pool is sized small (max 2) to stay under Postgres'
// max_connections=100 cap. Math: 2 gateway instances × (6 producer
// pools + 1 gateway pool) × 2 = 28 connections worst case, leaves
// ~60 slots for the producer apps themselves, master-data, pgbouncer
// internal, and SUPERUSER reservations.
//
// Idle connections are reaped aggressively (5s) so a single
// burst from the retry-ticker doesn't keep slots warm for half a
// minute when the chat tool surfaces also need them.

import pg from "pg";
import { logger } from "./logger";
import { loadEnv } from "./env";
import { buildProducerDatabaseUrl, type ProducerName } from "./db-urls";

const pools = new Map<ProducerName, pg.Pool>();
let gatewayPool: pg.Pool | undefined;

export function getProducerPool(producer: ProducerName): pg.Pool {
  let pool = pools.get(producer);
  if (pool) return pool;
  const url = buildProducerDatabaseUrl(producer);
  if (!url) {
    throw new Error(`producer-pools: no DATABASE_URL for "${producer}"`);
  }
  pool = new pg.Pool({
    connectionString: url,
    max: 2,
    idleTimeoutMillis: 5_000,
  });
  pool.on("error", (err) =>
    logger.error({ err, producer }, "pg pool error"),
  );
  pools.set(producer, pool);
  return pool;
}

/**
 * Pool for the gateway's own audit database (DATABASE_URL). Hosts
 * the AuditLog table and (since §8.v3) the EntityProgress table that
 * the persist-bus writes per-company processing state into.
 *
 * Same lazy-init shape as `getProducerPool` — single shared pool,
 * sized small to stay under pgbouncer's per-vhost cap.
 */
export function getGatewayPool(): pg.Pool {
  if (gatewayPool) return gatewayPool;
  const env = loadEnv();
  gatewayPool = new pg.Pool({
    connectionString: env.DATABASE_URL,
    max: 2,
    idleTimeoutMillis: 5_000,
  });
  gatewayPool.on("error", (err) =>
    logger.error({ err, db: "gateway-audit" }, "pg pool error"),
  );
  return gatewayPool;
}

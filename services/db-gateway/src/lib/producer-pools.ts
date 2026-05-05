// Shared producer pg.Pool registry (§8.v3).
//
// The persist-bus and direct-MPG read routes both need a `pg.Pool`
// per producer database. Lazy-init on first access, cache for the
// process lifetime. Kept small intentionally — no SQL templating or
// anything fancy; consumers run their own raw queries.
//
// Each pool is sized small (max 4) to stay under the cluster's
// pgbouncer limit (~50 today, ~5 producers + gateway audit
// + ~headroom for parallel writes).

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
    max: 4,
    idleTimeoutMillis: 30_000,
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
    max: 4,
    idleTimeoutMillis: 30_000,
  });
  gatewayPool.on("error", (err) =>
    logger.error({ err, db: "gateway-audit" }, "pg pool error"),
  );
  return gatewayPool;
}

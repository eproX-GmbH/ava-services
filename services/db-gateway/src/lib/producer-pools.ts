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
import { buildProducerDatabaseUrl, type ProducerName } from "./db-urls";

const pools = new Map<ProducerName, pg.Pool>();

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

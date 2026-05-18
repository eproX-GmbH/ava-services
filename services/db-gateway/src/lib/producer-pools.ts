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
//
// v0.1.218 — Self-Healing. Vorher wurde der `error`-Event eines
// kaputten Pools nur geloggt; das gecachte Pool-Objekt blieb stehen.
// In Edge-Cases (Postgres-Failover, Idle-in-Transaction, pgbouncer-
// Reset) konnten nachfolgende Acquires gegen denselben kaputten Pool
// laufen, ohne dass node-postgres' interne Recovery anschlug. Jetzt
// zählen wir Errors innerhalb eines 60s-Fensters: 5+ Errors → Pool
// wird verworfen (`end()`) und beim nächsten Caller neu erzeugt.
// Verlorene In-Flight-Queries scheitern einmalig; der Caller bekommt
// danach einen frischen Pool und kann retryen.

import pg from "pg";
import { logger } from "./logger";
import { loadEnv } from "./env";
import { buildProducerDatabaseUrl, type ProducerName } from "./db-urls";

interface PoolEntry {
  pool: pg.Pool;
  /** Timestamps der letzten Pool-Errors (ms). Rolliert auf
   *  `ERROR_WINDOW_MS` zurück; sobald `ERROR_THRESHOLD` Einträge
   *  drin sind, wird der Pool recycelt. */
  errorTimestamps: number[];
}

const ERROR_WINDOW_MS = 60_000;
const ERROR_THRESHOLD = 5;

const producerPools = new Map<ProducerName, PoolEntry>();
let gatewayEntry: PoolEntry | undefined;

function createProducerPool(producer: ProducerName): pg.Pool {
  const url = buildProducerDatabaseUrl(producer);
  if (!url) {
    throw new Error(`producer-pools: no DATABASE_URL for "${producer}"`);
  }
  const pool = new pg.Pool({
    connectionString: url,
    max: 2,
    idleTimeoutMillis: 5_000,
  });
  pool.on("error", (err) => {
    logger.error({ err, producer }, "pg pool error");
    onProducerPoolError(producer);
  });
  return pool;
}

function createGatewayPool(): pg.Pool {
  const env = loadEnv();
  const pool = new pg.Pool({
    connectionString: env.DATABASE_URL,
    max: 2,
    idleTimeoutMillis: 5_000,
  });
  pool.on("error", (err) => {
    logger.error({ err, db: "gateway-audit" }, "pg pool error");
    onGatewayPoolError();
  });
  return pool;
}

function shouldRecycle(entry: PoolEntry): boolean {
  const now = Date.now();
  entry.errorTimestamps.push(now);
  // Window prunen.
  while (
    entry.errorTimestamps.length > 0 &&
    now - (entry.errorTimestamps[0] ?? 0) > ERROR_WINDOW_MS
  ) {
    entry.errorTimestamps.shift();
  }
  return entry.errorTimestamps.length >= ERROR_THRESHOLD;
}

function onProducerPoolError(producer: ProducerName): void {
  const entry = producerPools.get(producer);
  if (!entry) return;
  if (!shouldRecycle(entry)) return;
  logger.warn(
    { producer, errorCount: entry.errorTimestamps.length },
    `producer-pools: ${producer} hit ${ERROR_THRESHOLD} errors in <${ERROR_WINDOW_MS / 1000}s — recycling pool`,
  );
  // Cache-Eintrag entfernen, BEVOR wir end() rufen — sonst kann
  // ein Race zwischen end() und einem konkurrenten Acquire auf
  // demselben kaputten Pool landen.
  producerPools.delete(producer);
  void entry.pool.end().catch((err) => {
    logger.warn(
      { err, producer },
      "producer-pools: pool.end() during recycle failed (non-fatal)",
    );
  });
}

function onGatewayPoolError(): void {
  if (!gatewayEntry) return;
  if (!shouldRecycle(gatewayEntry)) return;
  logger.warn(
    { errorCount: gatewayEntry.errorTimestamps.length },
    `producer-pools: gateway-audit hit ${ERROR_THRESHOLD} errors in <${ERROR_WINDOW_MS / 1000}s — recycling pool`,
  );
  const stale = gatewayEntry;
  gatewayEntry = undefined;
  void stale.pool.end().catch((err) => {
    logger.warn(
      { err },
      "producer-pools: gateway pool.end() during recycle failed (non-fatal)",
    );
  });
}

export function getProducerPool(producer: ProducerName): pg.Pool {
  let entry = producerPools.get(producer);
  if (entry) return entry.pool;
  const pool = createProducerPool(producer);
  entry = { pool, errorTimestamps: [] };
  producerPools.set(producer, entry);
  return pool;
}

/**
 * Pool for the gateway's own audit database (DATABASE_URL). Hosts
 * the AuditLog table and (since §8.v3) the EntityProgress table that
 * the persist-bus writes per-company processing state into.
 *
 * Same lazy-init shape as `getProducerPool` — single shared pool,
 * sized small to stay under pgbouncer's per-vhost cap. Same self-
 * healing recycling as the producer pools (v0.1.218).
 */
export function getGatewayPool(): pg.Pool {
  if (gatewayEntry) return gatewayEntry.pool;
  const pool = createGatewayPool();
  gatewayEntry = { pool, errorTimestamps: [] };
  return pool;
}

// ---- Diagnostics ----------------------------------------------------------

/**
 * Sicht auf den internen Zustand für Health-Endpoints / Tests. Gibt
 * die Anzahl Pools und die letzten Error-Timestamps zurück. Wird
 * (noch) von keinem Caller importiert; existiert für künftige
 * `/v1/health`-Erweiterungen.
 */
export function poolDiagnostics(): {
  producers: Array<{ producer: ProducerName; recentErrors: number }>;
  gateway: { recentErrors: number } | null;
} {
  return {
    producers: Array.from(producerPools.entries()).map(([producer, entry]) => ({
      producer,
      recentErrors: entry.errorTimestamps.length,
    })),
    gateway: gatewayEntry
      ? { recentErrors: gatewayEntry.errorTimestamps.length }
      : null,
  };
}

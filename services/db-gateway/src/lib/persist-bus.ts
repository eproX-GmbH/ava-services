// §8.v3 — gateway persist consolidation (Option D scoped).
//
// Under Option D (BYO-key passthrough — see AGENT_PLAN), only the
// network-sensitive scrapers are localized: `structured-content`
// (Handelsregister) and `company-publication` (Bundesanzeiger).
// Their fly apps are decommissioned, so the gateway is the only
// remaining home for their SQL upserts.
//
// The other three producers (`company-profile`, `company-contact`,
// `company-evaluation`) stay on fly in legacy mode with the user's
// API key passed through via the work-event payload, so they keep
// writing to MPG directly via their own prisma clients — the
// gateway has no persist consumer for them.
//
// Each consumer here subscribes to its producer's
// `tenant.persist.<producer>.v1` event family and applies the row
// via raw SQL with last-write-wins (`ON CONFLICT DO UPDATE WHERE
// EXCLUDED.updatedAt > existing.updatedAt`).
//
// Why this design:
//   - One service to deploy/operate instead of five fly producer apps.
//   - Already always-on (`min_machines_running = 1`) and already on
//     the bus for `transaction.progress` — adding more bindings is
//     near-free.
//   - Per-producer pg.Pool lives in this process; no prisma clients,
//     no generated code, no schema duplication. Migrations stay in
//     each producer's repo (run via `prisma migrate deploy` from CI).
//
// Idempotency: persist events carry `runId` (transactionId × subject)
// and `computedAt`. The SQL upsert's last-write-wins clause means
// duplicate deliveries are no-ops. Cutover-safe to run alongside the
// legacy fly persist-worker temporarily — both consumers can be bound
// to the same routing key (different queue names) and the second
// write detects a stale timestamp and skips.
//
// Schema knowledge: each handler hand-writes its INSERT/UPDATE
// statement against its producer's table. The first one
// (company-profile) mirrors the working SQL from
// company-profile/src/application/integration-events/v1/persist-worker.ts.
// The remaining four are stubbed until the schemas are surveyed in §8.v3.2.

import { AMQPClient, type CloudEvent, type AMQPListenerMeta } from "@ava/event";
import pg from "pg";

import { loadEnv } from "./env";
import { logger } from "./logger";
import {
  PRODUCER_NAMES,
  type ProducerName,
  buildProducerDatabaseUrl,
} from "./db-urls";

/** Persist-event payload contract — emitted by local compute-workers. */
export interface PersistEvent<TResult = unknown> {
  runId: string;
  tenantId: string;
  dispatchedAt: string;
  computedAt: string;
  result: TResult;
}

type ApplyFn = (
  pool: pg.Pool,
  event: CloudEvent<PersistEvent<unknown>>,
  log: typeof logger,
) => Promise<void>;

interface ProducerBinding {
  producer: ProducerName;
  /** Topic-exchange routing key the queue binds on. */
  routingKey: string;
  /** Queue name. Distinct from any fly persist-worker queue so both
   *  can coexist during cutover (each queue gets its own copy from
   *  the topic exchange). */
  queue: string;
  apply: ApplyFn;
}

// ---- Per-producer apply functions ------------------------------------------

/** Stub — schema + write logic land alongside each scraper's Playwright
 *  migration (see todos: structured-content / company-publication). */
const stubApply: (producer: ProducerName) => ApplyFn = (producer) =>
  async (_pool, _event, log) => {
    log.warn(
      { producer },
      `${producer} persist handler not yet implemented; event dropped on the floor`,
    );
  };

// ---- Bindings registry ------------------------------------------------------
//
// Only the localized scrapers bind here. The other 3 producers run
// in legacy mode on fly with user-key passthrough and persist via
// their own prisma clients — they don't emit persist events.

const BINDINGS: ProducerBinding[] = [
  {
    producer: "structured-content",
    routingKey: "tenant.persist.structured-content.v1",
    queue: "db-gateway-persist-structured-content",
    apply: stubApply("structured-content"),
  },
  {
    producer: "company-publication",
    routingKey: "tenant.persist.company-publication.v1",
    queue: "db-gateway-persist-company-publication",
    apply: stubApply("company-publication"),
  },
];

// Sanity: every binding's producer is a known name. (The reverse —
// every producer covered — no longer holds since 3 of them run on
// fly in legacy mode and never emit persist events.)
for (const b of BINDINGS) {
  if (!(PRODUCER_NAMES as readonly string[]).includes(b.producer)) {
    throw new Error(`persist-bus: unknown producer "${b.producer}"`);
  }
}

// ---- Bus ------------------------------------------------------------------

class PersistBus {
  private connecting?: Promise<void>;
  private clients: AMQPClient[] = [];
  private pools = new Map<ProducerName, pg.Pool>();

  /** Idempotent. Connects + binds + subscribes all producer queues. */
  public async ensureConnected(): Promise<void> {
    if (this.connecting) return this.connecting;
    if (this.clients.length > 0) return;

    this.connecting = (async () => {
      const env = loadEnv();
      for (const binding of BINDINGS) {
        const client = new AMQPClient(binding.queue);
        await client.connect(env.EVENT_BUS_URL);
        await client.assertExchange(env.EVENT_BUS_EXCHANGE);
        await client.assertQueue(binding.queue);
        await client.bindQueue(
          env.EVENT_BUS_EXCHANGE,
          binding.routingKey,
          binding.queue,
        );

        // Get a typed listener. The @ava/event helper expects a
        // {context, operation} pair from the EventType enums; the
        // persist family uses a flat string topic and isn't enumerated
        // there, so cast through never. The broker filters by routing
        // key regardless.
        const listener = client.getListener<PersistEvent<unknown>>({
          context: "tenant" as never,
          operation: binding.routingKey as never,
        });

        listener.subscribe(
          async (
            event: CloudEvent<PersistEvent<unknown>>,
            ack: () => void,
            // eslint-disable-next-line @typescript-eslint/no-unused-vars
            _meta?: AMQPListenerMeta,
          ) => {
          const log = logger.child({
            producer: binding.producer,
            runId: event.data?.runId ?? event.id ?? "<no-id>",
          });
          try {
            const pool = this.getPool(binding.producer);
            await binding.apply(pool, event, log);
          } catch (err) {
            log.error({ err }, "persist handler failed");
            // Swallow + ack: with last-write-wins this is idempotent,
            // and a redelivery loop on a poisoned event would block
            // the queue. Ops can replay from the work queue if a
            // persist needs re-running.
          } finally {
            ack();
          }
          },
        );

        this.clients.push(client);
        logger.info(
          { producer: binding.producer, queue: binding.queue },
          "persist-bus subscribed",
        );
      }
    })();

    try {
      await this.connecting;
    } finally {
      this.connecting = undefined;
    }
  }

  private getPool(producer: ProducerName): pg.Pool {
    let pool = this.pools.get(producer);
    if (!pool) {
      const url = buildProducerDatabaseUrl(producer);
      if (!url) {
        throw new Error(
          `persist-bus: cannot derive DATABASE_URL for "${producer}"`,
        );
      }
      pool = new pg.Pool({
        connectionString: url,
        max: 4, // budget against pgbouncer cap (see db-urls.ts)
        idleTimeoutMillis: 30_000,
      });
      pool.on("error", (err) =>
        logger.error({ err, producer }, "pg pool error"),
      );
      this.pools.set(producer, pool);
    }
    return pool;
  }
}

export const persistBus = new PersistBus();

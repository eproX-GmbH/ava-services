// §8.v3 — gateway persist consolidation.
//
// After the §8.v3 pivot-2 (see AGENT_PLAN.md): every producer
// except `website` is localized. The cloud db-gateway is the
// single persist service for all five — it subscribes to each
// producer's `tenant.persist.<producer>.v1` event family and
// applies rows to MPG via raw SQL with last-write-wins
// (`ON CONFLICT DO UPDATE WHERE EXCLUDED.updatedAt > existing.updatedAt`).
//
// `website` keeps its own prisma client and writes directly
// because it stays on fly (uses operator-paid valueserp).
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
import type pg from "pg";

import { loadEnv } from "./env";
import { logger } from "./logger";
import { PRODUCER_NAMES, type ProducerName } from "./db-urls";
import { getProducerPool } from "./producer-pools";

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

/**
 * `tenant.persist.company-profile.v1` payload shape — emitted by the
 * local company-profile compute-worker. Mirrors the legacy
 * `companyProfilesRepository.upsert` shape.
 */
interface CompanyProfileResult {
  companyId: string;
  profile: string;
  url: string;
  businessPurpose?: string;
}

/** Apply a company-profile persist event with last-write-wins. */
const applyCompanyProfile: ApplyFn = async (pool, event, log) => {
  const data = event.data as PersistEvent<CompanyProfileResult> | undefined;
  if (!data) throw new Error("empty payload");
  const { result, computedAt, tenantId, runId } = data;
  if (!result?.companyId) throw new Error("missing result.companyId");
  if (!computedAt) throw new Error("missing computedAt");

  const res = await pool.query(
    `INSERT INTO "CompanyProfile" (id, profile, url, "updatedAt")
     VALUES ($1, $2, $3, $4)
     ON CONFLICT (id) DO UPDATE
     SET profile = EXCLUDED.profile,
         url = EXCLUDED.url,
         "updatedAt" = EXCLUDED."updatedAt"
     WHERE EXCLUDED."updatedAt" > "CompanyProfile"."updatedAt"`,
    [result.companyId, result.profile, result.url, new Date(computedAt)],
  );
  log.info(
    {
      runId,
      tenantId,
      companyId: result.companyId,
      rowCount: res.rowCount,
    },
    res.rowCount === 0
      ? "company-profile persist skipped (existing row newer)"
      : "company-profile persist ✓",
  );
};

/** Stub — schema + write logic land alongside each producer's
 *  localization. See todos: structured-content / company-publication
 *  / company-evaluation / company-contact. */
const stubApply: (producer: ProducerName) => ApplyFn = (producer) =>
  async (_pool, _event, log) => {
    log.warn(
      { producer },
      `${producer} persist handler not yet implemented; event dropped on the floor`,
    );
  };

// ---- Bindings registry ------------------------------------------------------
//
// Each binding is the persist seam for one local producer. `website`
// is absent — it stays on fly with its own prisma client.
//
// Stubs warn-and-drop until the producer's localization lands. They
// stay safe because no compute-worker emits the routing key until the
// producer is registered in the desktop's PRODUCER_REGISTRY.

const BINDINGS: ProducerBinding[] = [
  {
    producer: "company-profile",
    routingKey: "tenant.persist.company-profile.v1",
    queue: "db-gateway-persist-company-profile",
    apply: applyCompanyProfile,
  },
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
  {
    producer: "company-evaluation",
    routingKey: "tenant.persist.company-evaluation.v1",
    queue: "db-gateway-persist-company-evaluation",
    apply: stubApply("company-evaluation"),
  },
  {
    producer: "company-contact",
    routingKey: "tenant.persist.company-contact.v1",
    queue: "db-gateway-persist-company-contact",
    apply: stubApply("company-contact"),
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
    return getProducerPool(producer);
  }
}

export const persistBus = new PersistBus();

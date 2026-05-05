// §8.v3 — gateway persist consolidation.
//
// After the §8.v3 pivot-2 (see AGENT_PLAN.md): every producer
// except `website` is localized. The cloud db-gateway is the
// single persist service for all five — it subscribes to each
// producer's `tenant.persist.<producer>.v1` event family and
// applies rows to MPG via raw SQL with last-write-wins
// (`ON CONFLICT DO UPDATE WHERE EXCLUDED.updatedAt > existing.updatedAt`).
//
// `website` is also localized as of §8.v3 — its valueserp call
// goes through the gateway proxy (/v1/proxy/valueserp) so the
// operator's API key stays server-side, and the upsert lands here
// like every other producer.
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
import { getProducerPool, getGatewayPool } from "./producer-pools";

/**
 * Side-effect of every persist event: record per-company processing
 * state in the gateway's audit DB. The chat agent's `import_status`
 * tool reads this back via `/v1/transactions/:id/entities`. See
 * §8.v3 entity-progress note in the schema.
 *
 * Best-effort. If the gateway's own DB is briefly unreachable we
 * still ack the persist event — losing one progress row beats
 * blocking the persist pipeline. The upstream consumer can re-fetch
 * the row state from a future event if it needs to.
 */
async function recordEntityProgress(
  producer: ProducerName,
  transactionId: string,
  companyId: string,
  state: "completed" | "failed" | "skipped",
  errorMessage: string | null,
  log: typeof logger,
): Promise<void> {
  if (!transactionId || !companyId) {
    log.debug(
      { producer, transactionId, companyId, state },
      "skipping entity-progress write (missing tx or company id)",
    );
    return;
  }
  const truncated = errorMessage ? errorMessage.slice(0, 500) : null;
  try {
    const pool = getGatewayPool();
    await pool.query(
      `INSERT INTO "EntityProgress"
         ("transactionId", "companyId", producer, state, "errorMessage",
          "updatedAt", "createdAt")
       VALUES ($1, $2, $3, $4, $5, NOW(), NOW())
       ON CONFLICT ("transactionId", "companyId", producer) DO UPDATE
       SET state = EXCLUDED.state,
           "errorMessage" = EXCLUDED."errorMessage",
           "updatedAt" = EXCLUDED."updatedAt"
       WHERE EXCLUDED."updatedAt" > "EntityProgress"."updatedAt"`,
      [transactionId, companyId, producer, state, truncated],
    );
  } catch (err) {
    // Don't propagate — best-effort.
    log.warn(
      {
        err: err instanceof Error ? err.message : String(err),
        producer,
        transactionId,
        companyId,
      },
      "entity-progress write failed",
    );
  }
}

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

/** `tenant.persist.structured-content.v1` payload — emitted by the
 *  local structured-content compute-worker. Mirrors the legacy
 *  `structuredContentsRepository.upsert` shape plus a normalized
 *  managingDirectors child list. */
interface StructuredContentResult {
  companyId: string;
  name: string;
  legalForm: string;
  street: string;
  houseNumber: string;
  zipCode: string;
  city: string;
  foundingYear?: number | null;
  corporatePurpose?: string | null;
  shareCapital?: number | null;
  lastRegisterEntry?: string | null;
  lastRegisterModification?: string | null;
  managingDirectors: Array<{
    firstName: string;
    lastName: string;
    birthDay?: string | null;
    city?: string | null;
  }>;
}

/**
 * Apply a structured-content persist event with last-write-wins on
 * the parent row + replace-all on the managingDirectors children.
 *
 * The two tables are kept in sync inside a single transaction so a
 * partial failure can't leave the parent newer than its children.
 * If the parent row is older than the existing one (someone else
 * persisted a fresher copy first) we skip the children replace too.
 */
const applyStructuredContent: ApplyFn = async (pool, event, log) => {
  const data = event.data as
    | PersistEvent<StructuredContentResult>
    | undefined;
  if (!data) throw new Error("empty payload");
  const { result, computedAt, tenantId, runId } = data;
  if (!result?.companyId) throw new Error("missing result.companyId");
  if (!computedAt) throw new Error("missing computedAt");

  const updatedAt = new Date(computedAt);

  const client = await pool.connect();
  try {
    await client.query("BEGIN");

    const upsertRes = await client.query(
      `INSERT INTO "StructuredContent" (
         "companyId", name, "corporatePurpose", "shareCapital",
         "legalForm", street, "houseNumber", "zipCode", city,
         "foundingYear", "lastRegisterEntry", "lastRegisterModification",
         "createdAt", "updatedAt"
       )
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12, NOW(), $13)
       ON CONFLICT ("companyId") DO UPDATE SET
         name = EXCLUDED.name,
         "corporatePurpose" = EXCLUDED."corporatePurpose",
         "shareCapital" = EXCLUDED."shareCapital",
         "legalForm" = EXCLUDED."legalForm",
         street = EXCLUDED.street,
         "houseNumber" = EXCLUDED."houseNumber",
         "zipCode" = EXCLUDED."zipCode",
         city = EXCLUDED.city,
         "foundingYear" = EXCLUDED."foundingYear",
         "lastRegisterEntry" = EXCLUDED."lastRegisterEntry",
         "lastRegisterModification" = EXCLUDED."lastRegisterModification",
         "updatedAt" = EXCLUDED."updatedAt"
       WHERE EXCLUDED."updatedAt" > "StructuredContent"."updatedAt"`,
      [
        result.companyId,
        result.name,
        result.corporatePurpose ?? null,
        result.shareCapital ?? null,
        result.legalForm,
        result.street,
        result.houseNumber,
        result.zipCode,
        result.city,
        result.foundingYear ?? null,
        result.lastRegisterEntry ? new Date(result.lastRegisterEntry) : null,
        result.lastRegisterModification
          ? new Date(result.lastRegisterModification)
          : null,
        updatedAt,
      ],
    );

    if (upsertRes.rowCount === 0) {
      await client.query("ROLLBACK");
      log.info(
        { runId, tenantId, companyId: result.companyId },
        "structured-content persist skipped (existing row newer)",
      );
      return;
    }

    // Replace-all children: simpler than computing the diff, and
    // the legacy producer did the same (ManagingDirector has no
    // stable per-row key beyond the autoincrement id).
    await client.query(
      `DELETE FROM "ManagingDirector" WHERE "companyId" = $1`,
      [result.companyId],
    );
    for (const md of result.managingDirectors ?? []) {
      await client.query(
        `INSERT INTO "ManagingDirector"
           ("firstName", "lastName", "birthDay", city, "companyId",
            "createdAt", "updatedAt")
         VALUES ($1, $2, $3, $4, $5, NOW(), NOW())`,
        [
          md.firstName,
          md.lastName,
          md.birthDay ? new Date(md.birthDay) : null,
          md.city ?? null,
          result.companyId,
        ],
      );
    }

    await client.query("COMMIT");
    log.info(
      {
        runId,
        tenantId,
        companyId: result.companyId,
        managingDirectors: (result.managingDirectors ?? []).length,
      },
      "structured-content persist ✓",
    );
  } catch (err) {
    await client.query("ROLLBACK").catch(() => {});
    throw err;
  } finally {
    client.release();
  }
};

/** `tenant.persist.website.v1` — emitted by the local website
 *  compute-worker. Carries both rows so this handler does a single
 *  transactional upsert (Website + CompanySerp). */
interface WebsiteResult {
  companyId: string;
  serp?: {
    url?: string | null;
    companyNickname?: string | null;
    category?: string | null;
    latitude?: number | null;
    longitude?: number | null;
    address?: string | null;
    phone?: string | null;
    rating?: number | null;
    reviewCount?: number | null;
  };
  website?: {
    url?: string | null;
    siteName?: string | null;
    description?: string | null;
    tags?: string[];
  };
}

const applyWebsite: ApplyFn = async (pool, event, log) => {
  const data = event.data as PersistEvent<WebsiteResult> | undefined;
  if (!data) throw new Error("empty payload");
  const { result, computedAt, tenantId, runId } = data;
  if (!result?.companyId) throw new Error("missing result.companyId");
  if (!computedAt) throw new Error("missing computedAt");

  const updatedAt = new Date(computedAt);
  const client = await pool.connect();
  try {
    await client.query("BEGIN");

    if (result.serp) {
      const s = result.serp;
      await client.query(
        `INSERT INTO "CompanySerp" (
           "companyId", url, "companyNickname", category, latitude, longitude,
           address, phone, rating, "reviewCount", "createdAt", "updatedAt"
         )
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10, NOW(), $11)
         ON CONFLICT ("companyId") DO UPDATE SET
           url = EXCLUDED.url,
           "companyNickname" = EXCLUDED."companyNickname",
           category = EXCLUDED.category,
           latitude = EXCLUDED.latitude,
           longitude = EXCLUDED.longitude,
           address = EXCLUDED.address,
           phone = EXCLUDED.phone,
           rating = EXCLUDED.rating,
           "reviewCount" = EXCLUDED."reviewCount",
           "updatedAt" = EXCLUDED."updatedAt"
         WHERE EXCLUDED."updatedAt" > "CompanySerp"."updatedAt"`,
        [
          result.companyId,
          s.url ?? null,
          s.companyNickname ?? null,
          s.category ?? null,
          s.latitude ?? null,
          s.longitude ?? null,
          s.address ?? null,
          s.phone ?? null,
          s.rating ?? null,
          s.reviewCount ?? null,
          updatedAt,
        ],
      );
    }

    if (result.website) {
      const w = result.website;
      await client.query(
        `INSERT INTO "Website" (
           "companyId", url, "siteName", description, tags,
           "createdAt", "updatedAt"
         )
         VALUES ($1,$2,$3,$4,$5, NOW(), $6)
         ON CONFLICT ("companyId") DO UPDATE SET
           url = EXCLUDED.url,
           "siteName" = EXCLUDED."siteName",
           description = EXCLUDED.description,
           tags = EXCLUDED.tags,
           "updatedAt" = EXCLUDED."updatedAt"
         WHERE EXCLUDED."updatedAt" > "Website"."updatedAt"`,
        [
          result.companyId,
          w.url ?? null,
          w.siteName ?? null,
          w.description ?? null,
          w.tags ?? [],
          updatedAt,
        ],
      );
    }

    await client.query("COMMIT");
    log.info(
      {
        runId,
        tenantId,
        companyId: result.companyId,
        serp: !!result.serp,
        website: !!result.website,
      },
      "website persist ✓",
    );
  } catch (err) {
    await client.query("ROLLBACK").catch(() => {});
    throw err;
  } finally {
    client.release();
  }
};

/** `tenant.persist.company-publication.v1` payload — emitted by the
 *  local company-publication compute-worker. One event per company,
 *  carrying every Jahresabschluss publication the scrape produced.
 *
 *  The publication table is keyed `(companyId, name, year)`; child
 *  tables (SalesVolume, RevenueVolume, TotalAssetsVolume,
 *  StateOfAffairsAggregate) are 1:1 against the parent and replaced
 *  whole-cloth on each upsert (legacy producer did the same — no
 *  stable per-row child key beyond the parent). */
interface CompanyPublicationsResult {
  companyId: string;
  publications: Array<{
    name: string;
    year: number;
    begin: string;
    end: string;
    employeeCount?: number;
    salesVolume?: { value: number; currency: string };
    revenueVolume?: { value: number; currency: string };
    totalAssets?: { value: number; currency: string };
    stateOfAffairs?: {
      topic?: string;
      bullets?: string[];
      guidance?: string[];
      kpis?: Array<{ name: string; value: string; period?: string }>;
      risksOpportunities?: string[];
      isRelevant?: boolean;
    };
  }>;
}

/**
 * Apply a company-publication persist event. Per-publication
 * last-write-wins on the parent row by `(companyId, name, year)`,
 * children replaced when the parent updates. Single transaction
 * per publication (a partial-row failure for one Jahresabschluss
 * doesn't roll back the others).
 *
 * The state-of-affairs payload is stored as JSONB in a single
 * column rather than mapped to a typed schema — the LLM output's
 * inner shape evolves and last-write-wins is the right semantics
 * for the whole blob anyway.
 */
const applyCompanyPublication: ApplyFn = async (pool, event, log) => {
  const data = event.data as
    | PersistEvent<CompanyPublicationsResult>
    | undefined;
  if (!data) throw new Error("empty payload");
  const { result, computedAt, tenantId, runId } = data;
  if (!result?.companyId) throw new Error("missing result.companyId");
  if (!computedAt) throw new Error("missing computedAt");
  const updatedAt = new Date(computedAt);

  let upsertedCount = 0;
  let skippedCount = 0;

  for (const pub of result.publications ?? []) {
    const client = await pool.connect();
    try {
      await client.query("BEGIN");

      // Parent row. RETURNING id picks up the autoincrement key for
      // children; a no-op `DO UPDATE SET id = id` (instead of `DO
      // NOTHING`) makes RETURNING fire even when the row already
      // exists — we need that id whether we update or skip the
      // children.
      const parentRes = await client.query<{ id: number }>(
        `INSERT INTO "CompanyPublication"
           ("companyId", name, year, "begin", "end",
            "employeeCount", "createdAt", "updatedAt")
         VALUES ($1,$2,$3,$4,$5,$6, NOW(), $7)
         ON CONFLICT ("companyId", name, year) DO UPDATE
         SET "begin" = EXCLUDED."begin",
             "end" = EXCLUDED."end",
             "employeeCount" = EXCLUDED."employeeCount",
             "updatedAt" = EXCLUDED."updatedAt"
         WHERE EXCLUDED."updatedAt" > "CompanyPublication"."updatedAt"
         RETURNING id`,
        [
          result.companyId,
          pub.name,
          pub.year,
          new Date(pub.begin),
          new Date(pub.end),
          pub.employeeCount ?? null,
          updatedAt,
        ],
      );

      if (parentRes.rowCount === 0) {
        // Existing row newer than our compute. Skip children too.
        await client.query("ROLLBACK");
        skippedCount++;
        continue;
      }

      const publicationId = parentRes.rows[0].id;

      // Replace-all child rows. The inverse of NULL = "no row" —
      // wipe-then-insert lets the persisted state cleanly mirror
      // whatever the compute produced.
      for (const child of [
        "SalesVolume",
        "RevenueVolume",
        "TotalAssetsVolume",
        "StateOfAffairsAggregate",
      ]) {
        await client.query(
          `DELETE FROM "${child}" WHERE "companyPublicationId" = $1`,
          [publicationId],
        );
      }

      if (pub.salesVolume) {
        await client.query(
          `INSERT INTO "SalesVolume"
             (value, currency, "companyPublicationId", "createdAt", "updatedAt")
           VALUES ($1, $2, $3, NOW(), NOW())`,
          [pub.salesVolume.value, pub.salesVolume.currency, publicationId],
        );
      }
      if (pub.revenueVolume) {
        await client.query(
          `INSERT INTO "RevenueVolume"
             (value, currency, "companyPublicationId", "createdAt", "updatedAt")
           VALUES ($1, $2, $3, NOW(), NOW())`,
          [pub.revenueVolume.value, pub.revenueVolume.currency, publicationId],
        );
      }
      if (pub.totalAssets) {
        await client.query(
          `INSERT INTO "TotalAssetsVolume"
             (value, currency, "companyPublicationId", "createdAt", "updatedAt")
           VALUES ($1, $2, $3, NOW(), NOW())`,
          [pub.totalAssets.value, pub.totalAssets.currency, publicationId],
        );
      }
      if (pub.stateOfAffairs) {
        // The producer's `StateOfAffairsAggregate` table mirrors the
        // LLM-emitted shape; stored as a single JSONB document
        // because the inner schema (KPI list, topic enum) changes
        // alongside the prompt.
        await client.query(
          `INSERT INTO "StateOfAffairsAggregate"
             (data, "companyPublicationId", "createdAt", "updatedAt")
           VALUES ($1::jsonb, $2, NOW(), NOW())`,
          [JSON.stringify(pub.stateOfAffairs), publicationId],
        );
      }

      await client.query("COMMIT");
      upsertedCount++;
    } catch (err) {
      await client.query("ROLLBACK").catch(() => {});
      log.error(
        {
          runId,
          tenantId,
          companyId: result.companyId,
          year: pub.year,
          name: pub.name,
          err: err instanceof Error ? err.message : String(err),
        },
        "company-publication: skipping bad publication, continuing batch",
      );
    } finally {
      client.release();
    }
  }

  log.info(
    {
      runId,
      tenantId,
      companyId: result.companyId,
      upserted: upsertedCount,
      skipped: skippedCount,
      total: result.publications?.length ?? 0,
    },
    "company-publication persist ✓",
  );
};

/** Stub — schema + write logic land alongside each producer's
 *  localization. See todos: company-evaluation / company-contact. */
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
    apply: applyStructuredContent,
  },
  {
    producer: "company-publication",
    routingKey: "tenant.persist.company-publication.v1",
    queue: "db-gateway-persist-company-publication",
    apply: applyCompanyPublication,
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
  {
    producer: "website",
    routingKey: "tenant.persist.website.v1",
    queue: "db-gateway-persist-website",
    apply: applyWebsite,
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
          // Pull the (transactionId, companyId) pair out of the
          // CloudEvent envelope BEFORE the apply runs — even on a
          // failure path we want to record the entity-progress row
          // so `/v1/transactions/:id/entities` reflects the failed
          // state. Compute-workers set `transaction` and `subject`
          // on every persist event (see e.g. company-publication
          // compute-worker.ts), but be defensive in case an event
          // arrives without them.
          const txId = (event as { transaction?: string }).transaction ?? "";
          const companyId =
            (event as { subject?: string }).subject ??
            (event.data?.result as { companyId?: string } | undefined)?.companyId ??
            "";
          try {
            const pool = this.getPool(binding.producer);
            await binding.apply(pool, event, log);
            await recordEntityProgress(
              binding.producer,
              txId,
              companyId,
              "completed",
              null,
              log,
            );
          } catch (err) {
            log.error({ err }, "persist handler failed");
            await recordEntityProgress(
              binding.producer,
              txId,
              companyId,
              "failed",
              err instanceof Error ? err.message : String(err),
              log,
            );
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

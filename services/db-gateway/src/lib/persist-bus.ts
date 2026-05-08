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

import { AMQPClient, type CloudEvent } from "@ava/event";
import type pg from "pg";

import { loadEnv } from "./env";
import { logger } from "./logger";
import { PRODUCER_NAMES, type ProducerName } from "./db-urls";
import { getProducerPool, getGatewayPool } from "./producer-pools";
import { transactionProgressBus } from "./event-bus";
import { recordUsage } from "./billing";
import { tierShouldWrite, type ModelTier } from "./tier";

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
  // Push the SSE progress event regardless of the DB write outcome —
  // the renderer's matrix update path doesn't depend on EntityProgress
  // having landed (the snapshot endpoint reads it on the next mount,
  // but the live patch is purely SSE-driven). Doing the publish first
  // keeps the user's UI responsive even if the audit DB is briefly
  // misbehaving.
  //
  // §8.v3 — producer compute-workers used to publish their own
  // `transaction.progress` events; the localized rewrites dropped that
  // wiring, so the gateway now derives the terminal-state progress
  // event from the persist arrival. `in_progress` is still emitted by
  // each producer at handler entry (so the matrix shows yellow during
  // long captcha-gated runs); this path covers the
  // `pending → completed/failed/skipped` transition.
  try {
    transactionProgressBus.publishLocal({
      transactionId,
      tenantId: "",
      service: producer,
      companyId,
      state,
      errorMessage: truncated ?? undefined,
      updatedAt: new Date().toISOString(),
    });
  } catch (err) {
    // Bus dispatch is in-process — should never throw — but if a
    // handler does, we don't want to block the audit write.
    log.warn(
      { err: err instanceof Error ? err.message : String(err) },
      "progress-bus dispatch failed",
    );
  }
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
  /**
   * v0.1.62 — tier of the LLM that produced this write. Set on
   * LLM-driven stages (website, company-profile, company-contact,
   * company-evaluation); omitted on Selenium-only stages.
   *
   * Optional during the F2-only rollout: producers without F3 wiring
   * still emit persist events without this field, and the persist-bus
   * gate treats them as "untiered" (any tiered write upgrades past).
   *
   * 1..4 = C..S — see /MODEL_TIERS.md.
   */
  llmTier?: ModelTier | null;
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

// ---- Tier-aware persist gate (v0.1.62 — F2) --------------------------------
//
// Runs BEFORE every apply* function. Reads ContentFreshness for
// (companyId, stage), compares the incoming event's `data.llmTier`
// against the existing tier + age, and decides write/skip via
// @ava/ai-provider#tierShouldWrite.
//
// Skip semantics: the apply function is NOT called. EntityProgress is
// recorded as `skipped` (instead of `completed`/`failed`) so the
// matrix shows the correct state. Caller still acks the AMQP message —
// nothing to retry, the existing data is canonical.
//
// Stages classified as LLM-tiered (their persists carry an llmTier in
// the payload): website, company-profile, company-contact,
// company-evaluation. Non-LLM stages (structured-content,
// company-publication) pass null and the gate falls into pure
// time-based mode (30-day refresh).

/** Map producer name to whether the stage is LLM-tiered. Determines
 *  whether a missing `llmTier` is "non-LLM stage, time-based" or
 *  "untiered LLM producer (legacy)". For now: SERP-bearing producers
 *  (website, company-contact) AND profile/evaluation are LLM-tiered;
 *  Selenium-only stages are not. */
const STAGE_IS_LLM: Record<ProducerName, boolean> = {
  "structured-content": false,
  "company-publication": false,
  website: true,
  "company-profile": true,
  "company-contact": true,
  "company-evaluation": true,
};

/** Read the existing ContentFreshness row for (companyId, stage).
 *  Returns null when no row exists (treated as "fresh write" / age=Infinity). */
async function readFreshness(
  companyId: string,
  stage: ProducerName,
): Promise<{ tier: ModelTier | null; updatedAt: Date } | null> {
  const res = await getGatewayPool().query<{
    llmTier: number | null;
    updatedAt: Date;
  }>(
    `SELECT "llmTier", "updatedAt" FROM "ContentFreshness"
     WHERE "companyId" = $1 AND stage = $2`,
    [companyId, stage],
  );
  const row = res.rows[0];
  if (!row) return null;
  return {
    tier: (row.llmTier as ModelTier | null) ?? null,
    updatedAt: row.updatedAt,
  };
}

/** Upsert the ContentFreshness row after a successful write. */
async function recordFreshness(
  companyId: string,
  stage: ProducerName,
  llmTier: ModelTier | null,
): Promise<void> {
  await getGatewayPool().query(
    `INSERT INTO "ContentFreshness" ("companyId", stage, "llmTier", "updatedAt")
       VALUES ($1, $2, $3, NOW())
     ON CONFLICT ("companyId", stage) DO UPDATE SET
       "llmTier" = EXCLUDED."llmTier",
       "updatedAt" = NOW()`,
    [companyId, stage, llmTier],
  );
}

/**
 * Higher-order wrapper: take an existing applyFn and return a
 * gated version. The gate runs the freshness check first; if write
 * is allowed, runs the inner apply, then upserts ContentFreshness.
 * If write is denied, logs the reason + records a `skipped`
 * EntityProgress row.
 *
 * Each producer's binding now uses `withTierGate(stage, applyX)`
 * instead of `applyX` directly. Same signature so the rest of the
 * persist-bus plumbing is unchanged.
 */
function withTierGate(stage: ProducerName, inner: ApplyFn): ApplyFn {
  return async (pool, event, log) => {
    const data = event.data as PersistEvent<{ companyId: string }> | undefined;
    const companyId = data?.result?.companyId;
    const incomingTier = (data?.llmTier ?? null) as ModelTier | null;
    const transactionId = (event as { transaction?: string }).transaction ?? "";

    if (!companyId) {
      // Defer to inner handler's own validation; it will throw and
      // the caller's catch records the failure.
      return inner(pool, event, log);
    }

    const decision = await gatePersist(companyId, stage, incomingTier, log);
    if (!decision.apply) {
      log.info(
        {
          stage,
          companyId,
          incomingTier,
          existingTier: decision.existingTier,
          reason: decision.reason,
        },
        "tier-gate: skip",
      );
      // Surface the skip on the matrix the same way the in-process
      // skips do (e.g. structured-content services-gate). The user
      // sees "übersprungen" rather than a confusing red/green flicker.
      await recordEntityProgress(
        stage,
        transactionId,
        companyId,
        "skipped",
        decision.reason,
        log,
      );
      return;
    }

    // Apply the write, then update ContentFreshness. Order matters: we
    // only update freshness AFTER the apply succeeds, so a failed
    // apply doesn't leave an orphan freshness row claiming the write
    // happened.
    await inner(pool, event, log);
    try {
      await recordFreshness(
        companyId,
        stage,
        STAGE_IS_LLM[stage] ? incomingTier : null,
      );
    } catch (err) {
      // Best-effort: a freshness-write failure should never roll back
      // the actual data. Log + move on. Worst case the next event
      // sees stale freshness and writes anyway.
      log.warn(
        {
          err: err instanceof Error ? err.message : String(err),
          companyId,
          stage,
        },
        "ContentFreshness write failed (best-effort)",
      );
    }
  };
}

/**
 * Pre-apply gate. Returns `{ apply: true }` if the persist should
 * proceed, `{ apply: false, reason }` if it should skip.
 *
 * Best-effort wrt the freshness DB read: a read failure is logged + we
 * fall through to "apply" — losing one tier-skip beats blocking the
 * whole pipeline on a brief audit-DB hiccup.
 */
async function gatePersist(
  companyId: string,
  stage: ProducerName,
  incomingTier: ModelTier | null,
  log: typeof logger,
): Promise<{ apply: boolean; reason: string; existingTier: ModelTier | null }> {
  // Sanity: if the stage is non-LLM, force incomingTier null to avoid
  // accidental tier comparisons on Selenium-scraped content. Also
  // catches a misconfigured producer that bolts on a tier where it
  // shouldn't.
  const effectiveIncomingTier = STAGE_IS_LLM[stage] ? incomingTier : null;

  let existing: { tier: ModelTier | null; updatedAt: Date } | null;
  try {
    existing = await readFreshness(companyId, stage);
  } catch (err) {
    log.warn(
      {
        err: err instanceof Error ? err.message : String(err),
        companyId,
        stage,
      },
      "ContentFreshness read failed — defaulting to apply (best-effort)",
    );
    return {
      apply: true,
      reason: "freshness read failed; defaulting to apply",
      existingTier: null,
    };
  }

  const existingAgeMs = existing
    ? Date.now() - existing.updatedAt.getTime()
    : Infinity;
  const existingTier = existing?.tier ?? null;

  const decision = tierShouldWrite({
    incomingTier: effectiveIncomingTier,
    existingTier,
    existingAgeMs,
  });
  return { apply: decision.write, reason: decision.reason, existingTier };
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

  // M1 monetization — record a usage credit for this successful
  // persist. Failed structured-content scrapes never reach here (they
  // emit `transaction.progress` with state=failed but no persist
  // event), which gives us the "failure doesn't bill" semantics for
  // free. recordUsage is best-effort: a billing-table write failure
  // must NEVER affect the producer's data path.
  if (tenantId && result?.companyId) {
    await recordUsage(getGatewayPool(), log, {
      tenantId,
      companyId: result.companyId,
      source: "structured-content",
    });
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
  /** v0.1.60 — LLM-judge audit trail. Persisted to the gateway's
   *  WebsiteJudgment table (NOT the producer's website DB) so the
   *  metadata is available for "why did the LLM pick X" debugging
   *  + future explainable-UI surfaces. Always present from v0.1.60
   *  producers; older producers omit it and we just skip the audit
   *  write. */
  judgment?: {
    matchIndex: number | null;
    confidence: "high" | "medium" | "low" | null;
    reasoning: string;
    candidatesConsidered: number;
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
        judgment: !!result.judgment,
      },
      "website persist ✓",
    );
  } catch (err) {
    await client.query("ROLLBACK").catch(() => {});
    throw err;
  } finally {
    client.release();
  }

  // v0.1.60 — write the LLM-judge audit row to the gateway's audit DB
  // (separate from the producer's website DB; see WebsiteJudgment
  // schema rationale). Best-effort: a judgment-write failure should
  // never roll back the actual website data we just persisted.
  if (result.judgment) {
    try {
      const j = result.judgment;
      await getGatewayPool().query(
        `INSERT INTO "WebsiteJudgment" (
           "companyId", "matchIndex", confidence, reasoning,
           "candidatesConsidered", "judgedAt", "updatedAt"
         )
         VALUES ($1, $2, $3, $4, $5, NOW(), NOW())
         ON CONFLICT ("companyId") DO UPDATE SET
           "matchIndex" = EXCLUDED."matchIndex",
           confidence = EXCLUDED.confidence,
           reasoning = EXCLUDED.reasoning,
           "candidatesConsidered" = EXCLUDED."candidatesConsidered",
           "judgedAt" = NOW(),
           "updatedAt" = NOW()`,
        [
          result.companyId,
          j.matchIndex,
          j.confidence,
          j.reasoning,
          j.candidatesConsidered,
        ],
      );
    } catch (err) {
      log.warn(
        {
          err: err instanceof Error ? err.message : String(err),
          companyId: result.companyId,
        },
        "WebsiteJudgment write failed (best-effort)",
      );
    }
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
        // StateOfAffairsAggregate has typed columns + a separate
        // StateOfAffairsKPI child table. Topic is a Postgres enum
        // (Topic) — we cast through ::text so the LLM can emit any
        // string and we accept it; if it's not a valid enum value
        // the INSERT throws and the per-publication catch falls
        // through. Fields the LLM omits get DB defaults.
        const aggRes = await client.query<{ id: number }>(
          `INSERT INTO "StateOfAffairsAggregate"
             ("isRelevant", topic, bullets, guidance, "risksOpportunities",
              "companyPublicationId", "createdAt", "updatedAt")
           VALUES ($1, $2::"Topic", $3, $4, $5, $6, NOW(), NOW())
           RETURNING id`,
          [
            pub.stateOfAffairs.isRelevant ?? false,
            pub.stateOfAffairs.topic ?? "NOTHING",
            pub.stateOfAffairs.bullets ?? [],
            pub.stateOfAffairs.guidance ?? [],
            pub.stateOfAffairs.risksOpportunities ?? [],
            publicationId,
          ],
        );
        const aggregateId = aggRes.rows[0].id;
        for (const kpi of pub.stateOfAffairs.kpis ?? []) {
          await client.query(
            `INSERT INTO "StateOfAffairsKPI"
               (name, value, period, "aggregateId", "createdAt", "updatedAt")
             VALUES ($1, $2, $3, $4, NOW(), NOW())`,
            [kpi.name, kpi.value, kpi.period ?? null, aggregateId],
          );
        }
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

// =============================================================================
// company-evaluation
// =============================================================================
//
// Highest fan-in producer: 8 inbound event types from the legacy chain, each
// carrying a different slice. The compute-worker normalises all 8 into a
// single `tenant.persist.company-evaluation.v1` family with partial slices;
// this apply handler does a partial upsert that mirrors the legacy
// `evaluationDataRepository.upsert` semantics — fields not present in the
// event don't overwrite existing values.
//
// Replace-all semantics on the children: when the slice contains a list
// field (e.g. `keywords`, `managingDirectors`, `keyFigures.sales`), we
// delete-then-insert. The legacy producer did the same. The "merge by id"
// alternative would need stable per-row keys upstream that we don't have.
//
// Phase 2a: persist only. Embedding compute + ES indexing follow in Phase
// 2b — until then `demandEmbedding` stays null for new transactions, which
// degrades the company-search vector index for those companies.

interface CompanyEvaluationResult {
  companyId: string;
  companyName?: string;
  companyProfile?: string;
  businessPurpose?: string | null;
  companyAddress?: string;
  latitude?: number;
  longitude?: number;
  serpCategory?: string;
  keywords?: string[];
  keyFigures?: {
    sales?: { value: number; currency: string; year: number }[];
    totalAssets?: { value: number; currency: string; year: number }[];
    profits?: { value: number; currency: string; year: number }[];
    employees?: { value: number; year: number }[];
  };
  stateOfAffairs?: Array<{
    year: number;
    isRelevant: boolean;
    topic: string;
    bullets: string[];
    guidance: string[];
    risksOpportunities: string[];
    kpis: { name: string; value: string; period?: string }[];
  }>;
  managingDirectors?: Array<{
    firstName: string;
    lastName: string;
    birthDay?: Date | string | null;
    city?: string | null;
  }>;
  deepResearches?: Array<{
    company?: string;
    type: string;
    title: string;
    country?: string;
    value?: string;
    date?: string;
    url: string;
    citations: string[];
  }>;
  jobPostings?: Array<{
    title: string;
    location?: string;
    workingModel?: string;
    description?: string;
    requirements: string[];
    technologies: string[];
    sourceUrl: string;
    releaseDate?: Date | string;
  }>;
  contacts?: Array<{
    fullName?: string;
    linkedinUrl?: string;
    xingUrl?: string;
    email?: string;
    phone?: string;
    employments: Array<{
      title?: string;
      department?: string;
      seniority?: string;
      confidence: number;
      startDate?: Date | string;
    }>;
  }>;
}

const applyCompanyEvaluation: ApplyFn = async (pool, event, log) => {
  const data = event.data as PersistEvent<CompanyEvaluationResult> | undefined;
  if (!data) throw new Error("empty payload");
  const { result, computedAt, tenantId, runId } = data;
  if (!result?.companyId) throw new Error("missing result.companyId");
  if (!computedAt) throw new Error("missing computedAt");
  const updatedAt = new Date(computedAt);
  const companyId = result.companyId;

  const client = await pool.connect();
  try {
    await client.query("BEGIN");

    // Parent row. Partial upsert: only overwrite columns the event
    // brought. companyName has a NOT NULL constraint, so on first
    // insert we need a value — fall back to companyId so the row
    // can be created and a later structured-content event can set
    // the real name.
    const parentInsert = await client.query(
      `INSERT INTO "EvaluationData"
         ("companyId", "companyName",
          "companyProfile", "businessPurpose",
          "companyAddress", latitude, longitude, "serpCategory",
          keywords,
          "createdAt", "updatedAt")
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9, NOW(), $10)
       ON CONFLICT ("companyId") DO UPDATE
       SET "companyName" = COALESCE(EXCLUDED."companyName", "EvaluationData"."companyName"),
           "companyProfile" = COALESCE(EXCLUDED."companyProfile", "EvaluationData"."companyProfile"),
           "businessPurpose" = COALESCE(EXCLUDED."businessPurpose", "EvaluationData"."businessPurpose"),
           "companyAddress" = COALESCE(EXCLUDED."companyAddress", "EvaluationData"."companyAddress"),
           latitude = COALESCE(EXCLUDED.latitude, "EvaluationData".latitude),
           longitude = COALESCE(EXCLUDED.longitude, "EvaluationData".longitude),
           "serpCategory" = COALESCE(EXCLUDED."serpCategory", "EvaluationData"."serpCategory"),
           keywords = CASE
             WHEN cardinality(EXCLUDED.keywords) > 0 THEN EXCLUDED.keywords
             ELSE "EvaluationData".keywords
           END,
           "updatedAt" = EXCLUDED."updatedAt"`,
      [
        companyId,
        result.companyName ?? companyId,
        result.companyProfile ?? null,
        result.businessPurpose ?? null,
        result.companyAddress ?? null,
        result.latitude ?? null,
        result.longitude ?? null,
        result.serpCategory ?? null,
        result.keywords ?? [],
        updatedAt,
      ],
    );
    void parentInsert;

    // ---- managingDirectors: replace-all when the field is present.
    if (result.managingDirectors) {
      await client.query(
        `DELETE FROM "ManagingDirector" WHERE "companyId" = $1`,
        [companyId],
      );
      for (const md of result.managingDirectors) {
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
            companyId,
          ],
        );
      }
    }

    // ---- keyFigures: parent row 1:1 with EvaluationData, four
    //      child figure tables. Replace all four when keyFigures is
    //      present on the slice.
    if (result.keyFigures) {
      // Ensure parent KeyFigures row exists; PK is (companyId).
      const kfRes = await client.query<{ id: number }>(
        `INSERT INTO "KeyFigures" ("companyId", "createdAt", "updatedAt")
         VALUES ($1, NOW(), NOW())
         ON CONFLICT ("companyId") DO UPDATE
         SET "updatedAt" = NOW()
         RETURNING id`,
        [companyId],
      );
      const keyFiguresId = kfRes.rows[0].id;
      // Wipe the four figure tables and re-insert.
      await client.query(
        `DELETE FROM "SalesFigure" WHERE "keyFiguresId" = $1`,
        [keyFiguresId],
      );
      await client.query(
        `DELETE FROM "TotalAssetsFigure" WHERE "keyFiguresId" = $1`,
        [keyFiguresId],
      );
      await client.query(
        `DELETE FROM "ProfitFigure" WHERE "keyFiguresId" = $1`,
        [keyFiguresId],
      );
      await client.query(
        `DELETE FROM "EmployeesFigure" WHERE "keyFiguresId" = $1`,
        [keyFiguresId],
      );
      for (const f of result.keyFigures.sales ?? []) {
        await client.query(
          `INSERT INTO "SalesFigure"
             (value, currency, year, "keyFiguresId", "createdAt", "updatedAt")
           VALUES ($1, $2, $3, $4, NOW(), NOW())`,
          [f.value, f.currency, f.year, keyFiguresId],
        );
      }
      for (const f of result.keyFigures.totalAssets ?? []) {
        await client.query(
          `INSERT INTO "TotalAssetsFigure"
             (value, currency, year, "keyFiguresId", "createdAt", "updatedAt")
           VALUES ($1, $2, $3, $4, NOW(), NOW())`,
          [f.value, f.currency, f.year, keyFiguresId],
        );
      }
      for (const f of result.keyFigures.profits ?? []) {
        await client.query(
          `INSERT INTO "ProfitFigure"
             (value, currency, year, "keyFiguresId", "createdAt", "updatedAt")
           VALUES ($1, $2, $3, $4, NOW(), NOW())`,
          [f.value, f.currency, f.year, keyFiguresId],
        );
      }
      for (const f of result.keyFigures.employees ?? []) {
        await client.query(
          `INSERT INTO "EmployeesFigure"
             (value, year, "keyFiguresId", "createdAt", "updatedAt")
           VALUES ($1, $2, $3, NOW(), NOW())`,
          [f.value, f.year, keyFiguresId],
        );
      }
    }

    // ---- stateOfAffairs: list keyed by (companyId, year). Replace-all
    //      when the slice carries the field.
    if (result.stateOfAffairs) {
      // Drop existing aggregates for this company; KPI rows cascade.
      await client.query(
        `DELETE FROM "StateOfAffairsAggregate" WHERE "companyId" = $1`,
        [companyId],
      );
      for (const soa of result.stateOfAffairs) {
        const aggRes = await client.query<{ id: number }>(
          `INSERT INTO "StateOfAffairsAggregate"
             ("companyId", "isRelevant", topic, year,
              bullets, guidance, "risksOpportunities",
              "createdAt", "updatedAt")
           VALUES ($1, $2, $3::"Topic", $4, $5, $6, $7, NOW(), NOW())
           RETURNING id`,
          [
            companyId,
            soa.isRelevant,
            soa.topic,
            soa.year,
            soa.bullets,
            soa.guidance,
            soa.risksOpportunities,
          ],
        );
        const aggregateId = aggRes.rows[0].id;
        for (const kpi of soa.kpis ?? []) {
          await client.query(
            `INSERT INTO "StateOfAffairsKPI"
               (name, value, period, "aggregateId", "createdAt", "updatedAt")
             VALUES ($1, $2, $3, $4, NOW(), NOW())`,
            [kpi.name, kpi.value, kpi.period ?? null, aggregateId],
          );
        }
      }
    }

    // ---- deepResearches: replace-all by companyId.
    if (result.deepResearches) {
      await client.query(
        `DELETE FROM "DeepResearch" WHERE "companyId" = $1`,
        [companyId],
      );
      for (const dr of result.deepResearches) {
        await client.query(
          `INSERT INTO "DeepResearch"
             (id, company, type, title, country, value, date, url, citations,
              "companyId", "createdAt", "updatedAt")
           VALUES (gen_random_uuid()::text,
                   $1, $2::"DeepResearchType", $3, $4, $5, $6, $7, $8,
                   $9, NOW(), NOW())`,
          [
            dr.company ?? null,
            dr.type,
            dr.title,
            dr.country ?? null,
            dr.value ?? null,
            dr.date ?? null,
            dr.url,
            dr.citations ?? [],
            companyId,
          ],
        );
      }
    }

    // ---- jobPostings: replace-all by companyId.
    if (result.jobPostings) {
      await client.query(
        `DELETE FROM "JobPosting" WHERE "companyId" = $1`,
        [companyId],
      );
      for (const jp of result.jobPostings) {
        await client.query(
          `INSERT INTO "JobPosting"
             (id, title, location, "workingModel", description,
              requirements, technologies, "sourceUrl", "releaseDate",
              "companyId", "createdAt", "updatedAt")
           VALUES (gen_random_uuid()::text,
                   $1, $2, $3, $4, $5, $6, $7, $8,
                   $9, NOW(), NOW())`,
          [
            jp.title,
            jp.location ?? null,
            jp.workingModel ?? null,
            jp.description ?? null,
            jp.requirements ?? [],
            jp.technologies ?? [],
            jp.sourceUrl,
            jp.releaseDate ? new Date(jp.releaseDate) : null,
            companyId,
          ],
        );
      }
    }

    // ---- contacts: replace-all by companyId, plus their employments
    //      child rows (cascade-delete handles those).
    if (result.contacts) {
      await client.query(
        `DELETE FROM "Contact" WHERE "companyId" = $1`,
        [companyId],
      );
      for (const ct of result.contacts) {
        const ctRes = await client.query<{ id: string }>(
          `INSERT INTO "Contact"
             (id, "fullName", "linkedinUrl", "xingUrl", email, phone,
              "companyId", "createdAt", "updatedAt")
           VALUES (gen_random_uuid()::text,
                   $1, $2, $3, $4, $5,
                   $6, NOW(), NOW())
           RETURNING id`,
          [
            ct.fullName ?? null,
            ct.linkedinUrl ?? null,
            ct.xingUrl ?? null,
            ct.email ?? null,
            ct.phone ?? null,
            companyId,
          ],
        );
        const contactId = ctRes.rows[0].id;
        for (const emp of ct.employments ?? []) {
          await client.query(
            `INSERT INTO "Employment"
               (id, title, department, seniority, confidence, "startDate",
                "contactId", "createdAt", "updatedAt")
             VALUES (gen_random_uuid()::text,
                     $1, $2, $3, $4, $5,
                     $6, NOW(), NOW())`,
            [
              emp.title ?? null,
              emp.department ?? null,
              emp.seniority ?? null,
              emp.confidence,
              emp.startDate ? new Date(emp.startDate) : null,
              contactId,
            ],
          );
        }
      }
    }

    await client.query("COMMIT");
    log.info(
      {
        runId,
        tenantId,
        companyId,
        sliceKeys: Object.keys(result).filter((k) => k !== "companyId"),
      },
      "company-evaluation persist ✓",
    );
  } catch (err) {
    await client.query("ROLLBACK").catch(() => {});
    throw err;
  } finally {
    client.release();
  }
};

// =============================================================================
// company-contact
// =============================================================================
//
// §8.v3 Phase 3 — gateway-side reconciliation port. The desktop's
// compute-worker scrapes + LLM-extracts raw observations (no DB), bundles
// them into a single persist event per company per dispatch, and forwards
// here. The reconciliation logic itself (Person identity merge, Employment
// projection, Fact rollup, Signal emission, TTL cleanup) is the original
// company-contact code vendored under `lib/contact-extraction/` with one
// edit: the prisma client now points at the gateway-local
// `ava_company_contact` MPG schema.
//
// Why prisma rather than raw pg: the reconciliation is the most subtle code
// in the codebase (700+ lines of merge/score/dedup logic). A raw-pg port
// would multiply the surface area for behaviour drift. The gateway already
// runs against the same MPG cluster; one extra prisma client is cheap.
//
// Event shape: each event covers one (companyId, source) tuple. Compute can
// emit MULTIPLE events per dispatch (one per agent: website-contact,
// website-people, search) — apply runs independently per event. Order
// doesn't matter because reconciliation is idempotent over observations.

import type { CompanyContactPersistRequest } from "./contact-extraction-apply";

const applyCompanyContact: ApplyFn = async (_pool, event, log) => {
  // Lazy import — pulls in the prisma client + reconciliation graph only
  // when the first contact event arrives, not at every gateway boot.
  const { applyCompanyContactPersist } = await import(
    "./contact-extraction-apply"
  );
  const data = event.data as
    | PersistEvent<CompanyContactPersistRequest["result"]>
    | undefined;
  if (!data) throw new Error("empty payload");
  await applyCompanyContactPersist(data, log);
};

/** Stub — for any future producer that lands without an apply yet. */
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

// v0.1.62 — every binding's apply function is wrapped in withTierGate(stage).
// The gate consults ContentFreshness + tierShouldWrite() before invoking
// the inner apply, and updates ContentFreshness on a successful write.
// Skips emit a "skipped" EntityProgress row (visible on the matrix) and
// ack the AMQP message — nothing to retry, the existing data is canonical.
const BINDINGS: ProducerBinding[] = [
  {
    producer: "company-profile",
    routingKey: "tenant.persist.company-profile.v1",
    queue: "db-gateway-persist-company-profile",
    apply: withTierGate("company-profile", applyCompanyProfile),
  },
  {
    producer: "structured-content",
    routingKey: "tenant.persist.structured-content.v1",
    queue: "db-gateway-persist-structured-content",
    apply: withTierGate("structured-content", applyStructuredContent),
  },
  {
    producer: "company-publication",
    routingKey: "tenant.persist.company-publication.v1",
    queue: "db-gateway-persist-company-publication",
    apply: withTierGate("company-publication", applyCompanyPublication),
  },
  {
    producer: "company-evaluation",
    routingKey: "tenant.persist.company-evaluation.v1",
    queue: "db-gateway-persist-company-evaluation",
    apply: withTierGate("company-evaluation", applyCompanyEvaluation),
  },
  {
    producer: "company-contact",
    routingKey: "tenant.persist.company-contact.v1",
    queue: "db-gateway-persist-company-contact",
    apply: withTierGate("company-contact", applyCompanyContact),
  },
  {
    producer: "website",
    routingKey: "tenant.persist.website.v1",
    queue: "db-gateway-persist-website",
    apply: withTierGate("website", applyWebsite),
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

        // Use the raw amqplib channel directly. We CANNOT go through
        // @ava/event's getListener/subscribe path: its
        // CloudEventGenerator.fromAny() looks up a typed payload
        // generator by event.type, and our `tenant.persist.<producer>.v1`
        // family isn't registered in @ava/event's catalog → fromAny
        // returns `event.data = undefined`, every apply throws
        // "empty payload", and no EntityProgress rows ever get written.
        // (This was the silent v0.1.39/40 bug — Excel imports created
        // master-data Transaction rows but the desktop saw zero
        // entities for them.) Reading msg.content directly gives us
        // the unmodified CloudEvent JSON the producer sent.
        //
        // The cast through unknown is the only ergonomic way to reach
        // the underlying amqplib channel that @ava/event holds private.
        // Acceptable — we're already coupled to the exact AMQPClient
        // implementation by virtue of vendoring it.
        // Structural type — we don't depend on @types/amqplib (only
        // @ava/event has it transitively). The two methods we need.
        type RawChannel = {
          consume: (
            queue: string,
            handler: (msg: { content: Buffer } | null) => void,
          ) => Promise<unknown>;
          ack: (msg: { content: Buffer }) => void;
        };
        const channel = (client as unknown as { _channel: RawChannel })
          ._channel;
        await channel.consume(binding.queue, async (msg) => {
          if (!msg) return;
          let event: CloudEvent<PersistEvent<unknown>>;
          try {
            event = JSON.parse(msg.content.toString()) as CloudEvent<
              PersistEvent<unknown>
            >;
          } catch (err) {
            logger.error(
              { err, producer: binding.producer },
              "persist message: invalid JSON; dropping",
            );
            channel.ack(msg);
            return;
          }
          const log = logger.child({
            producer: binding.producer,
            runId: event.data?.runId ?? event.id ?? "<no-id>",
          });
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
            // Swallow + ack: last-write-wins makes this idempotent,
            // and a redelivery loop on a poisoned event would block
            // the queue.
          } finally {
            channel.ack(msg);
          }
        });

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

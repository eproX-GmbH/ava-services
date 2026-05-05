import { OpenAPIHono, createRoute, z } from "@hono/zod-openapi";
import type { Context } from "hono";
import { HTTPException } from "hono/http-exception";
import { streamSSE } from "hono/streaming";
import { requireScope } from "../../middleware/auth";
import { callUpstream } from "../../lib/upstream";
import { transactionProgressBus } from "../../lib/event-bus";
import { getGatewayPool } from "../../lib/producer-pools";
import {
  publishCompanyContactRetry,
  publishCompanyProfileRetry,
  publishCompanyPublicationRetry,
  publishStructuredContentRetry,
  publishWebsiteRetry,
} from "../../lib/retry-publish";
import { logger } from "../../lib/logger";
import {
  getTransactionName,
  getTransactionNames,
} from "../../lib/transaction-names";
import {
  EntityTransactionShape,
  ErrorShape,
  PaginatedShape,
  PaginationQuery,
  PipelineCellShape,
  PipelineShape,
  PipelineStage,
  ProcessingErrorShape,
  RetryStage,
  RetryStageBody,
  RetryStageResultShape,
  TransactionEntityParams,
  TransactionIdParam,
  TransactionShape,
} from "./schemas";
import type { UpstreamName } from "../../lib/upstream";

// §6 SSE bridge.
//
// Re-emits `transaction.progress` events from the AMQP bus as Server-Sent
// Events to the Desktop-App. The bus subscriber is a process-singleton —
// see lib/event-bus.ts. This handler only owns the per-connection stream.
//
// Lifecycle:
//   - on connect: ensure bus subscription, register a per-stream handler
//   - on each progress event: write SSE if tenant matches caller
//   - on terminal state (completed/failed/cancelled): close the stream
//   - on client disconnect: unsubscribe; do NOT throw
//
// Note: the streaming handler is a plain Hono `.get(...)` (not `openapi()`)
// because streamSSE's Response type doesn't satisfy zod-openapi's typed-
// response generic. We document the endpoint in OpenAPI separately via
// `openAPIRegistry.registerPath` below — Swagger UI lists it, but the actual
// handler keeps the streaming-friendly typing.

export const transactionsRouter = new OpenAPIHono();
transactionsRouter.use("*", requireScope("transaction:read"));

const TransactionEventsParam = z.object({
  transactionId: z.string().min(1),
});

// ---- OpenAPI doc-only registration for the SSE endpoint --------------------
//
// Per-row `progress` events are the wire contract (DESKTOP_DATA_FLOW.md §6).
// We model the payload here so the schema shows up under Swagger UI's
// `text/event-stream` content type alongside the framing notes.

const TransactionProgressEvent = z
  .object({
    transactionId: z.string(),
    tenantId: z.string(),
    service: z.string(),
    companyId: z.string(),
    state: z.enum(["completed", "failed", "skipped", "in_progress"]),
    errorMessage: z.string().optional(),
    updatedAt: z.string(),
  })
  .openapi("TransactionProgressEvent");

transactionsRouter.openAPIRegistry.registerPath({
  method: "get",
  path: "/transactions/{transactionId}/events",
  tags: ["transactions"],
  summary: "Subscribe to live transaction progress (W4, SSE)",
  description: [
    "Server-Sent Events stream of per-row `transaction.progress` events for a single transaction.",
    "",
    "Frame types:",
    "- `event: open`   — initial hello, `data` is `{ transactionId }`.",
    "- `event: progress` — one frame per (companyId, service) terminal transition;",
    "  `data` is a JSON `TransactionProgressEvent`.",
    "- `event: ping`   — keep-alive heartbeat every ~25s, empty `data`.",
    "",
    "The stream stays open until the client disconnects — no service can",
    "authoritatively declare a transaction complete (the dependency chain may",
    "legitimately drop companies), so there is no terminal frame.",
    "",
    "Tenant-scoped: events are filtered to the caller's `tenantId` by the gateway.",
  ].join("\n"),
  request: { params: TransactionIdParam },
  responses: {
    200: {
      description: "SSE stream of progress events",
      content: {
        "text/event-stream": {
          schema: TransactionProgressEvent,
        },
      },
    },
    401: { description: "unauthenticated" },
    403: { description: "forbidden" },
    502: { description: "event bus unavailable" },
  },
});

transactionsRouter.get("/transactions/:transactionId/events", async (c) => {
  const params = TransactionEventsParam.safeParse({
    transactionId: c.req.param("transactionId"),
  });
  if (!params.success) {
    return c.json({ error: "invalid_param", detail: params.error.flatten() }, 400);
  }
  const { transactionId } = params.data;
  const auth = c.get("auth");
  const requestId = c.get("requestId");

  // Connect lazily on first SSE request. If the bus is down we surface a
  // 502 — per D11 the gateway is online-only.
  try {
    await transactionProgressBus.ensureConnected();
  } catch (err) {
    logger.error({ err, requestId }, "event-bus connect failed");
    return c.json({ error: "bus_unavailable" }, 502);
  }

  return streamSSE(c, async (stream) => {
    let closed = false;
    const queue: Array<{ event: string; data: string; id: string }> = [];
    let resolveNext: (() => void) | undefined;

    const push = (event: string, data: unknown) => {
      const id = `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
      queue.push({
        id,
        event,
        data: typeof data === "string" ? data : JSON.stringify(data),
      });
      resolveNext?.();
      resolveNext = undefined;
    };

    const unsubscribe = transactionProgressBus.subscribe(transactionId, (payload) => {
      // Tenant gate: drop events that don't belong to caller's tenant.
      //
      // Producers stamp `tenantId` from `process.env.TENANT_ID`, which falls
      // back to "" when the dep doesn't deploy with a tenant configured
      // (single-tenant dev / hybrid setups). Treat blank as "implicit
      // caller's tenant" so those events still flow — the bus is internal
      // AMQP, the subscription is already scoped per-transactionId, and the
      // SSE caller has already proven transaction ownership upstream. A
      // populated mismatching tenantId is still rejected.
      if (payload.tenantId && payload.tenantId !== auth.tenantId) return;
      // Per-row events only (DESKTOP_DATA_FLOW.md §6) — no terminal "end"
      // frame because no service can authoritatively declare a transaction
      // complete (dependency chain may legitimately drop companies).
      // Stream stays open until the client disconnects.
      push("progress", payload);
    });

    stream.onAbort(() => {
      closed = true;
      unsubscribe();
      resolveNext?.();
    });

    // Initial hello so clients know the stream is live.
    await stream.writeSSE({ event: "open", data: JSON.stringify({ transactionId }) });

    // Heartbeat to keep proxies from idling out (fly.io / CDNs).
    const heartbeat = setInterval(() => {
      if (closed) return;
      stream.writeSSE({ event: "ping", data: "" }).catch(() => {
        closed = true;
      });
    }, 25_000);

    try {
      while (!closed || queue.length > 0) {
        if (queue.length === 0) {
          await new Promise<void>((resolve) => {
            resolveNext = resolve;
          });
          continue;
        }
        const next = queue.shift()!;
        await stream.writeSSE(next);
      }
    } finally {
      clearInterval(heartbeat);
      unsubscribe();
    }
  });
});

// =============================================================================
// §4.2 Transaction reads (W2–W5).
//
// All five endpoints proxy to the company-profile service, which is the only
// upstream with a complete transaction REST surface today. Per the data model,
// every producer service stores its own Transaction + EntityTransaction rows
// (each handler creates them from the same upstream event), so company-profile
// is a representative authority for snapshot reads. Per-service breakdown of
// EntityTransaction state is the live SSE feed (§6) — adding cross-service
// fan-out for the snapshot views is a Step 7 hardening item.
//
// Tenant isolation: company-profile's existing JWT validation filters
// `/api/v1/users/transactions` by user. Per-id endpoints don't filter by user
// today, so we layer ownership verification at the gateway. The user-list
// fetch and the 1000-row entities-page fetch are both memoized per request
// (see helpers below), so the routes that need both — list, entityDetail,
// errors — don't pay duplicate round-trips.
// =============================================================================

const tag = "transactions";
const errorResponses = {
  401: { content: { "application/json": { schema: ErrorShape } }, description: "unauthenticated" },
  403: { content: { "application/json": { schema: ErrorShape } }, description: "forbidden" },
  404: { content: { "application/json": { schema: ErrorShape } }, description: "not found" },
  429: { content: { "application/json": { schema: ErrorShape } }, description: "rate limited" },
  502: { content: { "application/json": { schema: ErrorShape } }, description: "upstream failure" },
} as const;

// ---- GET /v1/transactions --------------------------------------------------

const listRoute = createRoute({
  method: "get",
  path: "/transactions",
  tags: [tag],
  summary: "List my transactions (W2)",
  request: { query: PaginationQuery },
  responses: {
    200: {
      content: { "application/json": { schema: PaginatedShape(TransactionShape) } },
      description: "page of transactions",
    },
    ...errorResponses,
  },
});

transactionsRouter.openapi(listRoute, async (c) => {
  const { page, pageSize } = c.req.valid("query");

  // Upstream returns an unpaginated array (filtered by token's userId).
  // Gateway sorts by `createdAt` descending (newest first — what every
  // analyst's first instinct is when scanning their list of imports) and
  // then slices client-side. TODO upstream: add pageNumber/pageSize +
  // server-side ordering. Cached for the request so a follow-up ownership
  // check on a per-id route reuses the same fetch.
  const all = await getMyTransactions(c);

  const sorted = [...all].sort((a, b) => {
    // String compare on ISO-8601 timestamps is correct because the format
    // is lexicographically ordered. Missing `createdAt` (defensive) sorts
    // to the bottom so a malformed row doesn't push the latest off-page.
    const ax = (a as { createdAt?: unknown }).createdAt;
    const bx = (b as { createdAt?: unknown }).createdAt;
    const av = typeof ax === "string" ? ax : "";
    const bv = typeof bx === "string" ? bx : "";
    if (av === bv) return 0;
    if (!av) return 1;
    if (!bv) return -1;
    return bv.localeCompare(av);
  });

  const start = (page - 1) * pageSize;
  const page_ = sorted.slice(start, start + pageSize) as Array<
    z.infer<typeof TransactionShape>
  >;

  // Overlay gateway-side names. Upstream master-data accepts the `name`
  // query param on POST but doesn't propagate it back through to
  // company-profile, so the rows we receive here lack it. We persisted
  // the value at POST time (lib/transaction-names) and merge it in here.
  // Upstream wins if it ever starts returning a non-empty name itself.
  const ids = page_.map((t) => t.id).filter((x): x is string => !!x);
  const names = getTransactionNames(ids);
  const annotated = page_.map((t) =>
    !t.name && t.id && names.has(t.id)
      ? { ...t, name: names.get(t.id) }
      : t,
  );

  return c.json(
    {
      items: annotated,
      page,
      pageSize,
      total: sorted.length,
    },
    200,
  );
});

// ---- GET /v1/transactions/:transactionId -----------------------------------

const detailRoute = createRoute({
  method: "get",
  path: "/transactions/{transactionId}",
  tags: [tag],
  summary: "Get transaction (W3)",
  request: { params: TransactionIdParam },
  responses: {
    200: { content: { "application/json": { schema: TransactionShape } }, description: "transaction" },
    ...errorResponses,
  },
});

transactionsRouter.openapi(detailRoute, async (c) => {
  const { transactionId } = c.req.valid("param");
  // §8.v3 — master-data is the canonical owner of the top-level
  // Transaction row (writes happen there on Excel import / single-
  // company kick-off). The legacy companyProfile call only had data
  // from when the fly producer was creating its own per-stage rows;
  // that path is gone now.
  const upstream = await callUpstream<z.infer<typeof TransactionShape>>(
    c,
    "masterData",
    `/api/v1/transactions/${encodeURIComponent(transactionId)}`,
  );
  await assertTransactionOwnership(c, upstream as Record<string, unknown>);
  // Same gateway-owned overlay as the list route — see comment there.
  const annotated =
    !upstream.name
      ? { ...upstream, name: getTransactionName(transactionId) ?? upstream.name }
      : upstream;
  return c.json(annotated, 200);
});

// ---- GET /v1/transactions/:transactionId/entities --------------------------

const entitiesRoute = createRoute({
  method: "get",
  path: "/transactions/{transactionId}/entities",
  tags: [tag],
  summary: "List per-entity state for a transaction (W3)",
  request: { params: TransactionIdParam, query: PaginationQuery },
  responses: {
    200: {
      content: { "application/json": { schema: PaginatedShape(EntityTransactionShape) } },
      description: "page of entity transactions",
    },
    ...errorResponses,
  },
});

transactionsRouter.openapi(entitiesRoute, async (c) => {
  const { transactionId } = c.req.valid("param");
  const { page, pageSize } = c.req.valid("query");

  await assertTransactionOwnershipById(c, transactionId);

  // §8.v3 — read per-company state from the gateway's own
  // EntityProgress table. Each `tenant.persist.<producer>.v1`
  // event arrival writes a row; we aggregate the per-producer
  // rows into a single per-company state here.
  //
  // Roll-up rule: failed > skipped > completed. Skipped because a
  // single producer skipping doesn't fail the company; completed
  // because we want optimistic "done" reporting (the chat tool
  // counts buckets and this matches user expectations). If at
  // least one producer for a company has shipped, the company is
  // considered to have made progress — which is the most useful
  // signal during a long import.
  //
  // Pre-§8.v3 transactions (from before the gateway started
  // recording) won't have rows here. For those we fall back to the
  // legacy fly company-profile upstream so old transactions still
  // report state.
  const pool = getGatewayPool();
  const offset = (page - 1) * pageSize;

  // First: total distinct companies for this transaction (no
  // pagination on the count). One row per company even if it has
  // multiple producer rows.
  const totalRes = await pool.query<{ total: string }>(
    `SELECT COUNT(DISTINCT "companyId")::text AS total
     FROM "EntityProgress"
     WHERE "transactionId" = $1`,
    [transactionId],
  );
  const localTotal = Number(totalRes.rows[0]?.total ?? "0");

  if (localTotal === 0) {
    // No rows yet — either pre-§8.v3 transaction or a fresh
    // dispatch where no producer has finished its first company.
    // Defer to the legacy upstream so old transactions still work;
    // the result will be empty for fresh ones, which is correct
    // (zero entities done, total comes from master-data elsewhere).
    const upstream = await callUpstream<UpstreamEntitiesPayload>(
      c,
      "companyProfile",
      `/api/v1/transactions/${encodeURIComponent(transactionId)}/entities`,
      { query: { pageNumber: page, pageSize } },
    ).catch((err: unknown) => {
      // Fly company-profile may be suspended (it is, in §8.v3).
      // Return an empty page rather than 502 the caller — they get
      // honest "no entities yet" rather than a hard error.
      logger.warn(
        { err, transactionId },
        "entities upstream call failed; returning empty page",
      );
      return { items: [] } as UpstreamEntitiesPayload;
    });
    const items = normalizeRows(pickRows(upstream));
    const total = pickTotal(upstream, items.length);
    return c.json({ items, page, pageSize, total }, 200);
  }

  // Aggregate per-company state. We pick the worst observed state
  // (failed > skipped > completed) and the latest errorMessage +
  // updatedAt for that bucket.
  const rowsRes = await pool.query<{
    companyId: string;
    state: string;
    errorMessage: string | null;
    updatedAt: Date;
  }>(
    `SELECT DISTINCT ON ("companyId")
       "companyId",
       state,
       "errorMessage",
       "updatedAt"
     FROM "EntityProgress"
     WHERE "transactionId" = $1
     ORDER BY "companyId",
       CASE state
         WHEN 'failed' THEN 0
         WHEN 'skipped' THEN 1
         WHEN 'completed' THEN 2
         ELSE 3
       END,
       "updatedAt" DESC
     LIMIT $2 OFFSET $3`,
    [transactionId, pageSize, offset],
  );

  // Conform to EntityTransactionShape — same envelope the legacy
  // upstream produced. Fields the gateway-side EntityProgress
  // doesn't track yet (id, finishedAt) are synthesized: id from
  // (transactionId, companyId), finishedAt from updatedAt for
  // terminal states.
  const items = rowsRes.rows.map((r) => {
    const updatedAt =
      r.updatedAt instanceof Date
        ? r.updatedAt.toISOString()
        : String(r.updatedAt);
    const stateNarrow: "completed" | "failed" | "skipped" | "pending" | "in_progress" =
      r.state === "completed" ||
      r.state === "failed" ||
      r.state === "skipped" ||
      r.state === "in_progress" ||
      r.state === "pending"
        ? r.state
        : "pending";
    const isTerminal =
      stateNarrow === "completed" ||
      stateNarrow === "failed" ||
      stateNarrow === "skipped";
    return {
      id: `${transactionId}:${r.companyId}`,
      transactionId,
      companyId: r.companyId,
      state: stateNarrow,
      finishedAt: isTerminal ? updatedAt : null,
      createdAt: updatedAt,
      updatedAt,
    };
  });

  return c.json({ items, page, pageSize, total: localTotal }, 200);
});

// ---- GET /v1/transactions/:transactionId/entities/:companyId ---------------

const entityDetailRoute = createRoute({
  method: "get",
  path: "/transactions/{transactionId}/entities/{companyId}",
  tags: [tag],
  summary: "Get one entity's state in a transaction",
  request: { params: TransactionEntityParams },
  responses: {
    200: { content: { "application/json": { schema: EntityTransactionShape } }, description: "entity" },
    ...errorResponses,
  },
});

transactionsRouter.openapi(entityDetailRoute, async (c) => {
  const { transactionId, companyId } = c.req.valid("param");

  await assertTransactionOwnershipById(c, transactionId);

  // Upstream has no direct (txn, company) lookup; pull a large entities page
  // and filter. TODO upstream: add /api/v1/transactions/:tid/entities/:cid.
  // Cached per request — the errors route would re-fetch the same page.
  const entities = await getTransactionEntitiesAll(c, transactionId);

  const match = entities.find(
    (e) => (e as { companyId?: unknown }).companyId === companyId,
  ) as z.infer<typeof EntityTransactionShape> | undefined;
  if (!match) {
    throw new HTTPException(404, { message: "not_found" });
  }
  return c.json(match, 200);
});

// ---- GET /v1/transactions/:transactionId/errors ----------------------------

const errorsRoute = createRoute({
  method: "get",
  path: "/transactions/{transactionId}/errors",
  tags: [tag],
  summary: "List processing errors in a transaction (W5)",
  request: { params: TransactionIdParam },
  responses: {
    200: {
      content: { "application/json": { schema: z.object({ items: z.array(ProcessingErrorShape) }) } },
      description: "errors",
    },
    ...errorResponses,
  },
});

transactionsRouter.openapi(errorsRoute, async (c) => {
  const { transactionId } = c.req.valid("param");

  await assertTransactionOwnershipById(c, transactionId);

  // Each LLM producer keeps its OWN processing-errors table and only
  // exposes per-(transactionId, companyId) lookup. So we have to fan out
  // across every producer × every company that producer knows about. The
  // earlier implementation only queried `companyProfile`, which made
  // structured-content / website / contact / publication / evaluation
  // failures invisible — the Desktop UI would render "FEHLER (0)" while a
  // red dot was sitting in another column.
  //
  // To avoid a 6×N+1-style fetch storm, we first ask each producer for its
  // entities list (one call per producer = 6 in parallel), then fan out
  // errors-per-company *per producer* using only the companies that
  // producer actually knows. Each error row is stamped with both
  // `companyId` (defensive) and `service` (the producer key) so the
  // Desktop-App can group + label without a second lookup. TODO upstream:
  // expose /api/v1/processing-errors/transactions/:tid on each producer.
  const producerWork = await Promise.all(
    STAGE_UPSTREAMS.map(async ({ stage, upstream, producer }) => {
      // §8.v3 — local stages: synthesize errors from EntityProgress
      // rows where state='failed'. The legacy "fan-out per company"
      // dance was needed because producers each had their own per-
      // (txn, company) processing-errors table; with EntityProgress
      // we have a single SELECT per stage.
      if (producer) {
        const pool = getGatewayPool();
        const res = await pool.query<{
          companyId: string;
          errorMessage: string | null;
          updatedAt: Date;
        }>(
          `SELECT "companyId", "errorMessage", "updatedAt"
           FROM "EntityProgress"
           WHERE "transactionId" = $1
             AND producer = $2
             AND state = 'failed'`,
          [transactionId, producer],
        );
        return res.rows.map((r) => ({
          id: `${transactionId}:${producer}:${r.companyId}`,
          transactionId,
          companyId: r.companyId,
          service: stage,
          errorMessage: r.errorMessage ?? "",
          createdAt:
            r.updatedAt instanceof Date
              ? r.updatedAt.toISOString()
              : String(r.updatedAt),
        })) as Array<Record<string, unknown>>;
      }

      // Fly stage — keep legacy per-company fan-out until the producer
      // localizes.
      let entities: Array<Record<string, unknown>>;
      try {
        const res = await callUpstream<UpstreamEntitiesPayload>(
          c,
          upstream,
          `/api/v1/transactions/${encodeURIComponent(transactionId)}/entities`,
          { query: { pageNumber: 1, pageSize: 10000 } },
        );
        entities = normalizeRows(pickRows(res)) as Array<Record<string, unknown>>;
      } catch (err) {
        logger.warn(
          { err, stage, upstream, transactionId, requestId: c.get("requestId") },
          "errors fan-out: producer entities call failed",
        );
        return [] as Array<Record<string, unknown>>;
      }

      const companies = Array.from(
        new Set(
          entities
            .map((e) => (e as { companyId?: unknown }).companyId)
            .filter((id): id is string => typeof id === "string"),
        ),
      );

      const rows = await Promise.all(
        companies.map(async (companyId) => {
          try {
            const list = await callUpstream<unknown>(
              c,
              upstream,
              `/api/v1/processing-errors/transactions/${encodeURIComponent(transactionId)}/companies/${encodeURIComponent(companyId)}`,
            );
            const arr = (Array.isArray(list)
              ? list
              : ((list as { items?: unknown[] })?.items ?? [])) as Array<Record<string, unknown>>;
            // Spread upstream first, then overwrite companyId/service so the
            // gateway-stamped values win even if an upstream row is missing
            // them.
            return arr.map((row) => ({ ...row, companyId, service: stage }));
          } catch (err) {
            logger.warn(
              { err, stage, transactionId, companyId, requestId: c.get("requestId") },
              "errors fan-out: single (producer, company) failed",
            );
            return [];
          }
        }),
      );
      return rows.flat();
    }),
  );

  return c.json(
    { items: producerWork.flat() as Array<z.infer<typeof ProcessingErrorShape>> },
    200,
  );
});

// ---- GET /v1/transactions/:transactionId/pipeline --------------------------
//
// Cross-producer state matrix (DESKTOP_DATA_FLOW.md §6.1). Fans out to every
// LLM producer's `/api/v1/transactions/:tid/entities` in parallel, unions the
// companyIds across all six lists, and projects each company × stage cell.
//
// master-data is derived: any company that appears in any downstream is
// trivially "completed" upstream-of-master-data (the per-company AMQP
// upsert event already fanned out). Master-data has no per-row table.
//
// Per-stage failure is best-effort: an upstream call that errors is added to
// `unavailableStages` and its column is filled with `state: "pending"`. The
// matrix still returns rather than 502'ing, because partial info is better
// than none for a pipeline status view.

// Upstream LLM producers (structured-content, company-profile, …) historically
// shipped their `/api/v1/transactions/:tid/entities` payload with the array
// keyed as `transactions` and the row state as the raw DB enum
// ("DONE" | "ERROR" | "IN_PROGRESS" | "INTERIM"). The gateway's response shape
// is normalized to `items[]` with lowercase state (`EntityTransactionShape`),
// so we coerce at this boundary.
//
// Without this normalization:
//   - `entityTransactions ?? items` returned `[]` for every stage (the rows
//     are under `transactions`), so the pipeline matrix and `/entities`
//     proxy reported every cell as "pending" forever — even though upstream
//     had already finished the work.
//   - Even if the rows were picked up, the uppercase state would either fail
//     the response Zod schema or render as an unknown badge in the desktop UI.
//
// Keep this mapper additive: if a future producer emits already-lowercase
// states, `STATE_MAP[s] ?? s` falls through unchanged.

const UPSTREAM_STATE_MAP: Record<string, z.infer<typeof EntityTransactionShape>["state"]> = {
  IN_PROGRESS: "in_progress",
  DONE: "completed",
  ERROR: "failed",
  INTERIM: "in_progress",
};

interface UpstreamEntitiesPayload {
  entityTransactions?: unknown[];
  items?: unknown[];
  transactions?: unknown[];
  count?: number;
  total?: number;
}

function pickRows(payload: UpstreamEntitiesPayload | null | undefined): unknown[] {
  return (
    payload?.entityTransactions ??
    payload?.items ??
    payload?.transactions ??
    []
  );
}

function pickTotal(
  payload: UpstreamEntitiesPayload | null | undefined,
  fallback: number,
): number {
  return payload?.count ?? payload?.total ?? fallback;
}

function normalizeRow(
  raw: unknown,
): z.infer<typeof EntityTransactionShape> | null {
  if (!raw || typeof raw !== "object") return null;
  const r = raw as Record<string, unknown>;
  const state = typeof r.state === "string" ? r.state : "";
  const mappedState = UPSTREAM_STATE_MAP[state] ?? state;
  return {
    // Some upstreams (structured-content) emit numeric ids; the gateway's
    // contract is string. Coerce so the response validates.
    id: r.id != null ? String(r.id) : "",
    transactionId: r.transactionId != null ? String(r.transactionId) : "",
    companyId: r.companyId != null ? String(r.companyId) : "",
    state: mappedState as z.infer<typeof EntityTransactionShape>["state"],
    finishedAt:
      typeof r.finishedAt === "string"
        ? r.finishedAt
        : r.finishedAt === null
          ? null
          : undefined,
    createdAt: typeof r.createdAt === "string" ? r.createdAt : "",
    updatedAt: typeof r.updatedAt === "string" ? r.updatedAt : "",
  };
}

function normalizeRows(
  raw: unknown[],
): Array<z.infer<typeof EntityTransactionShape>> {
  const out: Array<z.infer<typeof EntityTransactionShape>> = [];
  for (const r of raw) {
    const n = normalizeRow(r);
    if (n) out.push(n);
  }
  return out;
}

// §8.v3 — per-stage entity sourcing.
//
// Localized stages: read from gateway's EntityProgress table (MPG)
// directly; the persist-bus writes one row per company per producer
// on every persist event, so "what did this stage do for transaction
// X?" is a single SELECT.
//
// Fly stages: still call the legacy upstream's
// `/api/v1/transactions/:tid/entities` endpoint until those producers
// localize (company-evaluation + company-contact). When they migrate
// the `producer` column flips to populated and the upstream entry
// can be deleted.
//
// `producer` matches the kebab-case PRODUCER_NAMES key the persist-bus
// writes to EntityProgress.producer; `null` marks "still on fly,
// upstream call required".
const STAGE_UPSTREAMS: Array<{
  stage: Exclude<z.infer<typeof PipelineStage>, "masterData">;
  upstream: UpstreamName;
  producer: string | null;
}> = [
  { stage: "structuredContent", upstream: "structuredContent", producer: "structured-content" },
  { stage: "companyPublication", upstream: "companyPublication", producer: "company-publication" },
  { stage: "website", upstream: "website", producer: "website" },
  { stage: "companyProfile", upstream: "companyProfile", producer: "company-profile" },
  { stage: "companyContact", upstream: "companyContact", producer: "company-contact" },
  { stage: "companyEvaluation", upstream: "companyEvaluation", producer: "company-evaluation" },
];

/**
 * Load the entity list for a given (stage, transactionId). Local stages
 * read from EntityProgress; fly stages still fall through to the
 * upstream call.
 *
 * Shape returned matches `EntityTransactionShape` (the format the
 * downstream fan-out logic expects). For local stages we synthesize
 * `id`/`createdAt`/`finishedAt` from the EntityProgress row.
 */
async function loadStageEntities(
  c: Context,
  transactionId: string,
  upstream: UpstreamName,
  producer: string | null,
): Promise<Array<z.infer<typeof EntityTransactionShape>>> {
  if (producer) {
    // Local stage — read from EntityProgress.
    const pool = getGatewayPool();
    const res = await pool.query<{
      companyId: string;
      state: string;
      errorMessage: string | null;
      updatedAt: Date;
    }>(
      `SELECT "companyId", state, "errorMessage", "updatedAt"
       FROM "EntityProgress"
       WHERE "transactionId" = $1 AND producer = $2`,
      [transactionId, producer],
    );
    return res.rows.map((r) => {
      const updatedAt =
        r.updatedAt instanceof Date
          ? r.updatedAt.toISOString()
          : String(r.updatedAt);
      const stateNarrow: z.infer<typeof EntityTransactionShape>["state"] =
        r.state === "completed" ||
        r.state === "failed" ||
        r.state === "skipped" ||
        r.state === "in_progress" ||
        r.state === "pending"
          ? r.state
          : "pending";
      const isTerminal =
        stateNarrow === "completed" ||
        stateNarrow === "failed" ||
        stateNarrow === "skipped";
      return {
        id: `${transactionId}:${producer}:${r.companyId}`,
        transactionId,
        companyId: r.companyId,
        state: stateNarrow,
        finishedAt: isTerminal ? updatedAt : null,
        createdAt: updatedAt,
        updatedAt,
      };
    });
  }
  // Fly stage — upstream call.
  const res = await callUpstream<UpstreamEntitiesPayload>(
    c,
    upstream,
    `/api/v1/transactions/${encodeURIComponent(transactionId)}/entities`,
    { query: { pageNumber: 1, pageSize: 10000 } },
  );
  return normalizeRows(pickRows(res)) as Array<
    z.infer<typeof EntityTransactionShape>
  >;
}

const ALL_STAGES: Array<z.infer<typeof PipelineStage>> = [
  "masterData",
  "structuredContent",
  "companyPublication",
  "website",
  "companyProfile",
  "companyContact",
  "companyEvaluation",
];

const pipelineRoute = createRoute({
  method: "get",
  path: "/transactions/{transactionId}/pipeline",
  tags: [tag],
  summary: "Per-company × per-stage state matrix (W3)",
  description: [
    "Returns one row per company in the transaction with one cell per pipeline",
    "stage. Built by fan-out across all six LLM producers' `/entities` lists.",
    "",
    "Use this as the snapshot view alongside the live SSE stream",
    "(`/transactions/:transactionId/events`): the matrix gives state at request",
    "time, the SSE stream applies live deltas onto it.",
  ].join("\n"),
  request: { params: TransactionIdParam },
  responses: {
    200: {
      content: { "application/json": { schema: PipelineShape } },
      description: "pipeline matrix",
    },
    ...errorResponses,
  },
});

type CellState = z.infer<typeof PipelineCellShape>["state"];
type EntityRow = z.infer<typeof EntityTransactionShape>;

transactionsRouter.openapi(pipelineRoute, async (c) => {
  const { transactionId } = c.req.valid("param");

  await assertTransactionOwnershipById(c, transactionId);

  // Fan out to every producer in parallel. Each producer exposes
  // `/api/v1/transactions/:tid/entities` (Phase 1 normalization). Use
  // pageSize=10000 — typical excel-import transactions are ≤ a few hundred
  // companies; if this ever exceeds 10k we add cursoring.
  const fanOut = await Promise.all(
    STAGE_UPSTREAMS.map(async ({ stage, upstream, producer }) => {
      try {
        const items = (await loadStageEntities(
          c,
          transactionId,
          upstream,
          producer,
        )) as EntityRow[];
        return { stage, available: true as const, items };
      } catch (err) {
        // Don't poison the whole matrix — log and mark the stage unavailable.
        logger.warn(
          {
            err,
            stage,
            upstream,
            producer,
            transactionId,
            requestId: c.get("requestId"),
          },
          "pipeline fan-out: stage entities load failed",
        );
        return { stage, available: false as const, items: [] as EntityRow[] };
      }
    }),
  );

  const unavailableStages = fanOut.filter((f) => !f.available).map((f) => f.stage);

  // stage -> Map<companyId, EntityRow> for O(1) lookup when projecting cells.
  const byStage = new Map<string, Map<string, EntityRow>>();
  for (const f of fanOut) {
    const m = new Map<string, EntityRow>();
    for (const row of f.items) {
      if (typeof row?.companyId === "string") m.set(row.companyId, row);
    }
    byStage.set(f.stage, m);
  }

  // Union of companyIds across all stages — the row set for the matrix.
  const allCompanyIds = new Set<string>();
  for (const m of byStage.values()) for (const id of m.keys()) allCompanyIds.add(id);

  const cellFromRow = (row: EntityRow | undefined): z.infer<typeof PipelineCellShape> => {
    if (!row) {
      return { state: "pending" as CellState, errorCount: 0 };
    }
    return {
      state: row.state,
      updatedAt: row.updatedAt ?? row.finishedAt ?? null,
      errorCount: row.state === "failed" ? 1 : 0,
    };
  };

  type Cell = z.infer<typeof PipelineCellShape>;
  const rows = Array.from(allCompanyIds).map((companyId) => {
    const cells: {
      masterData: Cell;
      structuredContent: Cell;
      companyPublication: Cell;
      website: Cell;
      companyProfile: Cell;
      companyContact: Cell;
      companyEvaluation: Cell;
    } = {
      // master-data is derived: appearing in any downstream stage proves its
      // upstream upsert event fanned out successfully for this company.
      masterData: { state: "completed" as CellState, errorCount: 0 },
      structuredContent: cellFromRow(byStage.get("structuredContent")?.get(companyId)),
      companyPublication: cellFromRow(byStage.get("companyPublication")?.get(companyId)),
      website: cellFromRow(byStage.get("website")?.get(companyId)),
      companyProfile: cellFromRow(byStage.get("companyProfile")?.get(companyId)),
      companyContact: cellFromRow(byStage.get("companyContact")?.get(companyId)),
      companyEvaluation: cellFromRow(byStage.get("companyEvaluation")?.get(companyId)),
    };
    // Most-recent activity across cells for sort order.
    const timestamps = Object.values(cells)
      .map((cell) => cell.updatedAt)
      .filter((t): t is string => typeof t === "string");
    const lastActivityAt =
      timestamps.length > 0
        ? timestamps.reduce((a, b) => (a > b ? a : b))
        : null;
    return { companyId, cells, lastActivityAt };
  });

  // Sort newest-first so freshly-progressing companies surface at the top.
  rows.sort((a, b) => {
    const aT = a.lastActivityAt ?? "";
    const bT = b.lastActivityAt ?? "";
    if (aT === bT) return a.companyId.localeCompare(b.companyId);
    return bT.localeCompare(aT);
  });

  return c.json(
    {
      transactionId,
      totalCompanies: rows.length,
      stages: ALL_STAGES,
      unavailableStages,
      rows,
    },
    200,
  );
});

// ---- POST /v1/transactions/:tid/entities/:cid/retry ------------------------
//
// Per-stage retry (DESKTOP_DATA_FLOW.md §6.2). Maps the requested stage to
// the producer service(s) that own its trigger event(s) and republishes.
// Each producer's `/api/v1/transactions/:tid/retry` reads its own persisted
// row and re-emits the AMQP event so the downstream consumer re-runs.
//
// `companyEvaluation` retry fans out across all 5 LLM producers — each one
// republishes its own slice of the evaluation event family in parallel.
// Partial success returns 207-like semantics in-band: `ok` per dispatch
// + an aggregate `ok = true` only if every dispatch succeeded.

const RetryParams = TransactionEntityParams; // { transactionId, companyId }

// §8.v3 Phase 1.5 — each retry target is either:
//   - kind="upstream": still goes through fly via callUpstream (used for
//     master-data, which is fly-permanent, plus the two un-localized
//     producers companyContact / companyEvaluation that publish
//     evaluation slices we haven't ported yet).
//   - kind="gateway": gateway publishes the AMQP event directly via
//     lib/retry-publish.ts. This is the path for the four localized
//     producers' retry slices.
//
// Once company-evaluation + company-contact localize (Phase 2/3) and
// their slices port into retry-publish.ts, every entry flips to
// kind="gateway" except the masterData ones — which is what makes
// destroying the localized fly apps in Phase 4 safe.
type RetryTarget =
  | { kind: "upstream"; upstream: UpstreamName; stage: string }
  | {
      kind: "gateway";
      producer:
        | "structured-content"
        | "website"
        | "company-profile"
        | "company-publication"
        | "company-contact";
      stage: string;
    };

const RETRY_DISPATCH: Record<z.infer<typeof RetryStage>, RetryTarget[]> = {
  // Master-data owns both downstream-of-master-data slices.
  structuredContent: [{ kind: "upstream", upstream: "masterData", stage: "structuredContent" }],
  companyPublication: [{ kind: "upstream", upstream: "masterData", stage: "companyPublication" }],
  // Structured-content drives website. Now gateway-side via retry-publish.
  website: [{ kind: "gateway", producer: "structured-content", stage: "website" }],
  // company-profile is fed by website (url-based) AND structured-content
  // (business-purpose-based). Republish both inputs so company-profile
  // re-runs and idempotently merges.
  companyProfile: [
    { kind: "gateway", producer: "website", stage: "companyProfile" },
    { kind: "gateway", producer: "structured-content", stage: "companyProfile" },
  ],
  // company-contact is fed by website only.
  companyContact: [{ kind: "gateway", producer: "website", stage: "companyContact" }],
  // Evaluation fan-out: each producer republishes the slice it owns.
  // companyContact + companyEvaluation are still fly-side until Phase 2/3,
  // so their slices keep hitting upstream.
  companyEvaluation: [
    { kind: "gateway", producer: "structured-content", stage: "companyEvaluation" },
    { kind: "gateway", producer: "company-publication", stage: "companyEvaluation" },
    { kind: "gateway", producer: "website", stage: "companyEvaluation" },
    { kind: "gateway", producer: "company-profile", stage: "companyEvaluation" },
    { kind: "gateway", producer: "company-contact", stage: "companyEvaluation" },
  ],
};

const retryRoute = createRoute({
  method: "post",
  path: "/transactions/{transactionId}/entities/{companyId}/retry",
  tags: [tag],
  summary: "Retry a pipeline stage for a single company (W3)",
  description: [
    "Republishes the AMQP trigger event(s) for the given (transaction,",
    "company, stage) so the downstream consumer re-runs. The gateway maps",
    "stage → producer(s); the producers read their own persisted rows and",
    "re-emit. `companyEvaluation` fans out across all 5 LLM producers.",
  ].join("\n"),
  request: {
    params: RetryParams,
    body: {
      content: { "application/json": { schema: RetryStageBody } },
      required: true,
    },
  },
  responses: {
    202: {
      content: { "application/json": { schema: RetryStageResultShape } },
      description: "retry dispatched",
    },
    ...errorResponses,
  },
});

transactionsRouter.openapi(retryRoute, async (c) => {
  const { transactionId, companyId } = c.req.valid("param");
  const { stage, companyName } = c.req.valid("json");

  await assertTransactionOwnershipById(c, transactionId);

  const targets = RETRY_DISPATCH[stage];
  const requestSource = c.req.url;
  const dispatched = await Promise.all(
    targets.map(async (target) => {
      const producerStage = target.stage;
      try {
        if (target.kind === "upstream") {
          const body: Record<string, unknown> = {
            companyId,
            stage: producerStage,
          };
          if (companyName !== undefined) body.companyName = companyName;
          const res = await callUpstream<unknown>(
            c,
            target.upstream,
            `/api/v1/transactions/${encodeURIComponent(transactionId)}/retry`,
            { method: "POST", body },
          );
          return {
            upstream: target.upstream,
            stage: producerStage,
            ok: true,
            status: 202,
            body: res,
          };
        }
        // kind === "gateway" — call into retry-publish.ts. Each helper
        // throws HTTPException(404) when there's nothing to republish
        // (no persisted row); the catch block below converts that to
        // an `ok: false` dispatch result so the response surfaces it
        // alongside other targets' outcomes.
        let res: { published: number };
        switch (target.producer) {
          case "structured-content":
            res = await publishStructuredContentRetry({
              stage: producerStage as "website" | "companyProfile" | "companyEvaluation",
              transactionId,
              companyId,
              source: requestSource,
            });
            break;
          case "website":
            res = await publishWebsiteRetry({
              stage: producerStage as "companyProfile" | "companyContact" | "companyEvaluation",
              transactionId,
              companyId,
              companyName,
              source: requestSource,
            });
            break;
          case "company-profile":
            res = await publishCompanyProfileRetry({
              transactionId,
              companyId,
              source: requestSource,
            });
            break;
          case "company-publication":
            res = await publishCompanyPublicationRetry({
              transactionId,
              companyId,
              source: requestSource,
            });
            break;
          case "company-contact":
            res = await publishCompanyContactRetry({
              transactionId,
              companyId,
              source: requestSource,
            });
            break;
        }
        return {
          upstream: target.producer,
          stage: producerStage,
          ok: true,
          status: 202,
          body: res,
        };
      } catch (err) {
        const status =
          err instanceof HTTPException ? err.status : undefined;
        const message = err instanceof Error ? err.message : String(err);
        logger.warn(
          {
            err,
            target,
            stage,
            transactionId,
            companyId,
            requestId: c.get("requestId"),
          },
          "retry dispatch failed",
        );
        return {
          upstream: target.kind === "upstream" ? target.upstream : target.producer,
          stage: producerStage,
          ok: false,
          status,
          error: message,
        };
      }
    }),
  );

  const ok = dispatched.every((d) => d.ok);

  // Optimistic SSE: flip the requested stage's matrix cell to `in_progress`
  // immediately so the user sees their click register. The producer chain
  // emits the terminal completed/failed event later via AMQP through the
  // normal path. Without this, the cell sits on its prior failed state
  // until the user navigates away and back (the snapshot fetch on remount
  // is what was making the dot finally turn green). See DESKTOP_DATA_FLOW.md
  // §6.2.
  //
  // Only synthesize when at least one upstream accepted the dispatch. If
  // every producer 4xx'd, the row never starts running, so claiming
  // in_progress would lie to the client.
  if (dispatched.some((d) => d.ok)) {
    const auth = c.get("auth");
    transactionProgressBus.publishLocal({
      transactionId,
      tenantId: auth.tenantId,
      service: STAGE_TO_SERVICE[stage],
      companyId,
      // The published `@ava/event@1.1.38` types omit "in_progress"
      // (only completed/failed/skipped). The runtime accepts any
      // string and the gateway is the only consumer of this synthetic
      // event (re-emitted to SSE clients); cast through `as never` so
      // TS doesn't widen the union for downstream type-flow.
      state: "in_progress" as never,
      updatedAt: new Date().toISOString(),
    });
  }

  return c.json(
    { transactionId, companyId, stage, dispatched, ok },
    202,
  );
});

// Inverse of SERVICE_TO_STAGE on the renderer side. Kept here because the
// gateway is the only place that needs to translate "user-requested stage id"
// → "service field on the AMQP payload" without an AMQP round-trip; producers
// already know their own service name. If a new stage is added, both this
// map and the renderer's SERVICE_TO_STAGE must be updated.
const STAGE_TO_SERVICE: Record<z.infer<typeof RetryStage>, string> = {
  structuredContent: "structured-content",
  companyPublication: "company-publication",
  website: "website",
  companyProfile: "company-profile",
  companyContact: "company-contact",
  companyEvaluation: "company-evaluation",
};

// ---- Per-request cache + ownership helpers ---------------------------------
//
// Transactions are tenant-scoped (Q1). Verify the JWT's actor (`sub`) owns
// the transaction before returning detail/entity/errors data. Upstream's
// `/api/v1/users/transactions` is the source of truth for ownership today.
//
// Several handlers re-fetch the same upstream pages (the user's transaction
// list, or the 1000-row entities page). We memoize those calls on the Hono
// `Context` so within one inbound request they hit upstream at most once.
// Different inbound requests do not share — each one has a fresh context, so
// the freshness contract is "as fresh as the start of the request", which is
// what we want for a per-request ownership/snapshot read.

type RequestCache = Map<string, Promise<unknown>>;

function reqCache(c: Context): RequestCache {
  let m = c.get("v1TxCache") as RequestCache | undefined;
  if (!m) {
    m = new Map();
    c.set("v1TxCache", m);
  }
  return m;
}

function memoize<T>(c: Context, key: string, fn: () => Promise<T>): Promise<T> {
  const m = reqCache(c);
  let p = m.get(key) as Promise<T> | undefined;
  if (!p) {
    p = fn();
    m.set(key, p);
  }
  return p;
}

interface UpstreamTransaction {
  id?: string;
  transactionId?: string;
  userId?: string;
}

async function getMyTransactions(c: Context): Promise<UpstreamTransaction[]> {
  return memoize(c, "users/transactions", async () => {
    // §8.v3 — master-data is now the single source of truth for the
    // user-owned transaction list. Each Excel import / single-company
    // dispatch creates a row in master-data's `Transaction` table
    // with `userId = JWT actor`. The legacy `companyProfile` upstream
    // we used to call only had transactions that the (now-suspended)
    // fly company-profile producer wrote to its own DB — empty for
    // anything dispatched after the §8.v3 cutover, so ownership
    // checks were 403'ing every recent transaction.
    //
    // Master-data's response shape is paginated:
    //   { count, transactions: [...], hasNextPage, ... }
    // We pull `.transactions` and ignore pagination — the per-request
    // memoize wrapper means we only fetch this once per inbound
    // request, and the page-1 default of 10 is enough for ownership
    // verification of any transactionId the user is asking about
    // (chat tools always send a recent id).
    const list = await callUpstream<unknown>(
      c,
      "masterData",
      "/api/v1/transactions/users/user",
      { query: { pageNumber: 1, pageSize: 50 } },
    );
    if (Array.isArray(list)) return list as UpstreamTransaction[];
    const obj = list as { transactions?: unknown[]; items?: unknown[] };
    return (obj.transactions ?? obj.items ?? []) as UpstreamTransaction[];
  });
}

async function getTransactionEntitiesAll(
  c: Context,
  transactionId: string,
): Promise<Array<Record<string, unknown>>> {
  return memoize(c, `entities-all:${transactionId}`, async () => {
    // §8.v3 — read from EntityProgress directly. The single (txn, company)
    // lookup that calls this (entityDetailRoute) is satisfied by the
    // distinct companies present in EntityProgress, regardless of which
    // producer wrote them. Fall back to the legacy companyProfile upstream
    // so pre-§8.v3 transactions still resolve.
    const pool = getGatewayPool();
    const localRes = await pool.query<{
      companyId: string;
      state: string;
      errorMessage: string | null;
      updatedAt: Date;
    }>(
      `SELECT DISTINCT ON ("companyId")
         "companyId", state, "errorMessage", "updatedAt"
       FROM "EntityProgress"
       WHERE "transactionId" = $1
       ORDER BY "companyId",
         CASE state
           WHEN 'failed' THEN 0
           WHEN 'skipped' THEN 1
           WHEN 'completed' THEN 2
           ELSE 3
         END,
         "updatedAt" DESC`,
      [transactionId],
    );
    if ((localRes.rowCount ?? 0) > 0) {
      return localRes.rows.map((r) => {
        const updatedAt =
          r.updatedAt instanceof Date
            ? r.updatedAt.toISOString()
            : String(r.updatedAt);
        return {
          id: `${transactionId}:${r.companyId}`,
          transactionId,
          companyId: r.companyId,
          state: r.state,
          finishedAt: updatedAt,
          createdAt: updatedAt,
          updatedAt,
        };
      });
    }
    // Legacy fallback for pre-§8.v3 transactions.
    const upstream = await callUpstream<UpstreamEntitiesPayload>(
      c,
      "companyProfile",
      `/api/v1/transactions/${encodeURIComponent(transactionId)}/entities`,
      { query: { pageNumber: 1, pageSize: 1000 } },
    ).catch(() => ({ items: [] }) as UpstreamEntitiesPayload);
    return normalizeRows(pickRows(upstream)) as Array<Record<string, unknown>>;
  });
}

async function assertTransactionOwnership(
  c: Context,
  txn: Record<string, unknown>,
): Promise<void> {
  const actorId = c.get("auth").actorId;
  const owner = (txn as UpstreamTransaction).userId;
  if (!owner) {
    // Defensive: if upstream doesn't surface userId, fall back to listing.
    const txnId = ((txn as UpstreamTransaction).id ?? (txn as UpstreamTransaction).transactionId) as
      | string
      | undefined;
    if (!txnId) throw new HTTPException(404, { message: "not_found" });
    return assertTransactionOwnershipById(c, txnId);
  }
  if (owner !== actorId) {
    throw new HTTPException(403, { message: "forbidden" });
  }
}

async function assertTransactionOwnershipById(
  c: Context,
  transactionId: string,
): Promise<void> {
  const all = await getMyTransactions(c);
  const owns = all.some(
    (t) => t.id === transactionId || t.transactionId === transactionId,
  );
  if (!owns) {
    throw new HTTPException(403, { message: "forbidden" });
  }
}

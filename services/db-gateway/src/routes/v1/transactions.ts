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
  RetryQueueItem,
  RetryQueueResponse,
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
        return res.rows.map((r) => {
          const ts =
            r.updatedAt instanceof Date
              ? r.updatedAt.toISOString()
              : String(r.updatedAt);
          // Field name `errorReason` matches the gateway's
          // ProcessingErrorShape (schemas.ts) and the desktop's
          // ProcessingError type. The DB column is `errorMessage`
          // (EntityProgress.errorMessage); rename at the API
          // boundary so the renderer's `e.errorReason ?? ...`
          // chain doesn't silently fall through to the
          // "(kein Grund angegeben)" fallback.
          return {
            id: `${transactionId}:${producer}:${r.companyId}`,
            transactionId,
            companyId: r.companyId,
            service: stage,
            errorReason: r.errorMessage ?? "",
            createdAt: ts,
            updatedAt: ts,
          };
        }) as Array<Record<string, unknown>>;
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

  // v0.1.118 — fetch retry counters for every (companyId, producer) row
  // tied to this transaction. Single SELECT, results indexed by
  // (producer, companyId) for O(1) cell-build lookup below. Best-effort:
  // a failure here just leaves the new fields undefined on cells (the
  // renderer treats undefined as pre-v0.1.118 / no retry state).
  type RetryRow = {
    producer: string;
    companyId: string;
    attempts: number;
    nextRetryAt: Date | null;
    giveUpAt: Date | null;
  };
  const retryByKey = new Map<
    string,
    { attempts: number; nextRetryAt: string | null; giveUpAt: string | null }
  >();
  try {
    const pool = getGatewayPool();
    const res = await pool.query<RetryRow>(
      `SELECT producer, "companyId", "attempts", "nextRetryAt", "giveUpAt"
       FROM "EntityProgress"
       WHERE "transactionId" = $1`,
      [transactionId],
    );
    for (const r of res.rows) {
      retryByKey.set(`${r.producer}:${r.companyId}`, {
        attempts: r.attempts ?? 0,
        nextRetryAt: r.nextRetryAt ? r.nextRetryAt.toISOString() : null,
        giveUpAt: r.giveUpAt ? r.giveUpAt.toISOString() : null,
      });
    }
  } catch (err) {
    logger.warn(
      { err, transactionId },
      "pipeline: retry-counters fetch failed — falling back to undefined",
    );
  }

  /** Map a stage id (camelCase, as used by the matrix) to the producer
   *  name (kebab) we use as the EntityProgress.producer key. Only
   *  stages with a real producer have retry counters; derived cells
   *  (masterData, companyEvaluation) get no augmentation. */
  const STAGE_TO_PRODUCER_NAME: Partial<Record<string, string>> = {
    structuredContent: "structured-content",
    companyPublication: "company-publication",
    website: "website",
    companyProfile: "company-profile",
    companyContact: "company-contact",
  };
  const attachRetry = (
    stage: string,
    companyId: string,
    cell: z.infer<typeof PipelineCellShape>,
  ): z.infer<typeof PipelineCellShape> => {
    const producerName = STAGE_TO_PRODUCER_NAME[stage];
    if (!producerName) return cell;
    const r = retryByKey.get(`${producerName}:${companyId}`);
    if (!r) return cell;
    return {
      ...cell,
      attempts: r.attempts,
      nextRetryAt: r.nextRetryAt,
      giveUpAt: r.giveUpAt,
    };
  };

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

  // v0.1.106 — companyEvaluation is a DERIVED cell.
  //
  // Why: companyEvaluation has no compute of its own under the new
  // localized pipeline — its compute-worker is a fan-in normaliser
  // that re-emits per-slice persist events from 8 upstream signals.
  // In practice only a subset of those signals actually fires under
  // the current compute path (structured-content, company-profile,
  // company-publication, website). The seed-EntityProgress path
  // creates a `pending` row for company-evaluation up front; if any
  // expected upstream completes but the evaluation slice flow stalls,
  // the cell would stay yellow forever.
  //
  // Fix (variant c — surgical config change, no producer / schema
  // edits): derive the companyEvaluation cell from its upstream set
  // {structuredContent, companyPublication, website, companyProfile,
  // companyContact}. Rule:
  //   - If ANY upstream cell is in_progress  → in_progress
  //   - Else if ALL upstreams in terminal    → completed
  //     (failed/skipped on an upstream don't block evaluation —
  //     evaluation can run with whichever slices arrived; the agent's
  //     downstream consumers tolerate partial data)
  //   - Else if at least one upstream completed → in_progress
  //   - Else pending
  // The recorded EntityProgress row from the gateway persist-bus is
  // ignored here (still written for audit trail / SSE compatibility).
  const EVAL_UPSTREAMS = [
    "structuredContent",
    "companyPublication",
    "website",
    "companyProfile",
    "companyContact",
  ] as const;
  const deriveEvaluationCell = (companyId: string): Cell => {
    const upstreams = EVAL_UPSTREAMS.map((s) =>
      cellFromRow(byStage.get(s)?.get(companyId)),
    );
    if (upstreams.some((u) => u.state === "in_progress")) {
      const ts = upstreams
        .map((u) => u.updatedAt)
        .filter((t): t is string => typeof t === "string");
      return {
        state: "in_progress",
        updatedAt: ts.length > 0 ? ts.reduce((a, b) => (a > b ? a : b)) : null,
        errorCount: 0,
      };
    }
    const allTerminal = upstreams.every(
      (u) =>
        u.state === "completed" ||
        u.state === "failed" ||
        u.state === "skipped",
    );
    const anyCompleted = upstreams.some((u) => u.state === "completed");
    const ts = upstreams
      .map((u) => u.updatedAt)
      .filter((t): t is string => typeof t === "string");
    const lastTs =
      ts.length > 0 ? ts.reduce((a, b) => (a > b ? a : b)) : null;
    if (allTerminal && anyCompleted) {
      return { state: "completed", updatedAt: lastTs, errorCount: 0 };
    }
    if (anyCompleted) {
      return { state: "in_progress", updatedAt: lastTs, errorCount: 0 };
    }
    if (allTerminal) {
      // Every upstream failed/skipped — evaluation has nothing to
      // aggregate. Surface as skipped so the matrix is not stuck.
      return { state: "skipped", updatedAt: lastTs, errorCount: 0 };
    }
    return { state: "pending", errorCount: 0 };
  };

  // v0.1.363 — company-profile / company-contact werden nur dispatcht,
  // wenn die website-Stage eine URL gefunden hat. Lief sie terminal OHNE
  // Ergebnis (failed/skipped — Judge fand keine Webseite) und existiert
  // keine eigene EntityProgress-Zeile für die abhängige Stage, dann ist
  // ihr „echter" Zustand `skipped` (sie wird nie laufen) — nicht das
  // naive `pending`, das ewig gelb hängen bliebe.
  const deriveDependentOnWebsite = (
    stage: "companyProfile" | "companyContact",
    companyId: string,
    websiteCell: Cell,
  ): Cell => {
    const own = byStage.get(stage)?.get(companyId);
    if (own) return cellFromRow(own);
    if (websiteCell.state === "failed" || websiteCell.state === "skipped") {
      return {
        state: "skipped",
        updatedAt: websiteCell.updatedAt ?? null,
        errorCount: 0,
      };
    }
    return { state: "pending", errorCount: 0 };
  };

  const rows = Array.from(allCompanyIds).map((companyId) => {
    const websiteCell = attachRetry(
      "website",
      companyId,
      cellFromRow(byStage.get("website")?.get(companyId)),
    );
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
      structuredContent: attachRetry(
        "structuredContent",
        companyId,
        cellFromRow(byStage.get("structuredContent")?.get(companyId)),
      ),
      companyPublication: attachRetry(
        "companyPublication",
        companyId,
        cellFromRow(byStage.get("companyPublication")?.get(companyId)),
      ),
      website: websiteCell,
      // v0.1.363 — company-profile + company-contact hängen vom
      // website-URL-Treffer ab: der website-Producer dispatcht ihre
      // Trigger-Events nur, wenn eine URL gefunden wurde (`if (url)`).
      // Findet der LLM-Judge KEINE Unternehmenswebseite, läuft die
      // website-Stage auf `failed` (siehe persist-bus.ts) und es
      // entsteht NIE eine EntityProgress-Zeile für Profil/Kontakt → die
      // naive Zelle wäre für immer `pending` (der gemeldete „hängt ewig
      // gelb"-Bug). In genau diesem Fall leiten wir sie als `skipped`
      // ab, damit die Matrix terminal wird statt hängen zu bleiben.
      companyProfile: attachRetry(
        "companyProfile",
        companyId,
        deriveDependentOnWebsite("companyProfile", companyId, websiteCell),
      ),
      companyContact: attachRetry(
        "companyContact",
        companyId,
        deriveDependentOnWebsite("companyContact", companyId, websiteCell),
      ),
      companyEvaluation: deriveEvaluationCell(companyId),
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

// ---- GET /v1/transactions/retry-queue/pending ------------------------------
//
// v0.1.118 — heartbeat-driven auto-retry. The desktop's heartbeat tick
// polls this endpoint every ~10 minutes, sees which (transaction,
// company, producer) tuples have ripened past their `nextRetryAt`, and
// fires the existing per-stage retry endpoint for each. Priority order:
// fewer-attempts-first (so a one-off hiccup re-runs fast), then oldest-
// failure-first within the same attempt count.
//
// Tenant scoping: we don't have a tenantId column on EntityProgress
// (it inherits from the persist event chain, where tenantId comes from
// the upstream transaction). For now we filter via the caller's
// transactions-list — same ownership semantics as everywhere else —
// and let the caller hand back any rows for transactions it doesn't
// own. The MVP is single-user / per-machine so a cross-tenant leak
// would require both an attacker on the machine and a colliding
// transactionId; defensive scoping can land alongside multi-tenant
// hardening.

const RetryQueuePendingQuery = z.object({
  limit: z.coerce.number().int().min(1).max(100).default(20),
});

const retryQueueRoute = createRoute({
  method: "get",
  path: "/transactions/retry-queue/pending",
  tags: [tag],
  summary: "List failed producer cells due for auto-retry (v0.1.118)",
  description: [
    "Returns up to `limit` rows where state='failed', `giveUpAt` IS NULL,",
    "and `nextRetryAt` <= NOW(). Ordered by attempts ASC then",
    "`lastFailureAt` ASC so a fresh failure beats a chronic one. Filtered",
    "to the caller's owned transactions.",
  ].join("\n"),
  request: { query: RetryQueuePendingQuery },
  responses: {
    200: {
      content: { "application/json": { schema: RetryQueueResponse } },
      description: "rows due for retry",
    },
    ...errorResponses,
  },
});

transactionsRouter.openapi(retryQueueRoute, async (c) => {
  const { limit } = c.req.valid("query");
  const myTxns = await getMyTransactions(c);
  const myIds = Array.from(
    new Set(
      myTxns
        .map((t) => t.id ?? t.transactionId)
        .filter((id): id is string => typeof id === "string" && id.length > 0),
    ),
  );
  if (myIds.length === 0) {
    return c.json({ items: [] }, 200);
  }
  const pool = getGatewayPool();
  const res = await pool.query<{
    transactionId: string;
    companyId: string;
    producer: string;
    attempts: number;
    firstFailureAt: Date | null;
    lastFailureAt: Date | null;
  }>(
    // `nextRetryAt IS NULL` covers two cases: (a) failed rows from before
    // v0.1.118 when the column didn't exist, and (b) producers that didn't
    // populate it on a fresh failure. Treat NULL as "ripe now" so the
    // ticker re-enrolls them on the next 10-min slot instead of leaving
    // them stranded forever.
    `SELECT "transactionId", "companyId", producer, "attempts",
            "firstFailureAt", "lastFailureAt"
     FROM "EntityProgress"
     WHERE state = 'failed'
       AND "giveUpAt" IS NULL
       AND "paused" = false
       AND ("nextRetryAt" IS NULL OR "nextRetryAt" <= NOW())
       AND "transactionId" = ANY($1)
     ORDER BY "attempts" ASC, "lastFailureAt" ASC NULLS FIRST
     LIMIT $2`,
    [myIds, limit],
  );
  const items: z.infer<typeof RetryQueueItem>[] = res.rows.map((r) => ({
    transactionId: r.transactionId,
    companyId: r.companyId,
    producer: r.producer,
    attempts: r.attempts ?? 0,
    firstFailureAt: r.firstFailureAt ? r.firstFailureAt.toISOString() : null,
    lastFailureAt: r.lastFailureAt ? r.lastFailureAt.toISOString() : null,
  }));
  return c.json({ items }, 200);
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
  // v0.1.243 — Stellenanzeigen + Ausschreibungen sind Sub-Pipelines des
  // Website-Producers, die im AMQP-Compute-Worker mit-laufen (siehe
  // resources/producers/website/dist/application/integration-events/v1/
  // compute-worker.js ab v0.1.243). Wir re-triggern sie über denselben
  // structured-content-Republish wie `website` — der Producer macht
  // intern alles in einem Schritt. Eventuell-Optimierung: separates
  // Event nur für jobs / deep-research, dann ist ein gezielter
  // Refresh möglich ohne komplettes SERP+Website-Crawl.
  deepResearch: [{ kind: "gateway", producer: "structured-content", stage: "website" }],
  jobPostings: [{ kind: "gateway", producer: "structured-content", stage: "website" }],
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

  // v0.1.53 — per-user AMQP routing. Retry republishes need to land
  // on the same user's per-user queue the original dispatch did.
  // actorId from the JWT is the userId we suffix into the routing
  // key (see lib/per-user-routing.ts).
  const userId = c.get("auth").actorId;
  const targets = RETRY_DISPATCH[stage];
  const requestSource = c.req.url;

  // v0.1.193 — force-overwrite on manual retry.
  //
  // tierShouldWrite() in @ava/ai-provider refuses re-writes from the
  // persist-bus for ≤30-day-old non-LLM stages and same-or-lower-tier
  // LLM stages. That's right for involuntary re-runs (a dispatch storm
  // shouldn't reprocess every Bundesanzeiger PDF on the planet) but
  // wrong for explicit user action: clicking "Erneut versuchen" must
  // do exactly that, regardless of how fresh the cache row is.
  //
  // Solution: before we publish the retry trigger, clear the
  // ContentFreshness rows for every producer the retry targets. The
  // gate then sees `existingAgeMs = Infinity` and waves the next
  // persist through. Side-effect: the previous llmTier/llmModel
  // provenance is lost for those rows — that's intentional, since the
  // upcoming retry will overwrite them anyway and the user's
  // explicit "do it again" supersedes the cached audit trail.
  const producersToClear = new Set<string>();
  for (const t of targets) {
    if (t.kind === "gateway") {
      producersToClear.add(t.producer);
    } else {
      // upstream targets carry a camelCase `stage`; map it back to
      // the kebab-case producer name used in ContentFreshness.stage.
      const mapped = STAGE_TO_SERVICE[t.stage as z.infer<typeof RetryStage>];
      if (mapped) producersToClear.add(mapped);
    }
  }
  if (producersToClear.size > 0) {
    try {
      const pool = getGatewayPool();
      const res = await pool.query(
        `DELETE FROM "ContentFreshness"
         WHERE "companyId" = $1 AND stage = ANY($2::text[])`,
        [companyId, Array.from(producersToClear)],
      );
      logger.info(
        {
          companyId,
          stages: Array.from(producersToClear),
          rowsDeleted: res.rowCount ?? 0,
          requestId: c.get("requestId"),
        },
        "retry: cleared ContentFreshness rows to force-overwrite on next persist",
      );
    } catch (err) {
      // Best-effort: a freshness clear failure is not fatal. The
      // user's retry will dispatch anyway; worst case the tier-gate
      // skips again and we end up where we started. Logging it loud
      // so we notice if this becomes a chronic issue.
      logger.warn(
        {
          err: err instanceof Error ? err.message : String(err),
          companyId,
          stages: Array.from(producersToClear),
        },
        "retry: ContentFreshness clear failed; tier-gate may skip the upcoming persist",
      );
    }
  }

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
              userId,
            });
            break;
          case "website":
            res = await publishWebsiteRetry({
              stage: producerStage as "companyProfile" | "companyContact" | "companyEvaluation",
              transactionId,
              companyId,
              companyName,
              source: requestSource,
              userId,
            });
            break;
          case "company-profile":
            res = await publishCompanyProfileRetry({
              transactionId,
              companyId,
              source: requestSource,
              userId,
            });
            break;
          case "company-publication":
            res = await publishCompanyPublicationRetry({
              transactionId,
              companyId,
              source: requestSource,
              userId,
            });
            break;
          case "company-contact":
            res = await publishCompanyContactRetry({
              transactionId,
              companyId,
              source: requestSource,
              userId,
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
    // Also flip the persisted EntityProgress row to in_progress so a
    // matrix snapshot fetch on remount (no SSE subscription yet) shows
    // the correct yellow dot instead of the prior run's red. Without
    // this, the user leaves /transactions, comes back, and sees the
    // stale failed state until the producer's terminal event lands.
    // Conflict-update only when the existing row is in a terminal
    // state — never overwrite a fresher in_progress from a concurrent
    // producer at handler entry.
    try {
      const pool = getGatewayPool();
      await pool.query(
        `INSERT INTO "EntityProgress"
           ("transactionId", "companyId", producer, state, "errorMessage",
            "updatedAt", "createdAt")
         VALUES ($1, $2, $3, 'in_progress', NULL, NOW(), NOW())
         ON CONFLICT ("transactionId", "companyId", producer) DO UPDATE
         SET state = 'in_progress',
             "errorMessage" = NULL,
             "updatedAt" = NOW()
         WHERE "EntityProgress".state IN ('completed', 'failed', 'skipped', 'pending')`,
        [transactionId, companyId, STAGE_TO_SERVICE[stage]],
      );
    } catch (err) {
      // Non-fatal: SSE event above already nudged any subscribed
      // client. The next persist event will rewrite the row anyway.
      logger.warn(
        { err: err instanceof Error ? err.message : String(err) },
        "retry endpoint failed to persist in_progress",
      );
    }
  } else {
    // v0.1.378 — KEIN Target hat angenommen → der Auto-Retry hat nichts
    // bewirkt. Vorher blieb die Zeile `state='failed'` mit reifem
    // `nextRetryAt` stehen → der Heartbeat hat sie bei JEDEM Tick erneut
    // gefeuert. Bei vielen aussichtslosen Zeilen führte das zu einem
    // Dauer-Burst auf die DB, bis die Connection-Slots ausgingen (der
    // gemeldete contacts-500). Jetzt schreiben wir das Ergebnis zurück:
    //   - 404-only („nichts zum Re-Publish": kein Kontakt-/Publikations-/
    //     Strukturdatensatz) ist DAUERHAFT aussichtslos → `giveUpAt`
    //     setzen, damit die Zeile die Retry-Queue endgültig verlässt.
    //   - sonst (Netz/5xx/DB) → exponentiell zurückstellen und nach 10
    //     Versuchen final aufgeben, damit ein toter Upstream nicht ewig
    //     loopt.
    // Self-healing: ein echtes späteres `completed`/Persist überschreibt
    // die Zeile ohnehin (Terminal-Guard im event-bus).
    const allFutile =
      dispatched.length > 0 && dispatched.every((d) => d.status === 404);
    const producerCol = STAGE_TO_SERVICE[stage];
    try {
      const pool = getGatewayPool();
      if (allFutile) {
        await pool.query(
          `UPDATE "EntityProgress"
              SET "giveUpAt" = NOW(), "updatedAt" = NOW(),
                  "errorMessage" = $4
            WHERE "transactionId" = $1 AND "companyId" = $2 AND producer = $3
              AND state = 'failed' AND "giveUpAt" IS NULL`,
          [
            transactionId,
            companyId,
            producerCol,
            "Kein Quell-Datensatz zum erneuten Verarbeiten vorhanden — Auto-Retry gestoppt. Firma bei Bedarf neu importieren.",
          ],
        );
      } else {
        await pool.query(
          `UPDATE "EntityProgress"
              SET "attempts" = "attempts" + 1,
                  "lastFailureAt" = NOW(), "updatedAt" = NOW(),
                  "nextRetryAt" = NOW() + (
                    (ARRAY[300,1800,7200,28800,86400])[LEAST("attempts" + 1, 5)]
                    * INTERVAL '1 second'),
                  "giveUpAt" = CASE WHEN "attempts" + 1 >= 10 THEN NOW()
                                    ELSE "giveUpAt" END
            WHERE "transactionId" = $1 AND "companyId" = $2 AND producer = $3
              AND state = 'failed' AND "giveUpAt" IS NULL`,
          [transactionId, companyId, producerCol],
        );
      }
    } catch (err) {
      logger.warn(
        {
          err: err instanceof Error ? err.message : String(err),
          transactionId,
          companyId,
          stage,
        },
        "retry endpoint failed to update backoff/give-up",
      );
    }
  }

  return c.json(
    { transactionId, companyId, stage, dispatched, ok },
    202,
  );
});

// ---- v0.1.394 — Pause / Resume / Cancel processing for ONE company --------
//
// Per-company control over the retry/re-dispatch loop. Because producers run
// locally and consume AMQP events that were already published, these cannot
// abort an IN-FLIGHT stage — they stop the company from being re-driven:
//   - pause   → set `paused=true`; the retry-queue (`/retry-queue/pending`)
//               skips paused rows, so failed stages aren't re-dispatched.
//   - resume  → clear `paused`; re-queue failed rows promptly (nextRetryAt=NOW).
//   - cancel  → set `giveUpAt=NOW()` (permanently off the retry queue) and
//               terminalize still-pending/in_progress rows as `skipped`
//               ("Vom Nutzer abgebrochen"). Completed/failed stay as-is.

const EntityControlResult = z
  .object({ ok: z.boolean(), affected: z.number().int() })
  .openapi("EntityControlResult");

const pauseRoute = createRoute({
  method: "post",
  path: "/transactions/{transactionId}/entities/{companyId}/pause",
  tags: [tag],
  summary: "Pause processing (retry re-dispatch) for one company",
  request: { params: TransactionEntityParams },
  responses: {
    200: { content: { "application/json": { schema: EntityControlResult } }, description: "paused" },
    ...errorResponses,
  },
});

transactionsRouter.openapi(pauseRoute, async (c) => {
  const { transactionId, companyId } = c.req.valid("param");
  await assertTransactionOwnershipById(c, transactionId);
  const pool = getGatewayPool();
  const res = await pool.query(
    `UPDATE "EntityProgress" SET "paused" = true
     WHERE "transactionId" = $1 AND "companyId" = $2`,
    [transactionId, companyId],
  );
  logger.info(
    { transactionId, companyId, affected: res.rowCount ?? 0, requestId: c.get("requestId") },
    "entity paused",
  );
  return c.json({ ok: true, affected: res.rowCount ?? 0 }, 200);
});

const resumeRoute = createRoute({
  method: "post",
  path: "/transactions/{transactionId}/entities/{companyId}/resume",
  tags: [tag],
  summary: "Resume processing for one paused company",
  request: { params: TransactionEntityParams },
  responses: {
    200: { content: { "application/json": { schema: EntityControlResult } }, description: "resumed" },
    ...errorResponses,
  },
});

transactionsRouter.openapi(resumeRoute, async (c) => {
  const { transactionId, companyId } = c.req.valid("param");
  await assertTransactionOwnershipById(c, transactionId);
  const pool = getGatewayPool();
  // Clear pause; nudge failed (non-given-up) rows back to "ripe now" so the
  // ticker re-enrolls them on the next slot instead of waiting out backoff.
  const res = await pool.query(
    `UPDATE "EntityProgress"
        SET "paused" = false,
            "nextRetryAt" = CASE WHEN state = 'failed' AND "giveUpAt" IS NULL
                                 THEN NOW() ELSE "nextRetryAt" END
      WHERE "transactionId" = $1 AND "companyId" = $2`,
    [transactionId, companyId],
  );
  logger.info(
    { transactionId, companyId, affected: res.rowCount ?? 0, requestId: c.get("requestId") },
    "entity resumed",
  );
  return c.json({ ok: true, affected: res.rowCount ?? 0 }, 200);
});

const cancelRoute = createRoute({
  method: "post",
  path: "/transactions/{transactionId}/entities/{companyId}/cancel",
  tags: [tag],
  summary: "Stop/cancel processing for one company",
  request: { params: TransactionEntityParams },
  responses: {
    200: { content: { "application/json": { schema: EntityControlResult } }, description: "cancelled" },
    ...errorResponses,
  },
});

transactionsRouter.openapi(cancelRoute, async (c) => {
  const { transactionId, companyId } = c.req.valid("param");
  await assertTransactionOwnershipById(c, transactionId);
  const pool = getGatewayPool();
  const res = await pool.query(
    `UPDATE "EntityProgress"
        SET "giveUpAt" = NOW(),
            "paused" = false,
            state = CASE WHEN state IN ('pending', 'in_progress') THEN 'skipped' ELSE state END,
            "errorMessage" = CASE WHEN state IN ('pending', 'in_progress')
                                  THEN 'Vom Nutzer abgebrochen' ELSE "errorMessage" END,
            "updatedAt" = NOW()
      WHERE "transactionId" = $1 AND "companyId" = $2 AND state <> 'completed'`,
    [transactionId, companyId],
  );
  logger.info(
    { transactionId, companyId, affected: res.rowCount ?? 0, requestId: c.get("requestId") },
    "entity cancelled",
  );
  return c.json({ ok: true, affected: res.rowCount ?? 0 }, 200);
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
  // v0.1.243 — beide Stages laufen IM Website-Producer; das
  // ContentFreshness-Clear muss den Website-Producer-Slice
  // invalidieren, damit das tier-Gate beim nächsten Persist die
  // frischen Werte durchlässt.
  deepResearch: "website",
  jobPostings: "website",
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

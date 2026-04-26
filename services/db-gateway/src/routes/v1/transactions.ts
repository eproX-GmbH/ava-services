import { OpenAPIHono, createRoute, z } from "@hono/zod-openapi";
import type { Context } from "hono";
import { HTTPException } from "hono/http-exception";
import { streamSSE } from "hono/streaming";
import { requireScope } from "../../middleware/auth";
import { callUpstream } from "../../lib/upstream";
import { transactionProgressBus } from "../../lib/event-bus";
import { logger } from "../../lib/logger";
import {
  EntityTransactionShape,
  ErrorShape,
  PaginatedShape,
  PaginationQuery,
  ProcessingErrorShape,
  TransactionEntityParams,
  TransactionIdParam,
  TransactionShape,
} from "./schemas";

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
    state: z.enum(["completed", "failed", "skipped"]),
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
      if (payload.tenantId !== auth.tenantId) return;
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
  // Gateway slices client-side. TODO upstream: add pageNumber/pageSize.
  // Cached for the request so a follow-up ownership check on a per-id route
  // (rare but possible if a client batches list+detail) reuses the same fetch.
  const all = await getMyTransactions(c);

  const start = (page - 1) * pageSize;
  return c.json(
    {
      items: all.slice(start, start + pageSize) as Array<Record<string, unknown>>,
      page,
      pageSize,
      total: all.length,
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
  const upstream = await callUpstream<Record<string, unknown>>(
    c,
    "companyProfile",
    `/api/v1/transactions/${encodeURIComponent(transactionId)}`,
  );
  await assertTransactionOwnership(c, upstream);
  return c.json(upstream, 200);
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

  const upstream = await callUpstream<{ entityTransactions?: unknown[]; count?: number; items?: unknown[]; total?: number }>(
    c,
    "companyProfile",
    `/api/v1/transactions/${encodeURIComponent(transactionId)}/entities`,
    { query: { pageNumber: page, pageSize } },
  );

  const items =
    (upstream?.entityTransactions ?? upstream?.items ?? []) as Array<Record<string, unknown>>;
  const total = upstream?.count ?? upstream?.total ?? items.length;

  return c.json({ items, page, pageSize, total }, 200);
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
  );
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

  // company-profile only exposes processing errors per (transactionId, companyId).
  // We fan out: list entities, then fetch errors per company in parallel.
  // For typical excel-import-sized transactions (≤ a few hundred companies)
  // this is acceptable; large transactions warrant an aggregate upstream
  // endpoint. TODO upstream: /api/v1/processing-errors/transactions/:tid.
  const entities = await getTransactionEntitiesAll(c, transactionId);
  const companies = Array.from(
    new Set(
      entities
        .map((e) => (e as { companyId?: unknown }).companyId)
        .filter((id): id is string => typeof id === "string"),
    ),
  );

  const perCompany = await Promise.all(
    companies.map(async (companyId) => {
      try {
        const list = await callUpstream<unknown>(
          c,
          "companyProfile",
          `/api/v1/processing-errors/transactions/${encodeURIComponent(transactionId)}/companies/${encodeURIComponent(companyId)}`,
        );
        const arr = (Array.isArray(list)
          ? list
          : ((list as { items?: unknown[] })?.items ?? [])) as Array<Record<string, unknown>>;
        // Stamp each row with companyId so the Desktop-App can group without
        // a re-lookup. Upstream rows already carry it but be defensive.
        return arr.map((row) => ({ companyId, ...row }));
      } catch (err) {
        // A single company's errors-call failing must not poison the whole
        // response — log and return nothing for that row.
        logger.warn(
          { err, transactionId, companyId, requestId: c.get("requestId") },
          "errors fan-out: single company failed",
        );
        return [];
      }
    }),
  );

  return c.json({ items: perCompany.flat() }, 200);
});

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
    const list = await callUpstream<unknown>(
      c,
      "companyProfile",
      "/api/v1/users/transactions",
    );
    return (Array.isArray(list)
      ? list
      : ((list as { items?: unknown[] })?.items ?? [])) as UpstreamTransaction[];
  });
}

async function getTransactionEntitiesAll(
  c: Context,
  transactionId: string,
): Promise<Array<Record<string, unknown>>> {
  return memoize(c, `entities-all:${transactionId}`, async () => {
    const upstream = await callUpstream<{ entityTransactions?: Array<Record<string, unknown>> }>(
      c,
      "companyProfile",
      `/api/v1/transactions/${encodeURIComponent(transactionId)}/entities`,
      { query: { pageNumber: 1, pageSize: 1000 } },
    );
    return upstream?.entityTransactions ?? [];
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

import { OpenAPIHono, createRoute, z } from "@hono/zod-openapi";
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
// Note: the route is registered as a plain Hono handler (not via
// `createRoute`) because streamSSE's Response type doesn't fit the
// zod-openapi typed-response generic. The endpoint is documented in
// DESKTOP_DATA_FLOW.md §6 — adding it to OpenAPI is a Step 7 hardening item.

export const transactionsRouter = new OpenAPIHono();
transactionsRouter.use("*", requireScope("transaction:read"));

const TransactionEventsParam = z.object({
  transactionId: z.string().min(1),
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
// today, so we layer ownership verification at the gateway (TODO below).
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
  const upstream = await callUpstream<unknown>(
    c,
    "companyProfile",
    "/api/v1/users/transactions",
  );
  const all = (Array.isArray(upstream)
    ? upstream
    : ((upstream as { items?: unknown[] })?.items ?? [])) as Array<Record<string, unknown>>;

  const start = (page - 1) * pageSize;
  return c.json(
    {
      items: all.slice(start, start + pageSize),
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
  const upstream = await callUpstream<{ entityTransactions?: Array<Record<string, unknown>> }>(
    c,
    "companyProfile",
    `/api/v1/transactions/${encodeURIComponent(transactionId)}/entities`,
    { query: { pageNumber: 1, pageSize: 1000 } },
  );

  const match = (upstream?.entityTransactions ?? []).find(
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
  const entitiesResp = await callUpstream<{ entityTransactions?: Array<Record<string, unknown>> }>(
    c,
    "companyProfile",
    `/api/v1/transactions/${encodeURIComponent(transactionId)}/entities`,
    { query: { pageNumber: 1, pageSize: 1000 } },
  );
  const companies = Array.from(
    new Set(
      (entitiesResp?.entityTransactions ?? [])
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

// ---- Ownership helpers -----------------------------------------------------
//
// Transactions are tenant-scoped (Q1). Verify the JWT's actor (`sub`) owns
// the transaction before returning detail/entity/errors data. Upstream's
// `/api/v1/users/transactions` is the source of truth for ownership today.
// We accept a small extra round-trip on per-id reads — caching (per
// requestId) is a Step 7 hardening item.

interface UpstreamTransaction {
  id?: string;
  transactionId?: string;
  userId?: string;
}

async function assertTransactionOwnership(
  c: Parameters<typeof callUpstream>[0],
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
  c: Parameters<typeof callUpstream>[0],
  transactionId: string,
): Promise<void> {
  const list = await callUpstream<unknown>(
    c,
    "companyProfile",
    "/api/v1/users/transactions",
  );
  const all = (Array.isArray(list)
    ? list
    : ((list as { items?: unknown[] })?.items ?? [])) as Array<UpstreamTransaction>;
  const owns = all.some(
    (t) => t.id === transactionId || t.transactionId === transactionId,
  );
  if (!owns) {
    throw new HTTPException(403, { message: "forbidden" });
  }
}

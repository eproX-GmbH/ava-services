import { OpenAPIHono, createRoute, z } from "@hono/zod-openapi";
import type { Context } from "hono";
import { HTTPException } from "hono/http-exception";
import { requireScope } from "../../middleware/auth";
import { callUpstream } from "../../lib/upstream";
import {
  BestMatchIdParam,
  BestMatchShape,
  ChatMessageShape,
  ChatSessionIdParam,
  ChatSessionShape,
  ClusterIdParam,
  ComparisonIdParam,
  ComparisonShape,
  ErrorShape,
  PaginatedShape,
  PaginationQuery,
  TransactionIdQuery,
} from "./schemas";

// =============================================================================
// §4.3 Evaluation reads (W15, W19, W22).
//
// All endpoints proxy to company-evaluation. Five of six map cleanly; the
// cluster GET is a documented gap (upstream only exposes the POST k-means
// command — see DESKTOP_DATA_FLOW.md §11 follow-ups).
//
// Ownership story (mirrors §4.2):
//   - Endpoints with a transactionId in path/query verify ownership against
//     the user's transaction list (cached via the same `getMyTransactions`
//     pattern as transactions.ts).
//   - Endpoints with neither transactionId nor userId on the entity (chat
//     messages by sessionId, comparisons by id) currently fall back to JWT
//     scope + tenant only — TODO upstream so each entity carries an
//     ownership signal we can verify cheaply.
// =============================================================================

export const evaluationsRouter = new OpenAPIHono();
evaluationsRouter.use("*", requireScope("evaluation:read"));

const tag = "evaluations";
const errorResponses = {
  401: { content: { "application/json": { schema: ErrorShape } }, description: "unauthenticated" },
  403: { content: { "application/json": { schema: ErrorShape } }, description: "forbidden" },
  404: { content: { "application/json": { schema: ErrorShape } }, description: "not found" },
  429: { content: { "application/json": { schema: ErrorShape } }, description: "rate limited" },
  502: { content: { "application/json": { schema: ErrorShape } }, description: "upstream failure" },
} as const;

// ---- Per-request ownership cache ------------------------------------------
//
// Same Map-on-context pattern as transactions.ts; we reuse `v1TxCache` so a
// caller that hits both routers in one inbound request shares the same
// `/api/v1/users/transactions` fetch.

interface UpstreamTransaction {
  id?: string;
  transactionId?: string;
  userId?: string;
}

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

async function getMyTransactions(c: Context): Promise<UpstreamTransaction[]> {
  return memoize(c, "users/transactions", async () => {
    // §8.v3 — master-data is the source of truth (see same fix in
    // routes/v1/transactions.ts).
    const list = await callUpstream<unknown>(
      c,
      "masterData",
      "/api/v1/transactions/users/user",
      { query: { pageNumber: 1, pageSize: 100 } },
    );
    if (Array.isArray(list)) return list as UpstreamTransaction[];
    const obj = list as { transactions?: unknown[]; items?: unknown[] };
    return (obj.transactions ?? obj.items ?? []) as UpstreamTransaction[];
  });
}

async function assertTransactionOwnership(c: Context, transactionId: string): Promise<void> {
  const all = await getMyTransactions(c);
  const owns = all.some(
    (t) => t.id === transactionId || t.transactionId === transactionId,
  );
  if (!owns) {
    throw new HTTPException(403, { message: "forbidden" });
  }
}

// =============================================================================
// Best matches (W15)
// =============================================================================

// ---- GET /v1/evaluations/best-matches?transactionId= -----------------------

const bestMatchesListRoute = createRoute({
  method: "get",
  path: "/evaluations/best-matches",
  tags: [tag],
  summary: "List best-match jobs for a transaction (W15)",
  request: { query: TransactionIdQuery.merge(PaginationQuery) },
  responses: {
    200: {
      content: { "application/json": { schema: PaginatedShape(BestMatchShape) } },
      description: "page of best-match jobs",
    },
    ...errorResponses,
  },
});

evaluationsRouter.openapi(bestMatchesListRoute, async (c) => {
  const { transactionId, page, pageSize } = c.req.valid("query");

  await assertTransactionOwnership(c, transactionId);

  // Upstream takes pageNumber/pageSize and returns a page envelope.
  const upstream = await callUpstream<{
    bestMatches?: Array<Record<string, unknown>>;
    count?: number;
  }>(
    c,
    "companyEvaluation",
    `/api/v1/best-match/transactions/${encodeURIComponent(transactionId)}`,
    { query: { pageNumber: page, pageSize } },
  );

  const items = (upstream?.bestMatches ?? []) as Array<z.infer<typeof BestMatchShape>>;
  return c.json({ items, page, pageSize, total: upstream?.count ?? items.length }, 200);
});

// ---- GET /v1/evaluations/best-matches/:bestMatchId -------------------------

const bestMatchDetailRoute = createRoute({
  method: "get",
  path: "/evaluations/best-matches/{bestMatchId}",
  tags: [tag],
  summary: "Get a best-match job (W15)",
  request: { params: BestMatchIdParam },
  responses: {
    200: { content: { "application/json": { schema: BestMatchShape } }, description: "best-match job" },
    ...errorResponses,
  },
});

evaluationsRouter.openapi(bestMatchDetailRoute, async (c) => {
  const { bestMatchId } = c.req.valid("param");
  const upstream = await callUpstream<z.infer<typeof BestMatchShape>>(
    c,
    "companyEvaluation",
    `/api/v1/best-match/${encodeURIComponent(bestMatchId)}`,
  );

  // Upstream attaches `transactionId` on the row — cross-check against the
  // caller's transactions. If upstream omits it (defensive: legacy rows),
  // fall through; the JWT scope+tenant gate is then the only protection.
  if (upstream?.transactionId) {
    await assertTransactionOwnership(c, upstream.transactionId);
  }
  return c.json(upstream, 200);
});

// =============================================================================
// Chats (W19)
// =============================================================================

// ---- GET /v1/evaluations/chats?transactionId= ------------------------------

const chatSessionsListRoute = createRoute({
  method: "get",
  path: "/evaluations/chats",
  tags: [tag],
  summary: "List chat sessions for a transaction (W19)",
  request: { query: TransactionIdQuery.merge(PaginationQuery) },
  responses: {
    200: {
      content: { "application/json": { schema: PaginatedShape(ChatSessionShape) } },
      description: "page of chat sessions",
    },
    ...errorResponses,
  },
});

evaluationsRouter.openapi(chatSessionsListRoute, async (c) => {
  const { transactionId, page, pageSize } = c.req.valid("query");

  await assertTransactionOwnership(c, transactionId);

  const upstream = await callUpstream<{
    sessions?: Array<Record<string, unknown>>;
    count?: number;
  }>(
    c,
    "companyEvaluation",
    `/api/v1/chats/transactions/${encodeURIComponent(transactionId)}`,
    { query: { pageNumber: page, pageSize } },
  );

  const items = (upstream?.sessions ?? []) as Array<z.infer<typeof ChatSessionShape>>;
  return c.json({ items, page, pageSize, total: upstream?.count ?? items.length }, 200);
});

// ---- GET /v1/evaluations/chats/:sessionId/messages -------------------------

const chatMessagesRoute = createRoute({
  method: "get",
  path: "/evaluations/chats/{sessionId}/messages",
  tags: [tag],
  summary: "List messages in a chat session",
  request: { params: ChatSessionIdParam, query: PaginationQuery },
  responses: {
    200: {
      content: { "application/json": { schema: PaginatedShape(ChatMessageShape) } },
      description: "page of chat messages",
    },
    ...errorResponses,
  },
});

evaluationsRouter.openapi(chatMessagesRoute, async (c) => {
  const { sessionId } = c.req.valid("param");
  const { page, pageSize } = c.req.valid("query");

  // TODO ownership: upstream chat-session table has no userId column and no
  // get-session-by-id endpoint, so we can't cheaply verify ownership without
  // either (a) iterating the caller's transactions and listing sessions per
  // transaction, or (b) adding a session-detail upstream endpoint. For now
  // the JWT scope+tenant gate is the only protection — sessionId is a
  // 128-bit opaque identifier so this is acceptable for v0; the proper fix
  // is upstream work tracked as a Step 7 follow-up.
  const upstream = await callUpstream<{
    chatMessages?: Array<Record<string, unknown>>;
    count?: number;
  }>(
    c,
    "companyEvaluation",
    `/api/v1/chats/transactions/sessions/${encodeURIComponent(sessionId)}`,
    { query: { pageNumber: page, pageSize } },
  );

  const items = (upstream?.chatMessages ?? []) as Array<z.infer<typeof ChatMessageShape>>;
  return c.json({ items, page, pageSize, total: upstream?.count ?? items.length }, 200);
});

// =============================================================================
// Clusters (W22) — DEFERRED
// =============================================================================

// ---- GET /v1/evaluations/clusters/:clusterId -------------------------------
//
// Upstream has no GET — only POST /api/v1/clusters/cluster/k-means (a
// command, not a query). We expose the path with a 501 so OpenAPI consumers
// know the endpoint is reserved, and the gateway smoke-tests don't fail
// silently when this lands. Removing the 501 = adding the upstream query.

const clusterDetailRoute = createRoute({
  method: "get",
  path: "/evaluations/clusters/{clusterId}",
  tags: [tag],
  summary: "Get cluster result (W22) — not yet implemented upstream",
  description:
    "Placeholder. company-evaluation only exposes the POST k-means command today; a GET query needs to land upstream first. Returns 501 until then.",
  request: { params: ClusterIdParam },
  responses: {
    501: { content: { "application/json": { schema: ErrorShape } }, description: "not implemented" },
    ...errorResponses,
  },
});

evaluationsRouter.openapi(clusterDetailRoute, async (c) => {
  return c.json(
    {
      error: "not_implemented",
      message: "cluster GET is pending upstream company-evaluation work",
    },
    501,
  );
});

// =============================================================================
// Comparisons (W22)
// =============================================================================

// ---- GET /v1/evaluations/comparisons/:comparisonId -------------------------

const comparisonDetailRoute = createRoute({
  method: "get",
  path: "/evaluations/comparisons/{comparisonId}",
  tags: [tag],
  summary: "Get comparison result (W22)",
  request: { params: ComparisonIdParam },
  responses: {
    200: { content: { "application/json": { schema: ComparisonShape } }, description: "comparison" },
    ...errorResponses,
  },
});

evaluationsRouter.openapi(comparisonDetailRoute, async (c) => {
  const { comparisonId } = c.req.valid("param");

  // TODO ownership: comparison rows upstream have no userId/transactionId
  // field. Same v0 trade-off as chat messages above — JWT scope+tenant gate
  // only. Upstream needs to add an ownership column (or link comparisons to
  // a transaction) before we can verify here.
  const upstream = await callUpstream<z.infer<typeof ComparisonShape>>(
    c,
    "companyEvaluation",
    `/api/v1/comparisons/${encodeURIComponent(comparisonId)}`,
  );
  return c.json(upstream, 200);
});

import { OpenAPIHono, createRoute, z } from "@hono/zod-openapi";
import type { Context } from "hono";
import { HTTPException } from "hono/http-exception";
import { requireScope } from "../../middleware/auth";
import { callUpstream } from "../../lib/upstream";
import { getProducerPool } from "../../lib/producer-pools";
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
      { query: { pageNumber: 1, pageSize: 50 } },
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

// §8.v3 Phase 2c — MPG-direct read. Two queries: page of best-match
// jobs (transactionId-filtered), then the result rows for each. The
// company-evaluation producer's `BestMatchJob` table is the canonical
// store; rows land here via the legacy POST endpoint today (which is
// stubbed 501 in evaluation-writes.ts under Phase 2c — see there).
// Existing rows from before §8.v3 cutover continue to surface.
evaluationsRouter.openapi(bestMatchesListRoute, async (c) => {
  const { transactionId, page, pageSize } = c.req.valid("query");
  await assertTransactionOwnership(c, transactionId);

  const pool = getProducerPool("company-evaluation");
  const offset = (page - 1) * pageSize;

  const totalRes = await pool.query<{ total: string }>(
    `SELECT COUNT(*)::text AS total
     FROM "BestMatchJob"
     WHERE "transactionId" = $1`,
    [transactionId],
  );
  const total = Number(totalRes.rows[0]?.total ?? "0");

  const jobsRes = await pool.query<{
    id: string;
    input: string;
    transactionId: string | null;
    createdAt: Date;
    updatedAt: Date;
  }>(
    `SELECT id, input, "transactionId", "createdAt", "updatedAt"
     FROM "BestMatchJob"
     WHERE "transactionId" = $1
     ORDER BY "createdAt" DESC
     LIMIT $2 OFFSET $3`,
    [transactionId, pageSize, offset],
  );

  // Pull result rows for the page in one query.
  const jobIds = jobsRes.rows.map((r) => r.id);
  const resultsByJob = new Map<string, Array<z.infer<typeof BestMatchShape>["results"][number]>>();
  if (jobIds.length > 0) {
    const resultsRes = await pool.query<{
      id: string;
      bestMatchJobId: string;
      companyId: string | null;
      explanation: string | null;
      score: number | null;
    }>(
      `SELECT id, "bestMatchJobId", "companyId", explanation, score
       FROM "BestMatchJobResult"
       WHERE "bestMatchJobId" = ANY($1::text[])`,
      [jobIds],
    );
    for (const r of resultsRes.rows) {
      let arr = resultsByJob.get(r.bestMatchJobId);
      if (!arr) {
        arr = [];
        resultsByJob.set(r.bestMatchJobId, arr);
      }
      arr.push({
        id: r.id,
        companyId: r.companyId,
        explanation: r.explanation,
        score: r.score,
        signals: null,
        matchFeedback: null,
      });
    }
  }

  const items: Array<z.infer<typeof BestMatchShape>> = jobsRes.rows.map((j) => ({
    id: j.id,
    input: j.input,
    transactionId: j.transactionId,
    results: resultsByJob.get(j.id) ?? [],
    createdAt: j.createdAt.toISOString(),
    updatedAt: j.updatedAt.toISOString(),
  }));
  return c.json({ items, page, pageSize, total }, 200);
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
  const pool = getProducerPool("company-evaluation");

  const jobRes = await pool.query<{
    id: string;
    input: string;
    transactionId: string | null;
    createdAt: Date;
    updatedAt: Date;
  }>(
    `SELECT id, input, "transactionId", "createdAt", "updatedAt"
     FROM "BestMatchJob" WHERE id = $1 LIMIT 1`,
    [bestMatchId],
  );
  if (jobRes.rowCount === 0) {
    throw new HTTPException(404, { message: "not_found" });
  }
  const job = jobRes.rows[0];

  // Cross-check ownership against the caller's transactions (matches
  // the legacy upstream's behaviour).
  if (job.transactionId) {
    await assertTransactionOwnership(c, job.transactionId);
  }

  const resultsRes = await pool.query<{
    id: string;
    companyId: string | null;
    explanation: string | null;
    score: number | null;
  }>(
    `SELECT id, "companyId", explanation, score
     FROM "BestMatchJobResult" WHERE "bestMatchJobId" = $1`,
    [bestMatchId],
  );
  const results = resultsRes.rows.map((r) => ({
    id: r.id,
    companyId: r.companyId,
    explanation: r.explanation,
    score: r.score,
    signals: null,
    matchFeedback: null,
  }));

  return c.json(
    {
      id: job.id,
      input: job.input,
      transactionId: job.transactionId,
      results,
      createdAt: job.createdAt.toISOString(),
      updatedAt: job.updatedAt.toISOString(),
    },
    200,
  );
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

  const pool = getProducerPool("company-evaluation");
  const offset = (page - 1) * pageSize;

  const totalRes = await pool.query<{ total: string }>(
    `SELECT COUNT(*)::text AS total FROM "ChatSession" WHERE "transactionId" = $1`,
    [transactionId],
  );
  const total = Number(totalRes.rows[0]?.total ?? "0");

  const rows = await pool.query<{
    id: string;
    transactionId: string;
    allowedCompanyIds: string[];
    summary: string | null;
    createdAt: Date;
    updatedAt: Date;
  }>(
    `SELECT id, "transactionId", "allowedCompanyIds", summary, "createdAt", "updatedAt"
     FROM "ChatSession"
     WHERE "transactionId" = $1
     ORDER BY "createdAt" DESC
     LIMIT $2 OFFSET $3`,
    [transactionId, pageSize, offset],
  );
  const items: Array<z.infer<typeof ChatSessionShape>> = rows.rows.map((r) => ({
    id: r.id,
    transactionId: r.transactionId,
    allowedCompanyIds: r.allowedCompanyIds ?? [],
    summary: r.summary,
    createdAt: r.createdAt.toISOString(),
    updatedAt: r.updatedAt.toISOString(),
  }));
  return c.json({ items, page, pageSize, total }, 200);
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

  // §8.v3 Phase 2c — MPG-direct read against ChatTurn. Ownership story
  // unchanged from the legacy upstream: ChatSession has no userId
  // column, so we lean on JWT scope+tenant + the 128-bit opaque
  // sessionId for the v0 trade-off.
  const pool = getProducerPool("company-evaluation");
  const offset = (page - 1) * pageSize;

  const totalRes = await pool.query<{ total: string }>(
    `SELECT COUNT(*)::text AS total FROM "ChatTurn" WHERE "sessionId" = $1`,
    [sessionId],
  );
  const total = Number(totalRes.rows[0]?.total ?? "0");

  const rows = await pool.query<{
    id: string;
    sessionId: string;
    role: string;
    content: string;
    citations: unknown;
    rowNumber: string;
    createdAt: Date;
  }>(
    // Stable turnIndex: row_number() over chronological order. The
    // legacy producer didn't store a turn index column either.
    `SELECT id, "sessionId", role, content, citations,
            ROW_NUMBER() OVER (PARTITION BY "sessionId" ORDER BY "createdAt")::text
              AS "rowNumber",
            "createdAt"
     FROM "ChatTurn"
     WHERE "sessionId" = $1
     ORDER BY "createdAt" DESC
     LIMIT $2 OFFSET $3`,
    [sessionId, pageSize, offset],
  );

  const items: Array<z.infer<typeof ChatMessageShape>> = rows.rows.map((r) => ({
    id: r.id,
    sessionId: r.sessionId,
    role: (r.role === "user" || r.role === "assistant" ? r.role : "user") as
      | "user"
      | "assistant",
    content: r.content,
    citations:
      (r.citations as z.infer<typeof ChatMessageShape>["citations"]) ?? null,
    turnIndex: Number(r.rowNumber),
    createdAt: r.createdAt.toISOString(),
  }));
  return c.json({ items, page, pageSize, total }, 200);
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

  // §8.v3 Phase 2c — MPG-direct read. Ownership: ComparisonJob has no
  // userId/transactionId field. JWT scope+tenant + opaque id is the
  // v0 trade-off — same as legacy.
  const pool = getProducerPool("company-evaluation");
  const jobRes = await pool.query<{
    id: string;
    targetCompanyId: string | null;
    companyIds: string[];
    createdAt: Date;
    updatedAt: Date;
  }>(
    `SELECT id, "targetCompanyId", "companyIds", "createdAt", "updatedAt"
     FROM "ComparisonJob" WHERE id = $1 LIMIT 1`,
    [comparisonId],
  );
  if (jobRes.rowCount === 0) {
    throw new HTTPException(404, { message: "not_found" });
  }
  const job = jobRes.rows[0];

  const rankingRes = await pool.query<{
    id: number;
    companyId: string;
    order: number;
    createdAt: Date;
  }>(
    `SELECT id, "companyId", "order", "createdAt"
     FROM "ComparisonJobRanking"
     WHERE "comparisonJobId" = $1
     ORDER BY "order"`,
    [comparisonId],
  );

  return c.json(
    {
      id: job.id,
      targetCompanyId: job.targetCompanyId,
      companyIds: job.companyIds ?? [],
      ranking: rankingRes.rows.map((r) => ({
        id: String(r.id),
        companyId: r.companyId,
        order: r.order,
        createdAt: r.createdAt.toISOString(),
      })),
      createdAt: job.createdAt.toISOString(),
      updatedAt: job.updatedAt.toISOString(),
    },
    200,
  );
});

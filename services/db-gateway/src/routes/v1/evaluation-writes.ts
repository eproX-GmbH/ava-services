import { OpenAPIHono, createRoute, z } from "@hono/zod-openapi";
import type { Context } from "hono";
import { HTTPException } from "hono/http-exception";
import { requireScope } from "../../middleware/auth";
import { callUpstream } from "../../lib/upstream";
import {
  BestMatchCreateBody,
  BestMatchCreateResponse,
  BestMatchFeedbackBody,
  BestMatchIdParam,
  ChatCreateBody,
  ChatCreateResponse,
  ChatMessageCreateBody,
  ChatMessageCreateResponse,
  ChatSessionIdParam,
  ClusterCreateBody,
  ClusterCreateResponse,
  ComparisonCreateBody,
  ComparisonCreateResponse,
  ErrorShape,
  OfferAnalysisBody,
} from "./schemas";

// =============================================================================
// §5.2 Evaluation writes (W14, W16, W17, W18, W20, W21).
//
// Seven POST routes; all proxy to company-evaluation. Three reasons this is
// a separate router from §4.3's read-side `evaluations.ts`:
//   1. Different scope (`evaluation:write` vs `evaluation:read`) — easier
//      to gate at the router level than per-route.
//   2. The write side is a thin proxy with body validation; the read side
//      has the per-request transaction-ownership cache. Mixing them blurs
//      the auth model.
//   3. Lets §11 track the two phases separately.
//
// Spec ↔ upstream drift (DESKTOP_DATA_FLOW.md §5.2 was aspirational; we
// align bodies to upstream contracts):
//   - feedback: spec said `{companyId, signal}`; upstream needs
//     `{bestMatchJobResultId, label, reason?}`. Adopted upstream.
//   - chats: spec omitted topK; upstream requires it (default 10 here).
//   - chat messages: spec field `question` → upstream field `message`
//     (re-keyed on the way out so desktop stays consistent with the
//     ChatMessageShape it reads back).
//   - clusters: spec said `{transactionId, k}`; upstream wants
//     `{companyIds[], k, topics[]}`. Adopted upstream — caller resolves
//     companyIds via the §4.2 reads if it has only a transactionId.
//   - comparisons: spec missed `targetCompanyId`; upstream requires it.
//
// Ownership: writes that take a `transactionId` (chats only) verify
// ownership the same way §4.3 reads do — shared `v1TxCache` on Context.
// Writes that take only `companyIds[]` rely on JWT scope+tenant, since
// company entities are global per D2 (no per-user ownership column).
// =============================================================================

export const evaluationWritesRouter = new OpenAPIHono();
evaluationWritesRouter.use("*", requireScope("evaluation:write"));

const tag = "evaluations";
const errorResponses = {
  400: { content: { "application/json": { schema: ErrorShape } }, description: "bad request" },
  401: { content: { "application/json": { schema: ErrorShape } }, description: "unauthenticated" },
  403: { content: { "application/json": { schema: ErrorShape } }, description: "forbidden" },
  404: { content: { "application/json": { schema: ErrorShape } }, description: "not found" },
  429: { content: { "application/json": { schema: ErrorShape } }, description: "rate limited" },
  502: { content: { "application/json": { schema: ErrorShape } }, description: "upstream failure" },
} as const;

// ---- Ownership helpers (shared with §4.3 reads via `v1TxCache`) -----------

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
    const list = await callUpstream<unknown>(c, "companyProfile", "/api/v1/users/transactions");
    return (Array.isArray(list)
      ? list
      : ((list as { items?: unknown[] })?.items ?? [])) as UpstreamTransaction[];
  });
}
async function assertTransactionOwnership(c: Context, transactionId: string): Promise<void> {
  const all = await getMyTransactions(c);
  const owns = all.some((t) => t.id === transactionId || t.transactionId === transactionId);
  if (!owns) throw new HTTPException(403, { message: "forbidden" });
}

// =============================================================================
// Best matches (W14, W16)
// =============================================================================

// ---- POST /v1/evaluations/best-matches -------------------------------------

const bestMatchCreateRoute = createRoute({
  method: "post",
  path: "/evaluations/best-matches",
  tags: [tag],
  summary: "Start a best-match job (W14)",
  request: {
    body: { content: { "application/json": { schema: BestMatchCreateBody } }, required: true },
  },
  responses: {
    202: {
      content: { "application/json": { schema: BestMatchCreateResponse } },
      description: "best-match job accepted",
    },
    ...errorResponses,
  },
});

evaluationWritesRouter.openapi(bestMatchCreateRoute, async (c) => {
  const body = c.req.valid("json");

  // If the caller scopes the job to a transaction, verify they own it.
  if (body.transactionId) {
    await assertTransactionOwnership(c, body.transactionId);
  }

  const upstream = await callUpstream<{ bestMatchJobId?: string } | null>(
    c,
    "companyEvaluation",
    "/api/v1/best-match",
    { method: "POST", body },
  );
  if (!upstream?.bestMatchJobId) {
    throw new HTTPException(502, { message: "upstream missing bestMatchJobId" });
  }
  return c.json({ bestMatchJobId: upstream.bestMatchJobId }, 202);
});

// ---- POST /v1/evaluations/offer-analysis -----------------------------------

const offerAnalysisRoute = createRoute({
  method: "post",
  path: "/evaluations/offer-analysis",
  tags: [tag],
  summary: "Run offer-analysis (returns top-K best matches for an offer)",
  request: {
    body: { content: { "application/json": { schema: OfferAnalysisBody } }, required: true },
  },
  responses: {
    202: {
      content: { "application/json": { schema: BestMatchCreateResponse } },
      description: "offer-analysis job accepted",
    },
    ...errorResponses,
  },
});

evaluationWritesRouter.openapi(offerAnalysisRoute, async (c) => {
  const body = c.req.valid("json");
  const upstream = await callUpstream<{ bestMatchJobId?: string } | null>(
    c,
    "companyEvaluation",
    "/api/v1/best-match/offer-analysis",
    { method: "POST", body },
  );
  if (!upstream?.bestMatchJobId) {
    throw new HTTPException(502, { message: "upstream missing bestMatchJobId" });
  }
  return c.json({ bestMatchJobId: upstream.bestMatchJobId }, 202);
});

// ---- POST /v1/evaluations/best-matches/:bestMatchId/feedback ---------------

const bestMatchFeedbackRoute = createRoute({
  method: "post",
  path: "/evaluations/best-matches/{bestMatchId}/feedback",
  tags: [tag],
  summary: "Submit feedback on a best-match result (W16)",
  request: {
    params: BestMatchIdParam,
    body: { content: { "application/json": { schema: BestMatchFeedbackBody } }, required: true },
  },
  responses: {
    204: { description: "feedback recorded" },
    ...errorResponses,
  },
});

evaluationWritesRouter.openapi(bestMatchFeedbackRoute, async (c) => {
  const { bestMatchId } = c.req.valid("param");
  const body = c.req.valid("json");
  await callUpstream(
    c,
    "companyEvaluation",
    `/api/v1/best-match/${encodeURIComponent(bestMatchId)}/feedback`,
    { method: "POST", body },
  );
  return c.body(null, 204);
});

// =============================================================================
// Chats (W17, W18)
// =============================================================================

// ---- POST /v1/evaluations/chats --------------------------------------------

const chatCreateRoute = createRoute({
  method: "post",
  path: "/evaluations/chats",
  tags: [tag],
  summary: "Start a new chat session for a transaction (W17)",
  request: {
    body: { content: { "application/json": { schema: ChatCreateBody } }, required: true },
  },
  responses: {
    202: {
      content: { "application/json": { schema: ChatCreateResponse } },
      description: "chat session created",
    },
    ...errorResponses,
  },
});

evaluationWritesRouter.openapi(chatCreateRoute, async (c) => {
  const body = c.req.valid("json");
  await assertTransactionOwnership(c, body.transactionId);

  const upstream = await callUpstream<Record<string, unknown>>(
    c,
    "companyEvaluation",
    "/api/v1/chats",
    { method: "POST", body },
  );
  return c.json(upstream as z.infer<typeof ChatCreateResponse>, 202);
});

// ---- POST /v1/evaluations/chats/:sessionId/messages ------------------------

const chatMessageCreateRoute = createRoute({
  method: "post",
  path: "/evaluations/chats/{sessionId}/messages",
  tags: [tag],
  summary: "Post a follow-up message in an existing chat session (W18)",
  request: {
    params: ChatSessionIdParam,
    body: { content: { "application/json": { schema: ChatMessageCreateBody } }, required: true },
  },
  responses: {
    202: {
      content: { "application/json": { schema: ChatMessageCreateResponse } },
      description: "message accepted; assistant response streamed/persisted upstream",
    },
    ...errorResponses,
  },
});

evaluationWritesRouter.openapi(chatMessageCreateRoute, async (c) => {
  const { sessionId } = c.req.valid("param");
  const { question, scopeCompanyIds, topK } = c.req.valid("json");

  // Re-key `question` → `message` for upstream. (Same v0 ownership trade-off
  // as the read side: chat-session table has no userId column — JWT
  // scope+tenant gate only. Tracked as upstream follow-up in §11.)
  const upstream = await callUpstream<Record<string, unknown>>(
    c,
    "companyEvaluation",
    `/api/v1/chats/transactions/sessions/${encodeURIComponent(sessionId)}`,
    { method: "POST", body: { message: question, scopeCompanyIds, topK } },
  );
  return c.json(upstream as z.infer<typeof ChatMessageCreateResponse>, 202);
});

// =============================================================================
// Clusters (W20)
// =============================================================================

// ---- POST /v1/evaluations/clusters -----------------------------------------

const clusterCreateRoute = createRoute({
  method: "post",
  path: "/evaluations/clusters",
  tags: [tag],
  summary: "Run k-means clustering on a set of companies (W20)",
  request: {
    body: { content: { "application/json": { schema: ClusterCreateBody } }, required: true },
  },
  responses: {
    202: {
      content: { "application/json": { schema: ClusterCreateResponse } },
      description: "cluster job accepted",
    },
    ...errorResponses,
  },
});

evaluationWritesRouter.openapi(clusterCreateRoute, async (c) => {
  const body = c.req.valid("json");
  const upstream = await callUpstream<Record<string, unknown>>(
    c,
    "companyEvaluation",
    "/api/v1/clusters/cluster/k-means",
    { method: "POST", body },
  );
  return c.json(upstream as z.infer<typeof ClusterCreateResponse>, 202);
});

// =============================================================================
// Comparisons (W21)
// =============================================================================

// ---- POST /v1/evaluations/comparisons --------------------------------------

const comparisonCreateRoute = createRoute({
  method: "post",
  path: "/evaluations/comparisons",
  tags: [tag],
  summary: "Start a pairwise comparison job (W21)",
  request: {
    body: { content: { "application/json": { schema: ComparisonCreateBody } }, required: true },
  },
  responses: {
    202: {
      content: { "application/json": { schema: ComparisonCreateResponse } },
      description: "comparison job accepted",
    },
    ...errorResponses,
  },
});

evaluationWritesRouter.openapi(comparisonCreateRoute, async (c) => {
  const body = c.req.valid("json");
  const upstream = await callUpstream<{ comparisonJobId?: string } | null>(
    c,
    "companyEvaluation",
    "/api/v1/comparisons",
    { method: "POST", body },
  );
  if (!upstream?.comparisonJobId) {
    throw new HTTPException(502, { message: "upstream missing comparisonJobId" });
  }
  return c.json({ comparisonJobId: upstream.comparisonJobId }, 202);
});

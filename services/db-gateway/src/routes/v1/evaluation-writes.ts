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
    // §8.v3 — master-data is the source of truth.
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
  // §8.v3 Phase 2c — write path needs async rewiring (gateway publish + local
  // company-evaluation compute-worker subscribe). Until that lands, returning
  // 501 instead of proxying to a destroyed fly app.
  void c.req.valid("json");
  throw new HTTPException(501, {
    message: "best-match POST pending §8.v3 async rewire",
  });
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
  // §8.v3 Phase 2c — write path needs async rewiring (gateway publish + local
  // company-evaluation compute-worker subscribe). Until that lands, returning
  // 501 instead of proxying to a destroyed fly app.
  void c.req.valid("json");
  throw new HTTPException(501, {
    message: "offer-analysis POST pending §8.v3 async rewire",
  });
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
  // §8.v3 Phase 2c — write path needs async rewiring (gateway publish + local
  // company-evaluation compute-worker subscribe). Until that lands, returning
  // 501 instead of proxying to a destroyed fly app.
  void c.req.valid("json");
  throw new HTTPException(501, {
    message: "best-match feedback POST pending §8.v3 async rewire",
  });
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
  // §8.v3 Phase 2c — write path needs async rewiring (gateway publish + local
  // company-evaluation compute-worker subscribe). Until that lands, returning
  // 501 instead of proxying to a destroyed fly app.
  void c.req.valid("json");
  throw new HTTPException(501, {
    message: "chat session POST pending §8.v3 async rewire",
  });
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
  // §8.v3 Phase 2c — write path needs async rewiring (gateway publish + local
  // company-evaluation compute-worker subscribe). Until that lands, returning
  // 501 instead of proxying to a destroyed fly app.
  void c.req.valid("json");
  throw new HTTPException(501, {
    message: "chat message POST pending §8.v3 async rewire",
  });
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
  // §8.v3 Phase 2c — write path needs async rewiring (gateway publish + local
  // company-evaluation compute-worker subscribe). Until that lands, returning
  // 501 instead of proxying to a destroyed fly app.
  void c.req.valid("json");
  throw new HTTPException(501, {
    message: "k-means cluster POST pending §8.v3 async rewire",
  });
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
  // §8.v3 Phase 2c — write path needs async rewiring (gateway publish + local
  // company-evaluation compute-worker subscribe). Until that lands, returning
  // 501 instead of proxying to a destroyed fly app.
  void c.req.valid("json");
  throw new HTTPException(501, {
    message: "comparison POST pending §8.v3 async rewire",
  });
});

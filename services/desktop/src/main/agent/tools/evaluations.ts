import * as yup from "yup";
import { randomUUID } from "node:crypto";
import { defineTool } from "../define-tool";
import type { GatewayClient } from "../gateway-client";
import type { Tool } from "../types";

// Evaluation tools (Phase 8.b read-side, Phase 8.s1 write-side).
//
// company-evaluation is the read-replica that aggregates outputs across
// services + stores embeddings/RAG context. The agent uses it to answer
// "best matches" and comparison questions, and to dispatch new offer-
// analysis / best-match jobs from chat (the §8.s1 surface).
//
// RAG/vector-search tool: now wired via the existing
// `POST /v1/evaluations/offer-analysis` endpoint (global semantic search
// across the user's whole corpus, no transaction binding). The
// `POST /v1/evaluations/best-matches` route gives the per-transaction
// "deep research" path.

const EVALUATION_TOPICS = [
  "keywords",
  "companyProfile",
  "businessPurpose",
  "serpCategory",
  "sales",
  "profits",
  "employees",
  "totalAssets",
  "stateOfAffairs",
] as const;

/** Sensible default topic set for best-match jobs the agent kicks off
 *  itself. Covers the most useful comparison axes for a typical offer
 *  (what the company does + how big it is + how it's doing). */
const DEFAULT_TOPICS: Array<(typeof EVALUATION_TOPICS)[number]> = [
  "keywords",
  "companyProfile",
  "businessPurpose",
  "sales",
  "employees",
];

interface Ctx {
  gateway: GatewayClient;
}

export function buildEvaluationTools(ctx: Ctx): Tool[] {
  const { gateway } = ctx;

  const bestMatchesList = defineTool({
    name: "evaluation_best_matches_list",
    description:
      "List best-match jobs the user has run for a transaction (W15). Each item carries the comparison configuration and final ranking job id.",
    parameters: {
      type: "object",
      properties: {
        transactionId: { type: "string" },
        page: { type: "integer", minimum: 1, default: 1 },
        pageSize: { type: "integer", minimum: 1, maximum: 100, default: 20 },
      },
      required: ["transactionId"],
    },
    schema: yup.object({
      transactionId: yup.string().trim().min(1).required(),
      page: yup.number().integer().min(1).default(1),
      pageSize: yup.number().integer().min(1).max(100).default(20),
    }),
    run: async (args, c) => {
      const data = await gateway.request<{ items?: unknown[]; total?: number }>(
        "/v1/evaluations/best-matches",
        {
          query: {
            transactionId: args.transactionId,
            page: args.page,
            pageSize: args.pageSize,
          },
          signal: c.signal,
        },
      );
      return { items: data.items ?? [], total: data.total ?? 0 };
    },
    preview: (r) => `${r.total} best-match job(s)`,
  });

  const bestMatchGet = defineTool({
    name: "evaluation_best_match_get",
    description:
      "Get a best-match job's full result (ranked candidates with scores).",
    parameters: {
      type: "object",
      properties: { bestMatchId: { type: "string" } },
      required: ["bestMatchId"],
    },
    schema: yup.object({ bestMatchId: yup.string().trim().min(1).required() }),
    run: async (args, c) =>
      gateway.request<Record<string, unknown>>(
        `/v1/evaluations/best-matches/${encodeURIComponent(args.bestMatchId)}`,
        { signal: c.signal },
      ),
    preview: () => "best-match job fetched",
  });

  const comparisonGet = defineTool({
    name: "evaluation_comparison_get",
    description:
      "Get a head-to-head comparison result between companies (W22).",
    parameters: {
      type: "object",
      properties: { comparisonId: { type: "string" } },
      required: ["comparisonId"],
    },
    schema: yup.object({ comparisonId: yup.string().trim().min(1).required() }),
    run: async (args, c) =>
      gateway.request<Record<string, unknown>>(
        `/v1/evaluations/comparisons/${encodeURIComponent(args.comparisonId)}`,
        { signal: c.signal },
      ),
    preview: () => "comparison fetched",
  });

  const offerAnalysis = defineTool({
    name: "evaluation_offer_analysis",
    description:
      "Global semantic search across the ENTIRE company corpus (no transaction binding) for matches against a free-form offer / Ausschreibung. Faster than a per-transaction deep research — vector similarity + LLM ranking, no per-company evaluation. Use as the DEFAULT path when the user describes an offer / need / Lieferantensuche without naming a specific Vorgang. Returns a `bestMatchJobId` (the same shape `evaluation_start_best_match` returns); poll `evaluation_best_match_get` to read the ranked result. Typical wall-clock: 30–90 s for a small corpus, longer for thousands of companies.",
    parameters: {
      type: "object",
      required: ["offer"],
      properties: {
        offer: {
          type: "string",
          minLength: 1,
          description:
            "Free-form offer text. Take it verbatim from the user message / pasted block / parsed attachment — no rewrite. The upstream LLM does its own paraphrasing.",
        },
        topK: {
          type: "integer",
          minimum: 1,
          maximum: 100,
          description:
            "How many candidates to surface. Default 10 — keep it small unless the user asks for a wider sweep ('zeig mir 25 Treffer').",
        },
      },
    },
    schema: yup
      .object({
        offer: yup.string().required().min(1),
        topK: yup.number().integer().min(1).max(100).optional(),
      })
      .noUnknown(true),
    preview: (r: { bestMatchJobId: string }) =>
      `offer-analysis: tx-job ${r.bestMatchJobId.slice(0, 8)}…`,
    run: async (args, ctx) => {
      const body: { offer: string; topK?: number } = { offer: args.offer };
      if (args.topK !== undefined) body.topK = args.topK;
      ctx.log(
        `evaluation_offer_analysis: ${args.offer.slice(0, 80)}… → POST /v1/evaluations/offer-analysis`,
      );
      return gateway.request<{ bestMatchJobId: string }>(
        "/v1/evaluations/offer-analysis",
        {
          method: "POST",
          body,
          idempotencyKey: randomUUID(),
          signal: ctx.signal,
        },
      );
    },
  });

  const startBestMatch = defineTool({
    name: "evaluation_start_best_match",
    description:
      "Start a per-transaction DEEP RESEARCH best-match job. Picks the top candidates among the companies inside one Vorgang (every row gets a full LLM evaluation, much slower than `evaluation_offer_analysis` but with richer per-company rationale). Use when the user explicitly scopes to a transaction ('in diesem Vorgang', 'in der letzten Transaktion', 'unter diesen Importen') OR when the user picked the deep-research option after the scope disambiguation. Requires the transaction to contain ≥2 companies. Returns a `bestMatchJobId`; poll `evaluation_best_match_get` for the ranked result. Typical wall-clock: 2–5 min depending on company count.",
    parameters: {
      type: "object",
      required: ["transactionId", "input"],
      properties: {
        transactionId: {
          type: "string",
          description:
            "Transaction the job runs against. Resolve via `transactions_list` if the user said 'die letzte Transaktion' without naming one.",
        },
        input: {
          type: "string",
          minLength: 1,
          description:
            "Free-form offer / criterion text. Take it verbatim from the user.",
        },
        topics: {
          type: "array",
          items: { type: "string", enum: EVALUATION_TOPICS as unknown as string[] },
          description:
            "Comparison axes. Defaults to a sensible set (keywords + companyProfile + businessPurpose + sales + employees) covering 'what they do' + 'how big they are' + 'how they're doing'. Pass an explicit subset only when the user named one ('vergleiche nur Umsatz', 'nur nach Branche').",
        },
        companyIds: {
          type: "array",
          items: { type: "string" },
          description:
            "Optional: restrict to a subset of companies in the transaction (≥2). When omitted the upstream uses every company in the transaction. Use when the user named specific candidates ('vergleiche ACME, BAR und BAZ in dem Vorgang').",
        },
      },
    },
    schema: yup
      .object({
        transactionId: yup.string().required().min(1),
        input: yup.string().required().min(1),
        topics: yup
          .array()
          .of(yup.string().oneOf(EVALUATION_TOPICS).required())
          .optional(),
        companyIds: yup
          .array()
          .of(yup.string().required().min(1))
          .min(2)
          .optional(),
      })
      .noUnknown(true),
    preview: (r: { bestMatchJobId: string }) =>
      `best-match started: ${r.bestMatchJobId.slice(0, 8)}…`,
    run: async (args, ctx) => {
      // Resolve companyIds when the caller didn't supply them — the
      // gateway's BestMatchCreateBody requires `companyIds: string[]`
      // with a min-2 cap, but the user-facing "deep research in this
      // transaction" intent typically means "every row in the
      // transaction". Fan out to /entities to get the list.
      let companyIds = args.companyIds;
      if (!companyIds) {
        const entities = await gateway.request<{
          items?: Array<{ companyId?: string }>;
        }>(
          `/v1/transactions/${encodeURIComponent(args.transactionId)}/entities`,
          { signal: ctx.signal },
        );
        const ids = (entities.items ?? [])
          .map((e) => e.companyId)
          .filter((x): x is string => typeof x === "string" && x.length > 0);
        // Dedup; pipeline cells can share companyIds across stage
        // entries.
        companyIds = Array.from(new Set(ids));
      }
      if (companyIds.length < 2) {
        throw new Error(
          `Best-match braucht ≥ 2 Firmen im Vorgang; gefunden: ${companyIds.length}.`,
        );
      }

      const topics =
        args.topics && args.topics.length > 0 ? args.topics : DEFAULT_TOPICS;

      ctx.log(
        `evaluation_start_best_match: tx=${args.transactionId} companies=${companyIds.length} topics=${topics.join(",")}`,
      );

      return gateway.request<{ bestMatchJobId: string }>(
        "/v1/evaluations/best-matches",
        {
          method: "POST",
          body: {
            transactionId: args.transactionId,
            input: args.input,
            companyIds,
            topics,
          },
          idempotencyKey: randomUUID(),
          signal: ctx.signal,
        },
      );
    },
  });

  return [
    bestMatchesList,
    bestMatchGet,
    comparisonGet,
    offerAnalysis,
    startBestMatch,
  ];
}

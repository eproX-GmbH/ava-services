import * as yup from "yup";
import { defineTool } from "../define-tool";
import type { GatewayClient } from "../gateway-client";
import type { Tool } from "../types";

// Read-only evaluation tools (Phase 8.b).
//
// company-evaluation is the read-replica that aggregates outputs across
// services + stores embeddings/RAG context. The agent uses it to answer
// "best matches" and comparison questions.
//
// RAG/vector-search tool: deferred. Today the gateway has no `/v1/evaluations/search`
// endpoint — adding it requires upstream work in company-evaluation
// (expose a vector-similarity query). The model will lean on the structured
// reads below until that lands. See DESKTOP_DATA_FLOW.md §13 (8.i) for the
// follow-up checklist.

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

  return [bestMatchesList, bestMatchGet, comparisonGet];
}

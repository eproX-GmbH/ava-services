import * as yup from "yup";
import { defineTool } from "../define-tool";
import type { GatewayClient } from "../gateway-client";
import type { Tool } from "../types";

// Read-only transaction tools (Phase 8.b).
//
// A "transaction" here is the user's processing job — an ingest run that
// fans out across companies and stages. Useful for the agent to answer
// "what's running?" and "did stage X fail for company Y?" questions.

interface Ctx {
  gateway: GatewayClient;
}

export function buildTransactionTools(ctx: Ctx): Tool[] {
  const { gateway } = ctx;

  const list = defineTool({
    name: "transactions_list",
    description:
      "List the user's recent processing transactions (ingest runs). Paginated. Use for 'what's running?' or 'show my last imports'.",
    parameters: {
      type: "object",
      properties: {
        page: { type: "integer", minimum: 1, default: 1 },
        pageSize: { type: "integer", minimum: 1, maximum: 100, default: 20 },
      },
    },
    schema: yup.object({
      page: yup.number().integer().min(1).default(1),
      pageSize: yup.number().integer().min(1).max(100).default(20),
    }),
    run: async (args, c) => {
      const data = await gateway.request<{
        items?: unknown[];
        total?: number;
        page?: number;
        pageSize?: number;
      }>("/v1/transactions", {
        query: { page: args.page, pageSize: args.pageSize },
        signal: c.signal,
      });
      return {
        items: data.items ?? [],
        total: data.total ?? 0,
        page: data.page ?? args.page,
        pageSize: data.pageSize ?? args.pageSize,
      };
    },
    preview: (r) => `${r.total} transaction${r.total === 1 ? "" : "s"}`,
  });

  const get = defineTool({
    name: "transaction_get",
    description: "Get one transaction by id (status, counts, started/finished timestamps).",
    parameters: {
      type: "object",
      properties: { transactionId: { type: "string" } },
      required: ["transactionId"],
    },
    schema: yup.object({ transactionId: yup.string().trim().min(1).required() }),
    run: async (args, c) =>
      gateway.request<Record<string, unknown>>(
        `/v1/transactions/${encodeURIComponent(args.transactionId)}`,
        { signal: c.signal },
      ),
    preview: (r) => {
      const status = (r as { status?: string }).status;
      return status ? `transaction: ${status}` : "transaction fetched";
    },
  });

  const entities = defineTool({
    name: "transaction_entities",
    description:
      "List per-company state for a transaction: which companies are running, done, or errored.",
    parameters: {
      type: "object",
      properties: { transactionId: { type: "string" } },
      required: ["transactionId"],
    },
    schema: yup.object({ transactionId: yup.string().trim().min(1).required() }),
    run: async (args, c) => {
      const data = await gateway.request<{ items?: unknown[] }>(
        `/v1/transactions/${encodeURIComponent(args.transactionId)}/entities`,
        { signal: c.signal },
      );
      return { items: data.items ?? [] };
    },
    preview: (r) => `${r.items.length} entities`,
  });

  const errors = defineTool({
    name: "transaction_errors",
    description:
      "List processing errors for a transaction. Use to answer 'what failed?'.",
    parameters: {
      type: "object",
      properties: { transactionId: { type: "string" } },
      required: ["transactionId"],
    },
    schema: yup.object({ transactionId: yup.string().trim().min(1).required() }),
    run: async (args, c) => {
      const data = await gateway.request<{ items?: unknown[] }>(
        `/v1/transactions/${encodeURIComponent(args.transactionId)}/errors`,
        { signal: c.signal },
      );
      return { items: data.items ?? [] };
    },
    preview: (r) =>
      r.items.length === 0 ? "no errors" : `${r.items.length} error(s)`,
  });

  const pipeline = defineTool({
    name: "transaction_pipeline",
    description:
      "Get the per-company × per-stage state matrix for a transaction. Heavy payload — only call when the user asks for stage-level detail.",
    parameters: {
      type: "object",
      properties: { transactionId: { type: "string" } },
      required: ["transactionId"],
    },
    schema: yup.object({ transactionId: yup.string().trim().min(1).required() }),
    run: async (args, c) =>
      gateway.request<Record<string, unknown>>(
        `/v1/transactions/${encodeURIComponent(args.transactionId)}/pipeline`,
        { signal: c.signal },
      ),
    preview: () => "pipeline matrix fetched",
  });

  return [list, get, entities, errors, pipeline];
}

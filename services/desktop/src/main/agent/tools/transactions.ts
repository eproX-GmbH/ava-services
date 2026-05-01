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

/**
 * Pull a usable display name out of the gateway's company-detail payload.
 * Master-data uses `name` for the legal/registered name; some legacy rows
 * surface it under `legalName`. Falls through to null so the caller can
 * decide whether to swap in the companyId.
 */
function pickCompanyName(payload: Record<string, unknown>): string | null {
  const name = payload.name ?? payload.legalName ?? payload.companyName;
  return typeof name === "string" && name.trim().length > 0
    ? name.trim()
    : null;
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
      "Get the per-company × per-stage state matrix for a transaction. " +
      "Each row carries `companyId` AND `companyName` so you can refer to " +
      "companies by name in your reply without a separate lookup. The " +
      "top-level `companies` map gives the same id→name dictionary for " +
      "convenience. Heavy payload — only call when the user asks for " +
      "stage-level detail.",
    parameters: {
      type: "object",
      properties: { transactionId: { type: "string" } },
      required: ["transactionId"],
    },
    schema: yup.object({ transactionId: yup.string().trim().min(1).required() }),
    run: async (args, c) => {
      const data = await gateway.request<{
        rows?: Array<Record<string, unknown>>;
        [k: string]: unknown;
      }>(
        `/v1/transactions/${encodeURIComponent(args.transactionId)}/pipeline`,
        { signal: c.signal },
      );

      // Resolve company names in parallel. The master-data store doesn't
      // expose a bulk-by-ids endpoint yet, so we fan out per-id; typical
      // import transactions stay well under 200 companies which is fine
      // over the local gateway. Failures don't poison the response — a
      // missing name falls through as null and the agent prompt tells
      // the model to fall back to the companyId.
      const rows = Array.isArray(data.rows) ? data.rows : [];
      const companyIds = rows
        .map((r) => (typeof r.companyId === "string" ? r.companyId : null))
        .filter((id): id is string => id !== null);

      const nameByCompanyId: Record<string, string | null> = {};
      await Promise.all(
        companyIds.map(async (id) => {
          try {
            const co = await gateway.request<Record<string, unknown>>(
              `/v1/companies/${encodeURIComponent(id)}`,
              { signal: c.signal },
            );
            const name = pickCompanyName(co);
            nameByCompanyId[id] = name;
          } catch {
            nameByCompanyId[id] = null;
          }
        }),
      );

      const enrichedRows = rows.map((r) => {
        const id = typeof r.companyId === "string" ? r.companyId : "";
        return { ...r, companyName: id ? nameByCompanyId[id] ?? null : null };
      });

      return {
        ...data,
        rows: enrichedRows,
        companies: nameByCompanyId,
      };
    },
    preview: () => "pipeline matrix fetched",
  });

  return [list, get, entities, errors, pipeline];
}

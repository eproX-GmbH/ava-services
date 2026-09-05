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
        // O8 — geteilte Vorgaenge der Organisation mitliefern (Feld `shared`).
        query: { page: args.page, pageSize: args.pageSize, includeShared: 1 },
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

  // O8 — Teilen in der Organisation.
  const share = defineTool({
    name: "transaction_share",
    summary: "Einen eigenen Vorgang mit der Organisation teilen (oder die Freigabe zuruecknehmen).",
    category: "transaktion vorgang teilen organisation freigabe",
    description:
      "Teilt einen eigenen Vorgang (Transaktion) mit allen Mitgliedern der Organisation: sie sehen ihn unter 'Aus der Organisation' " +
      "und koennen ihn uebernehmen. Mit zuruecknehmen=true wird die Freigabe beendet (bereits uebernommene Kopien bleiben). " +
      "transactionId aus transactions_list. Fragt vor der Ausfuehrung nach.",
    parameters: {
      type: "object",
      required: ["transactionId"],
      properties: {
        transactionId: { type: "string" },
        zuruecknehmen: { type: "boolean", description: "true = Freigabe zuruecknehmen statt teilen" },
        notiz: { type: "string", description: "Optionale Notiz fuer die Mitglieder" },
      },
    },
    schema: yup
      .object({ transactionId: yup.string().trim().min(4).required(), zuruecknehmen: yup.boolean().optional(), notiz: yup.string().trim().max(500).optional() })
      .noUnknown(true),
    preview: (r: { ok?: boolean; abgebrochen?: boolean; zurueckgenommen?: boolean }) =>
      r.abgebrochen ? "abgebrochen" : r.zurueckgenommen ? "Freigabe zurueckgenommen" : "mit Organisation geteilt",
    run: async (args, c) => {
      const value = await c.ui.confirmAction(
        {
          kind: "additive",
          prompt: args.zuruecknehmen
            ? `Freigabe des Vorgangs ${args.transactionId.slice(0, 8)}… zuruecknehmen?`
            : `Vorgang ${args.transactionId.slice(0, 8)}… mit allen Mitgliedern der Organisation teilen? Sie koennen ihn ansehen und uebernehmen.`,
          confirmValue: "ja",
          options: [
            { value: "ja", label: args.zuruecknehmen ? "Zuruecknehmen" : "Teilen" },
            { value: "nein", label: "Abbrechen" },
          ],
        },
        c.signal,
      );
      if (value !== "ja") return { ok: false, abgebrochen: true };
      if (args.zuruecknehmen) {
        const d = await gateway.request<{ shared?: { shareId: string } }>(`/v1/transactions/${encodeURIComponent(args.transactionId)}`, { method: "GET" });
        if (!d.shared) return { ok: false, hinweis: "Dieser Vorgang ist nicht geteilt." };
        await gateway.request(`/v1/tenants/me/shares/${encodeURIComponent(d.shared.shareId)}`, { method: "DELETE" });
        return { ok: true, zurueckgenommen: true };
      }
      await gateway.request("/v1/tenants/me/shares", { method: "POST", body: { kind: "transaction", refId: args.transactionId, ...(args.notiz ? { note: args.notiz } : {}) } });
      return { ok: true };
    },
  });

  const adopt = defineTool({
    name: "transaction_adopt",
    summary: "Einen geteilten Vorgang der Organisation uebernehmen (eigene Kopie samt Verarbeitungsfortschritt).",
    category: "transaktion vorgang uebernehmen organisation firmen",
    description:
      "Legt fuer dich eine eigene Kopie eines mit der Organisation geteilten Vorgangs an: gleiche Firmen, Verarbeitungsfortschritt " +
      "wird kopiert, nichts wird neu verarbeitet. Die Firmen erscheinen danach in 'Meine Firmen'. transactionId aus " +
      "transactions_list (Eintraege mit shared.own=false). Fragt vor der Ausfuehrung nach.",
    parameters: { type: "object", required: ["transactionId"], properties: { transactionId: { type: "string" }, name: { type: "string", description: "Optionaler Name der Kopie" } } },
    schema: yup.object({ transactionId: yup.string().trim().min(4).required(), name: yup.string().trim().max(200).optional() }).noUnknown(true),
    preview: (r: { ok?: boolean; abgebrochen?: boolean; transactionId?: string; copiedProgress?: number }) =>
      r.abgebrochen ? "abgebrochen" : `uebernommen → ${r.transactionId?.slice(0, 8)}… (${r.copiedProgress ?? 0} Fortschrittszeilen kopiert)`,
    run: async (args, c) => {
      const value = await c.ui.confirmAction(
        {
          kind: "additive",
          prompt: `Vorgang ${args.transactionId.slice(0, 8)}… uebernehmen? Du bekommst eine eigene Kopie samt Fortschritt; die Firmen landen in 'Meine Firmen'.`,
          confirmValue: "ja",
          options: [
            { value: "ja", label: "Uebernehmen" },
            { value: "nein", label: "Abbrechen" },
          ],
        },
        c.signal,
      );
      if (value !== "ja") return { ok: false, abgebrochen: true };
      const r = await gateway.request<{ transactionId: string; name: string; companyCount: number; copiedProgress: number }>(
        `/v1/transactions/${encodeURIComponent(args.transactionId)}/adopt`,
        { method: "POST", body: args.name ? { name: args.name } : {} },
      );
      return { ok: true, ...r, seite: `#/transactions/${r.transactionId}` };
    },
  });

  return [list, get, entities, errors, pipeline, share, adopt];
}

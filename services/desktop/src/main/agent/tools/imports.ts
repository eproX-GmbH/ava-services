import { randomUUID } from "node:crypto";
import * as yup from "yup";
import { defineTool } from "../define-tool";
import type { Tool } from "../types";
import type { GatewayClient } from "../gateway-client";
import type { AttachmentStore } from "../attachment-store";
import type { CrmManager } from "../../crm";
import type { CrmProvider } from "../../crm/types";
import { fetchCompaniesFromCrm } from "../../crm/fetch-companies";

// Bulk-import tools (Phase 8.e — Excel-in-chat Scope C, slice 1).
//
// Replaces the per-row `company_search` storm the model used to do when
// the user said "import the file" / "Bitte durchlauf starten". Now the
// agent makes a single tool call and the gateway → master-data pipeline
// handles all rows in the background.
//
// Wire shape:
//   - Renderer parses the xlsx for the chip preview, then ships the raw
//     bytes to main on send. They land in AttachmentStore keyed by a
//     stable `attachmentId` that's woven into the user prompt.
//   - This tool reads the bytes back out, builds multipart/form-data
//     and POSTs `POST /v1/imports/excel` with the column mapping as
//     query params (matching the existing Ingest.tsx route).
//   - Gateway returns `202 { transactionId }`. The agent reports that
//     id and can subsequently call `transaction_pipeline` /
//     `transactions_list` to track progress.
//
// Idempotency:
//   - We mint a fresh `Idempotency-Key` per call. Re-invoking the tool
//     for the same attachment intentionally creates a new transaction
//     (the user explicitly said "go again"); within a single tool call,
//     a network retry hits the same key and the gateway dedupes.

const SUPPORTED_MIME: Record<string, string> = {
  ".xlsx": "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
  ".xls": "application/vnd.ms-excel",
  ".csv": "text/csv",
  ".tsv": "text/tab-separated-values",
};

function guessMime(filename: string): string {
  const lower = filename.toLowerCase();
  for (const [ext, mime] of Object.entries(SUPPORTED_MIME)) {
    if (lower.endsWith(ext)) return mime;
  }
  return "application/octet-stream";
}

export function buildImportTools(deps: {
  gateway: GatewayClient;
  attachments: AttachmentStore;
  /** v0.1.57 — used by `import_companies_from_crm` to borrow the user's
   *  OAuth token + page through the CRM API. Same singleton the Settings
   *  card and the connect_crm/disconnect_crm tools use. */
  crm: CrmManager;
}): Tool[] {
  const importExcel = defineTool({
    name: "import_excel",
    description:
      "Start a background bulk import for a spreadsheet the user has attached. " +
      "Use this whenever the user wants to process every row of an attachment " +
      "(\"import this\", \"Durchlauf starten\", \"process all rows\", \"alle Firmen anlegen\"). " +
      "Do NOT iterate `company_search` over rows for this — that's slow, " +
      "wasteful, and skips the master-data pipeline (profile, website, " +
      "contacts, evaluations are auto-fanned out by the importer). " +
      "You must have already confirmed the column mapping with the user " +
      "(via `ask_user_choice` or by stating the inferred mapping and " +
      "getting a 'go'). Returns a `transactionId` you can hand back to " +
      "the user; they can watch progress in the Transactions view.",
    parameters: {
      type: "object",
      required: ["attachmentId", "companyNameColumns"],
      properties: {
        attachmentId: {
          type: "string",
          description:
            "The `id: …` value from the `[attachment: …]` block in the user's message.",
        },
        companyNameColumns: {
          type: "array",
          items: { type: "string", minLength: 1 },
          minItems: 1,
          description:
            "One or more column header names that hold the company name. Pass the EXACT header text as it appeared in the attachment block (e.g. \"Firma\", \"Company\"), not column letters.",
        },
        cityColumns: {
          type: "array",
          items: { type: "string", minLength: 1 },
          description:
            "Optional. One or more column header names that hold the city/location. Same rules as companyNameColumns.",
        },
        name: {
          type: "string",
          description:
            "Optional human-readable label for this import run; surfaces in the Transactions view. Defaults to the filename.",
        },
        isFuzzy: {
          type: "boolean",
          description:
            "Allow fuzzy matching against existing companies. Default false (strict).",
        },
      },
    },
    schema: yup
      .object({
        attachmentId: yup.string().required().min(1),
        companyNameColumns: yup
          .array()
          .of(yup.string().required().min(1))
          .required()
          .min(1),
        cityColumns: yup.array().of(yup.string().required().min(1)).optional(),
        name: yup.string().optional(),
        isFuzzy: yup.boolean().optional(),
      })
      .noUnknown(true),
    preview: (r: { transactionId: string; rows: number; filename: string }) =>
      `import "${r.filename}" (${r.rows} rows) → tx ${r.transactionId.slice(0, 8)}…`,
    run: async (args, ctx) => {
      const att = deps.attachments.get(args.attachmentId);
      if (!att) {
        throw new Error(
          `attachment "${args.attachmentId}" is not staged. Ask the user to re-attach the file — staged uploads expire after 30 minutes.`,
        );
      }

      const totalRows = att.sheets.reduce((n, s) => n + s.totalRows, 0);
      const form = new FormData();
      // Field name `file` matches the gateway's import route. We wrap
      // the bytes in a Blob — Node 20+ / Electron's fetch supports this
      // natively, no formdata polyfill needed.
      const blob = new Blob([new Uint8Array(att.bytes)], {
        type: guessMime(att.filename),
      });
      form.append("file", blob, att.filename);

      const query: Record<string, string | string[] | boolean | undefined> = {
        companyNameIdentifiers: args.companyNameColumns,
      };
      if (args.cityColumns && args.cityColumns.length > 0) {
        query.city = args.cityColumns;
      }
      if (args.name) query.name = args.name;
      if (args.isFuzzy !== undefined) query.isFuzzy = args.isFuzzy;

      ctx.log(
        `import_excel: ${att.filename} (${totalRows} rows) → POST /v1/imports/excel`,
      );

      const response = await deps.gateway.request<{ transactionId: string }>(
        "/v1/imports/excel",
        {
          method: "POST",
          query,
          multipart: form,
          idempotencyKey: randomUUID(),
          signal: ctx.signal,
          // Option D — dispatch endpoint, attach user-LLM headers so
          // master-data forwards them as AMQP headers to the producers.
          attachUserLlm: true,
        },
      );

      // The bytes have done their job — free them so an idle session
      // doesn't hold onto a large workbook.
      deps.attachments.discard(args.attachmentId);

      return {
        transactionId: response.transactionId,
        filename: att.filename,
        rows: totalRows,
        sheets: att.sheets.map((s) => ({
          name: s.name,
          headers: s.headers,
          totalRows: s.totalRows,
        })),
        companyNameColumns: args.companyNameColumns,
        cityColumns: args.cityColumns ?? [],
      };
    },
  });

  // ---- import_status ------------------------------------------------------
  //
  // Lightweight "how's the import going?" snapshot. Agents tend to
  // overshoot here — calling `transaction_pipeline` (heavy stage matrix)
  // when the user just wants "37/142 done, 2 failed". This tool reduces
  // `/v1/transactions/:id/entities` (5 states: pending, in_progress,
  // completed, failed, skipped) into per-state counts, plus the first
  // few failure messages so the agent can surface specific errors
  // without dumping the full pipeline.
  //
  // Pagination: master-data returns entities paginated; we walk pages
  // until `items.length < pageSize` or total is reached. Capped at
  // MAX_PAGES so a runaway transaction can't pin the tool. 10 × 100 =
  // 1000 entities — comfortably above typical lead-list sizes; bigger
  // imports just get a partial summary marked `truncated: true`.

  const MAX_ENTITY_PAGE_SIZE = 100;
  const MAX_ENTITY_PAGES = 10;

  type EntityState =
    | "pending"
    | "in_progress"
    | "completed"
    | "failed"
    | "skipped";

  interface EntityRow {
    id?: string;
    companyId?: string;
    state?: string;
    errorMessage?: string;
    finishedAt?: string | null;
    updatedAt?: string;
  }

  interface EntitiesPage {
    items?: EntityRow[];
    total?: number;
    page?: number;
    pageSize?: number;
  }

  const importStatus = defineTool({
    name: "import_status",
    description:
      "Quick progress snapshot for an import (or any transaction). Returns " +
      "per-state counts (pending / in_progress / completed / failed / skipped) " +
      "plus up to 5 failure messages. Prefer this over `transaction_pipeline` " +
      "when the user asks 'how far is it?', 'wie weit ist der Import?', " +
      "'is it done?' — pipeline is heavier and stage-level. If the user " +
      "just imported a file in this conversation, the transactionId is " +
      "in the previous `import_excel` tool result; use that.",
    parameters: {
      type: "object",
      required: ["transactionId"],
      properties: {
        transactionId: {
          type: "string",
          description:
            "The transactionId returned by `import_excel` (or any other transaction kick-off).",
        },
      },
    },
    schema: yup
      .object({
        transactionId: yup.string().required().min(1),
      })
      .noUnknown(true),
    preview: (r: {
      counts: Record<EntityState, number>;
      total: number;
      done: number;
    }) => {
      const pct = r.total > 0 ? Math.round((r.done / r.total) * 100) : 0;
      return `${r.done}/${r.total} done (${pct}%) — ${r.counts.failed} failed`;
    },
    run: async (args, ctx) => {
      const counts: Record<EntityState, number> = {
        pending: 0,
        in_progress: 0,
        completed: 0,
        failed: 0,
        skipped: 0,
      };
      const failureSamples: Array<{
        companyId?: string;
        errorMessage?: string;
      }> = [];

      let page = 1;
      let scanned = 0;
      let total: number | undefined;
      let truncated = false;

      while (page <= MAX_ENTITY_PAGES) {
        const data = await deps.gateway.request<EntitiesPage>(
          `/v1/transactions/${encodeURIComponent(args.transactionId)}/entities`,
          {
            query: { page, pageSize: MAX_ENTITY_PAGE_SIZE },
            signal: ctx.signal,
          },
        );
        const items = data.items ?? [];
        if (typeof data.total === "number") total = data.total;

        for (const row of items) {
          scanned += 1;
          // Cheap, defensive: bucket unknown states under `pending`
          // rather than silently dropping them. Future master-data
          // states (e.g. "queued") show up as "pending" until we
          // notice the discrepancy and update.
          const bucket: EntityState =
            row.state === "completed" ||
            row.state === "failed" ||
            row.state === "skipped" ||
            row.state === "in_progress" ||
            row.state === "pending"
              ? row.state
              : "pending";
          counts[bucket] += 1;
          if (
            row.state === "failed" &&
            row.errorMessage &&
            failureSamples.length < 5
          ) {
            failureSamples.push({
              ...(row.companyId ? { companyId: row.companyId } : {}),
              errorMessage: row.errorMessage,
            });
          }
        }

        if (items.length < MAX_ENTITY_PAGE_SIZE) break;
        if (total !== undefined && scanned >= total) break;
        page += 1;
        if (page > MAX_ENTITY_PAGES) {
          truncated = true;
          break;
        }
      }

      const done = counts.completed + counts.failed + counts.skipped;
      const resolvedTotal = total ?? scanned;

      return {
        transactionId: args.transactionId,
        counts,
        total: resolvedTotal,
        scanned,
        done,
        running: counts.in_progress + counts.pending,
        truncated,
        failureSamples,
      };
    },
  });

  // ---- import_company (single-company ingest) -----------------------------
  //
  // The 1-row counterpart to `import_excel`. The user says "Leg mir
  // ACME GmbH aus Köln an" or "Add Foo Industries from Berlin" — the
  // gateway hand-encodes a single-row xlsx and pushes it through the
  // same master-data pipeline, so the resulting company gets the full
  // profile/website/contacts/evaluations fan-out.

  const importCompany = defineTool({
    name: "import_company",
    description:
      "Ingest a single company by name + city, kicking off the full master-data " +
      "pipeline (profile, website, publications, contacts, evaluations). Use " +
      "this when the user asks to add or research one specific company they " +
      "haven't attached a spreadsheet for (e.g. \"Leg mir Foo GmbH aus Berlin an\", " +
      "\"add ACME from Munich and find their data\"). For multiple companies " +
      "from a spreadsheet, use `import_excel` instead. Returns a transactionId " +
      "you can hand back; progress is checkable via `import_status`.",
    parameters: {
      type: "object",
      required: ["name", "city"],
      properties: {
        name: {
          type: "string",
          description: "Company name as the user gave it (e.g. \"ACME GmbH\").",
        },
        city: {
          type: "string",
          description:
            "City / location the user gave (e.g. \"Berlin\", \"Köln\"). Required by master-data to disambiguate same-named companies.",
        },
        transactionName: {
          type: "string",
          description:
            "Optional human-readable label for the transaction (shows up in the Transactions view). Defaults to the company name.",
        },
        isFuzzy: {
          type: "boolean",
          description:
            "Allow fuzzy matching against existing companies (handles minor name variants). Default false.",
        },
      },
    },
    schema: yup
      .object({
        name: yup.string().required().min(1),
        city: yup.string().required().min(1),
        transactionName: yup.string().optional(),
        isFuzzy: yup.boolean().optional(),
      })
      .noUnknown(true),
    preview: (r: { transactionId: string; name: string }) =>
      `import "${r.name}" → tx ${r.transactionId.slice(0, 8)}…`,
    run: async (args, ctx) => {
      ctx.log(`import_company: ${args.name} / ${args.city}`);
      const response = await deps.gateway.request<{ transactionId: string }>(
        "/v1/companies",
        {
          method: "POST",
          body: {
            name: args.name,
            city: args.city,
            ...(args.transactionName
              ? { transactionName: args.transactionName }
              : {}),
            ...(args.isFuzzy !== undefined ? { isFuzzy: args.isFuzzy } : {}),
          },
          idempotencyKey: randomUUID(),
          signal: ctx.signal,
          // Option D — dispatch endpoint, attach user-LLM headers.
          attachUserLlm: true,
        },
      );
      return {
        transactionId: response.transactionId,
        name: args.name,
        city: args.city,
      };
    },
  });

  // ---- import_companies_from_crm (v0.1.57 — CRM Phase 2) ------------------
  //
  // Pulls companies from a connected CRM (today: HubSpot; Salesforce +
  // Dynamics return a clear "not yet implemented" so the agent can suggest
  // HubSpot as the working alternative) and starts ONE master-data
  // transaction with all rows. Same downstream pipeline as a file upload —
  // the matrix view shows N companies, SSE progresses live.
  //
  // Why not have the agent loop `import_company`: that creates N transactions
  // (one per row), scattering the matrix and breaking the user's mental model
  // of "I imported a batch". One bulk POST → one transaction.
  //
  // Token handling is invisible to the agent: CrmManager auto-refreshes if
  // near expiry. A 401 from the CRM surfaces as a German error the agent
  // can act on by suggesting a re-connect.

  const importFromCrm = defineTool({
    name: "import_companies_from_crm",
    description:
      "Import companies from the user's CONNECTED CRM (HubSpot, Salesforce, or " +
      "Microsoft Dynamics 365) and start one transaction with the full master- " +
      "data pipeline. Use when the user says \"importiere alle Firmen aus " +
      "HubSpot\", \"start a run for everyone in our CRM\", \"alles aus dem CRM\", " +
      "etc. Today only HubSpot is wired end-to-end; if the user picks Salesforce " +
      "or Dynamics this returns a clear 'not yet implemented' message — fall " +
      "back to suggesting HubSpot or a file upload. Always check `crm_status` " +
      "first if you're unsure which CRM is connected. Returns a transactionId " +
      "you can hand back; progress checkable via `import_status`.",
    parameters: {
      type: "object",
      required: ["provider"],
      properties: {
        provider: {
          type: "string",
          enum: ["hubspot", "salesforce", "dynamics"],
          description: "Which CRM to import from. Must be connected first.",
        },
        transactionName: {
          type: "string",
          description:
            "Optional human-readable label for the transaction. Defaults to '<provider> import: N companies'.",
        },
        isFuzzy: {
          type: "boolean",
          description:
            "Allow fuzzy matching against existing companies. Default false.",
        },
        maxCompanies: {
          type: "number",
          description:
            "Soft cap on rows imported in this run. Default 5000. Use a smaller value for a dry-run / preview, or leave unset to import everything.",
        },
      },
    },
    schema: yup
      .object({
        provider: yup
          .string()
          .required()
          .oneOf(["hubspot", "salesforce", "dynamics"]),
        transactionName: yup.string().optional(),
        isFuzzy: yup.boolean().optional(),
        maxCompanies: yup
          .number()
          .integer()
          .min(1)
          .max(5000)
          .optional(),
      })
      .noUnknown(true),
    preview: (r: {
      transactionId: string;
      provider: string;
      companyCount: number;
      skipped: number;
    }) =>
      `import ${r.companyCount} companies from ${r.provider}` +
      (r.skipped > 0 ? ` (${r.skipped} skipped)` : "") +
      ` → tx ${r.transactionId.slice(0, 8)}…`,
    run: async (args, ctx) => {
      const provider = args.provider as CrmProvider;
      ctx.log(`import_companies_from_crm: provider=${provider}`);

      const fetched = await fetchCompaniesFromCrm(deps.crm, provider, {
        maxCompanies: args.maxCompanies,
      });
      if (fetched.companies.length === 0) {
        // No usable rows — the agent should explain why (skipped count
        // + total) and offer alternatives instead of starting an empty
        // transaction.
        throw new Error(
          `Aus ${provider} konnten keine importierbaren Firmen gelesen werden ` +
            `(insgesamt ${fetched.total} Firmen, davon ${fetched.skipped} ` +
            `ohne Name oder Stadt). Bitte in HubSpot City-Felder pflegen oder ` +
            `eine Datei hochladen.`,
        );
      }

      ctx.log(
        `import_companies_from_crm: ${fetched.companies.length}/${fetched.total} usable, ${fetched.skipped} skipped`,
      );

      const response = await deps.gateway.request<{
        transactionId: string;
        companyCount: number;
      }>("/v1/imports/from-list", {
        method: "POST",
        body: {
          companies: fetched.companies,
          ...(args.transactionName
            ? { transactionName: args.transactionName }
            : {}),
          ...(args.isFuzzy !== undefined ? { isFuzzy: args.isFuzzy } : {}),
        },
        idempotencyKey: randomUUID(),
        signal: ctx.signal,
        // Same Option-D dispatch path as import_excel / import_company:
        // master-data needs the user-LLM headers for the per-company
        // evaluation that runs later in the pipeline.
        attachUserLlm: true,
      });

      return {
        transactionId: response.transactionId,
        provider,
        companyCount: response.companyCount,
        skipped: fetched.skipped,
        total: fetched.total,
      };
    },
  });

  // ---- retry_stage --------------------------------------------------------
  //
  // Pipeline retries are common: the website crawl times out, a contact
  // scrape gets rate-limited, an evaluation LLM hiccups. Without this
  // tool the user has to hunt down the row in the Transactions view and
  // click retry; with it, "retry the website stage for ACME in tx X" is
  // a one-liner. The gateway fans out per-stage to the right upstream.

  const retryStage = defineTool({
    name: "retry_stage",
    description:
      "Re-run a single processing stage for one company inside an existing " +
      "transaction. Useful when one stage failed (e.g. website crawl timed " +
      "out, evaluation LLM errored) but the rest of the pipeline ran. The " +
      "user usually phrases this as \"retry the website for ACME\", \"run " +
      "the contact scrape again for company X\", \"den Profil-Schritt nochmal " +
      "laufen lassen\". You need both the transactionId and the companyId — " +
      "look them up via `transaction_entities` or `import_status` first if " +
      "the user only named the company.",
    parameters: {
      type: "object",
      required: ["transactionId", "companyId", "stage"],
      properties: {
        transactionId: { type: "string" },
        companyId: { type: "string" },
        stage: {
          type: "string",
          enum: [
            "structuredContent",
            "companyPublication",
            "website",
            "companyProfile",
            "companyContact",
            "companyEvaluation",
          ],
          description:
            "Which stage to re-run. `companyEvaluation` fans out across all 5 evaluation producers in parallel.",
        },
        companyName: {
          type: "string",
          description:
            "Optional — some upstream stages re-resolve by name (helps when the row's stored name had a typo).",
        },
      },
    },
    schema: yup
      .object({
        transactionId: yup.string().required().min(1),
        companyId: yup.string().required().min(1),
        stage: yup
          .string()
          .required()
          .oneOf([
            "structuredContent",
            "companyPublication",
            "website",
            "companyProfile",
            "companyContact",
            "companyEvaluation",
          ]),
        companyName: yup.string().optional(),
      })
      .noUnknown(true),
    preview: (r: { ok: boolean; stage: string; dispatched: { ok: boolean }[] }) => {
      const total = r.dispatched.length;
      const okCount = r.dispatched.filter((d) => d.ok).length;
      return r.ok
        ? `retry ${r.stage} → ${okCount}/${total} dispatched`
        : `retry ${r.stage} → FAILED (${okCount}/${total})`;
    },
    run: async (args, ctx) => {
      ctx.log(
        `retry_stage: tx=${args.transactionId} co=${args.companyId} stage=${args.stage}`,
      );

      // Resolve the company name in parallel with the retry dispatch.
      // The agent's reply needs `companyName` to address the user in
      // human terms; without it the model tends to fabricate one.
      // A failed lookup falls through as null — the prompt instructs
      // the agent to fall back to companyId in that case.
      const [response, resolvedName] = await Promise.all([
        deps.gateway.request<{
          transactionId: string;
          companyId: string;
          stage: string;
          ok: boolean;
          dispatched: Array<{
            upstream: string;
            stage: string;
            ok: boolean;
            status?: number;
            body?: unknown;
            error?: string;
          }>;
        }>(
          `/v1/transactions/${encodeURIComponent(args.transactionId)}/entities/${encodeURIComponent(
            args.companyId,
          )}/retry`,
          {
            method: "POST",
            body: {
              stage: args.stage,
              ...(args.companyName ? { companyName: args.companyName } : {}),
            },
            idempotencyKey: randomUUID(),
            signal: ctx.signal,
            // Option D — retry redispatches an existing pipeline stage,
            // which re-publishes work events that LLM producers consume.
            attachUserLlm: true,
          },
        ),
        deps.gateway
          .request<Record<string, unknown>>(
            `/v1/companies/${encodeURIComponent(args.companyId)}`,
            { signal: ctx.signal },
          )
          .then((co) => {
            const raw = co.name ?? co.legalName ?? co.companyName;
            return typeof raw === "string" && raw.trim().length > 0
              ? raw.trim()
              : null;
          })
          .catch(() => null),
      ]);

      // Spiegel den aufgelösten Namen (oder den vom Aufrufer übergebenen)
      // in das Tool-Result, damit der Agent in der Antwort den Firmennamen
      // statt der companyId verwenden kann — ohne weiteren Tool-Call.
      return {
        ...response,
        companyName: resolvedName ?? args.companyName ?? null,
      };
    },
  });

  return [importExcel, importStatus, importCompany, importFromCrm, retryStage];
}

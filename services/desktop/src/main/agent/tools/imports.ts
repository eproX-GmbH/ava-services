import { randomUUID } from "node:crypto";
import * as yup from "yup";
import { defineTool } from "../define-tool";
import type { Tool } from "../types";
import type { AgentMatchRow } from "../../../shared/types";
import type { GatewayClient } from "../gateway-client";
import type { AttachmentStore } from "../attachment-store";
import type { CrmManager } from "../../crm";
import type { CrmProvider } from "../../crm/types";
import {
  fetchCompaniesFromCrm,
  type CompanyForImport,
} from "../../crm/fetch-companies";
import { writeImportReport } from "./import-report";

// v0.1.57 — dry-run preview envelope returned by master-data when the
// import tools are called with `dryRun: true`. Mirrors the shape in
// services/db-gateway/src/routes/v1/schemas.ts (ImportPreviewShape).
//
// The agent uses this to walk the user through unmatched / low-confidence
// rows BEFORE committing the run. After collecting corrections, it
// re-issues the same import call without dryRun (or via a follow-up
// `import_company` / `import_excel` / `import_companies_from_crm` with
// the corrected company list).
interface ImportPreview {
  dryRun: true;
  providedCount: number;
  matched: Array<{
    name: string;
    location: string;
    companyId: string;
    matchingType: "direct" | "history";
  }>;
  unmatched: Array<{
    name: string;
    location: string;
    candidates: Array<{
      companyId: string;
      name: string;
      location: string;
      score: number;
    }>;
  }>;
}

/** Short summary line the agent's `preview` callback can stringify. */
function summarizePreview(p: ImportPreview): string {
  const total = p.matched.length + p.unmatched.length;
  const directCount = p.matched.filter((m) => m.matchingType === "direct").length;
  const historyCount = p.matched.filter((m) => m.matchingType === "history").length;
  return (
    `dry-run: ${total} provided, ` +
    `${directCount} direct, ${historyCount} via history, ` +
    `${p.unmatched.length} unmatched`
  );
}

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
  // v0.1.393 — Dry-Run-Vorschau-Cache. `import_companies` legt das
  // matched/unmatched-Ergebnis hier ab und gibt dem Modell nur ein kurzes
  // `resolveToken` zurück. `resolve_import_matches` zieht die Daten über das
  // Token statt sie vom Modell als Tool-Argumente neu ausschreiben zu lassen
  // (das dauerte bei 24 Firmen viele Sekunden → die Karte erschien gefühlt
  // gar nicht). TTL 30 min, simple Größen-Begrenzung.
  type CachedPreview = {
    matched: Array<{ name: string; location: string }>;
    unmatched: Array<{
      name: string;
      location: string;
      candidates: Array<{
        companyId: string;
        name: string;
        location: string;
        score: number;
      }>;
    }>;
    at: number;
  };
  const dryRunPreviewCache = new Map<string, CachedPreview>();
  const pruneDryRunCache = () => {
    const cutoff = Date.now() - 30 * 60 * 1000;
    for (const [k, v] of dryRunPreviewCache) {
      if (v.at < cutoff) dryRunPreviewCache.delete(k);
    }
    // Hard cap, falls jemand sehr viele Dry-Runs fährt.
    if (dryRunPreviewCache.size > 50) {
      const oldest = [...dryRunPreviewCache.entries()].sort(
        (a, b) => a[1].at - b[1].at,
      )[0];
      if (oldest) dryRunPreviewCache.delete(oldest[0]);
    }
  };

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
        dryRun: {
          type: "boolean",
          description:
            "Preview match results WITHOUT creating a transaction. Returns `{dryRun: true, matched, unmatched: [{candidates: [...]}]}` so you can walk the user through unmatched / low-confidence rows before committing. Default false.",
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
        dryRun: yup.boolean().optional(),
      })
      .noUnknown(true),
    preview: (r: {
      transactionId?: string;
      rows: number;
      filename: string;
      preview?: ImportPreview;
    }) =>
      r.preview
        ? `${summarizePreview(r.preview)} (file: "${r.filename}")`
        : `import "${r.filename}" (${r.rows} rows) → tx ${(r.transactionId ?? "").slice(0, 8)}…`,
    run: async (args, ctx) => {
      const att = deps.attachments.get(args.attachmentId);
      if (!att) {
        throw new Error(
          `attachment "${args.attachmentId}" is not staged. Ask the user to re-attach the file. Staged uploads expire after 30 minutes.`,
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
      if (args.dryRun) query.dryRun = true;

      // v0.1.179 — Pre-import research-cost gate (chat side).
      // Mirrors the Ingest UI's confirmation modal but via the
      // existing `askChoice` pattern. Skipped on dryRun (the model
      // is still negotiating the column mapping; no AMQP fan-out
      // happens for previews).
      let useSkipMode = false;
      if (!args.dryRun) {
        // Lazy import keeps the symbol off the cold-load path for
        // sessions that never trigger an import.
        const { ResearchFeaturesStore } = await import("../../research/store");
        const { estimateImportCost, FEATURE_LABEL, formatEuroRange } =
          await import("../../../shared/research-cost");
        const store = ResearchFeaturesStore.shared();
        const estimate = estimateImportCost(store.getConfig(), totalRows);
        if (estimate) {
          const lines: string[] = [
            `Du startest einen Import von ${totalRows.toLocaleString("de-DE")} Firmen.`,
            "",
            "Folgende kostenpflichtige Anreicherungen sind aktiv:",
            ...estimate.perFeature.map(
              (p) =>
                `  • ${FEATURE_LABEL[p.feature]} (${p.provider === "openai" ? "OpenAI" : "Anthropic"} ${p.tier === "deep" ? "Deep Research" : "Standard"}): ${formatEuroRange(p.perFirma, { perFirma: true })} je Firma → ${formatEuroRange(p.total)} total`,
            ),
            "",
            `Gesamtschätzung: ${formatEuroRange(estimate.total)}. Diese Kosten werden direkt deinen API-Konten belastet.`,
          ];
          const choice = await ctx.ui.askChoice(
            lines.join("\n"),
            [
              { value: "with", label: "Mit Anreicherung importieren" },
              { value: "without", label: "Ohne Anreicherung (diesmal)" },
              { value: "cancel", label: "Abbrechen" },
            ],
            ctx.signal,
          );
          if (choice === "cancel") {
            return {
              filename: att.filename,
              rows: totalRows,
              cancelled: true,
            } as never;
          }
          useSkipMode = choice === "without";
        }
      }

      // v0.1.179 — Begin skip-mode BEFORE the POST so the website
      // producer cycles to tier=off with the new env vars in place
      // by the time the website stage runs for the first company.
      // The snapshot is attached to the transactionId returned by
      // the POST, which the user can later release by viewing the
      // transaction stream (auto-restore via TransactionStream.tsx)
      // or by manually flipping in Settings.
      let skipSnapshotKey: string | null = null;
      if (useSkipMode) {
        const { ResearchFeaturesStore } = await import("../../research/store");
        const store = ResearchFeaturesStore.shared();
        skipSnapshotKey = store.beginSkipMode();
        ctx.log(
          `import_excel: skip-mode active (snapshot=${skipSnapshotKey}). Awaiting website producer reboot…`,
        );
        // Mirror the IPC's wait-loop, but inline since we have direct
        // access to the producers array? No — we're in a tool, no
        // direct ProducerSupervisor reference. Use the same 250ms
        // poll the IPC uses, capped at 30s.
        const deadline = Date.now() + 30_000;
        let ready = false;
        while (Date.now() < deadline) {
          // The tool has no direct supervisor handle; we approximate
          // ready-state by waiting a fixed conservative window. The
          // supervisor's debounced restart fires ~500ms after the
          // config change and a fresh website spawn typically takes
          // 8-12s. 15s is a comfortable overshoot.
          await new Promise((r) => setTimeout(r, 250));
          if (Date.now() - (deadline - 30_000) > 15_000) {
            ready = true;
            break;
          }
        }
        if (!ready) {
          ctx.log("import_excel: producer reboot timeout, aborting skip-mode");
          // Restore so user isn't stuck at off
          if (skipSnapshotKey) {
            store.attachSkipSnapshotToTransaction(
              skipSnapshotKey,
              `abort-${skipSnapshotKey}`,
            );
            store.endSkipModeForTransaction(`abort-${skipSnapshotKey}`);
          }
          throw new Error(
            "Konnte den Website-Producer nicht rechtzeitig neu starten. Anreicherung wurde nicht deaktiviert; bitte erneut versuchen oder Anreicherung in Settings manuell deaktivieren.",
          );
        }
        ctx.log("import_excel: producer ready, proceeding with import");
      }

      ctx.log(
        `import_excel: ${att.filename} (${totalRows} rows)${args.dryRun ? " [dryRun]" : ""}${useSkipMode ? " [SKIP-MODE]" : ""} → POST /v1/imports/excel`,
      );

      const response = await deps.gateway.request<
        { transactionId: string } | ImportPreview
      >("/v1/imports/excel", {
        method: "POST",
        query,
        multipart: form,
        idempotencyKey: randomUUID(),
        signal: ctx.signal,
        // Option D — dispatch endpoint, attach user-LLM headers so
        // master-data forwards them as AMQP headers to the producers.
        attachUserLlm: true,
      });

      // v0.1.179 — Attach the skip-mode snapshot to the transaction
      // ID so auto-restore can find it when the user later watches
      // the stream (or via the 30-min idle timer in TransactionStream).
      if (skipSnapshotKey && !args.dryRun) {
        const realTx = (response as { transactionId: string }).transactionId;
        const { ResearchFeaturesStore } = await import("../../research/store");
        ResearchFeaturesStore.shared().attachSkipSnapshotToTransaction(
          skipSnapshotKey,
          realTx,
        );
      }

      if (args.dryRun) {
        // Don't discard the attachment — the agent will likely call us
        // again without dryRun once the user has confirmed.
        return {
          filename: att.filename,
          rows: totalRows,
          preview: response as ImportPreview,
          companyNameColumns: args.companyNameColumns,
          cityColumns: args.cityColumns ?? [],
        };
      }

      // The bytes have done their job — free them so an idle session
      // doesn't hold onto a large workbook.
      deps.attachments.discard(args.attachmentId);

      return {
        transactionId: (response as { transactionId: string }).transactionId,
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
      return `${r.done}/${r.total} done (${pct}%), ${r.counts.failed} failed`;
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

  // ---- import_companies_from_crm (v0.1.57 — CRM Phase 2) ------------------
  //
  // Pulls companies from a connected CRM (today: HubSpot; Salesforce +
  // Dynamics return a clear "not yet implemented" so the agent can suggest
  // HubSpot as the working alternative) and starts ONE master-data
  // transaction with all rows. Same downstream pipeline as a file upload —
  // the matrix view shows N companies, SSE progresses live.
  //
  // Why not have the agent split into per-row calls: that creates N
  // transactions (one per row), scattering the matrix and breaking the model
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
        dryRun: {
          type: "boolean",
          description:
            "Preview matches WITHOUT starting a transaction. Returns `{dryRun: true, matched, unmatched: [{candidates: [...]}]}` so you can confirm with the user (especially when the CRM has a lot of unmatched / low-confidence rows). Default false.",
        },
        companies: {
          type: "array",
          description:
            "Optional override for the {name, city} list. When set, SKIPS the CRM API fetch and uses this list directly — the typical use is to re-issue the call after a dryRun with corrections collected from the user. Items must be `{name, city}` pairs. Don't guess; only set this when you're committing user-confirmed values.",
          items: {
            type: "object",
            required: ["name", "city"],
            properties: {
              name: { type: "string" },
              city: { type: "string" },
            },
          },
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
        maxCompanies: yup.number().integer().min(1).max(5000).optional(),
        dryRun: yup.boolean().optional(),
        companies: yup
          .array()
          .of(
            yup
              .object({
                name: yup.string().required().min(1),
                city: yup.string().required().min(1),
              })
              .noUnknown(true),
          )
          .optional(),
      })
      .noUnknown(true),
    preview: (r: {
      transactionId?: string;
      provider: string;
      companyCount?: number;
      skipped: number;
      preview?: ImportPreview;
    }) =>
      r.preview
        ? `${summarizePreview(r.preview)} (CRM: ${r.provider})`
        : `import ${r.companyCount ?? 0} companies from ${r.provider}` +
          (r.skipped > 0 ? ` (${r.skipped} skipped)` : "") +
          ` → tx ${(r.transactionId ?? "").slice(0, 8)}…`,
    run: async (args, ctx) => {
      const provider = args.provider as CrmProvider;

      // Either the agent supplied an explicit companies list (e.g.
      // post-dryRun confirmation), or we page the CRM ourselves.
      let companies: CompanyForImport[];
      let skipped = 0;
      let total = 0;
      if (args.companies && args.companies.length > 0) {
        ctx.log(
          `import_companies_from_crm: provider=${provider} explicit=${args.companies.length}${args.dryRun ? " [dryRun]" : ""}`,
        );
        companies = args.companies as CompanyForImport[];
        total = companies.length;
      } else {
        ctx.log(
          `import_companies_from_crm: provider=${provider} fetch${args.dryRun ? " [dryRun]" : ""}`,
        );
        const fetched = await fetchCompaniesFromCrm(deps.crm, provider, {
          maxCompanies: args.maxCompanies,
        });
        if (fetched.companies.length === 0) {
          throw new Error(
            `Aus ${provider} konnten keine importierbaren Firmen gelesen werden ` +
              `(insgesamt ${fetched.total} Firmen, davon ${fetched.skipped} ` +
              `ohne Name oder Stadt). Bitte in HubSpot City-Felder pflegen oder ` +
              `eine Datei hochladen.`,
          );
        }
        companies = fetched.companies;
        skipped = fetched.skipped;
        total = fetched.total;
        ctx.log(
          `import_companies_from_crm: ${companies.length}/${total} usable, ${skipped} skipped`,
        );
      }

      // Workstream C — when the source provider has the CRM-side ids
      // attached to each row (HubSpot today via `crmExternalId`),
      // forward them as `crm: {type, externalId, displayName}` so the
      // gateway can persist a CompanyCrmLink for each matched company.
      const wireCompanies = companies.map((co) => {
        if (!co.crmExternalId) return { name: co.name, city: co.city };
        return {
          name: co.name,
          city: co.city,
          crm: {
            type: provider,
            externalId: co.crmExternalId,
            ...(co.crmDisplayName
              ? { displayName: co.crmDisplayName }
              : {}),
          },
        };
      });

      // v0.1.179 — Same research-cost gate as import_excel, just over
      // the CRM-fetched list instead of the xlsx parse. Skipped on
      // dryRun. See import_excel above for the rationale.
      let useSkipMode = false;
      let skipSnapshotKey: string | null = null;
      if (!args.dryRun) {
        const { ResearchFeaturesStore } = await import("../../research/store");
        const { estimateImportCost, FEATURE_LABEL, formatEuroRange } =
          await import("../../../shared/research-cost");
        const store = ResearchFeaturesStore.shared();
        const estimate = estimateImportCost(store.getConfig(), companies.length);
        if (estimate) {
          const lines: string[] = [
            `Du importierst ${companies.length.toLocaleString("de-DE")} Firmen aus ${provider}.`,
            "",
            "Folgende kostenpflichtige Anreicherungen sind aktiv:",
            ...estimate.perFeature.map(
              (p) =>
                `  • ${FEATURE_LABEL[p.feature]} (${p.provider === "openai" ? "OpenAI" : "Anthropic"} ${p.tier === "deep" ? "Deep Research" : "Standard"}): ${formatEuroRange(p.perFirma, { perFirma: true })} je Firma → ${formatEuroRange(p.total)} total`,
            ),
            "",
            `Gesamtschätzung: ${formatEuroRange(estimate.total)}.`,
          ];
          const choice = await ctx.ui.askChoice(
            lines.join("\n"),
            [
              { value: "with", label: "Mit Anreicherung importieren" },
              { value: "without", label: "Ohne Anreicherung (diesmal)" },
              { value: "cancel", label: "Abbrechen" },
            ],
            ctx.signal,
          );
          if (choice === "cancel") {
            return {
              provider,
              cancelled: true,
              skipped,
              total,
            } as never;
          }
          useSkipMode = choice === "without";
        }

        if (useSkipMode) {
          skipSnapshotKey = store.beginSkipMode();
          ctx.log(
            `import_from_crm: skip-mode active (snapshot=${skipSnapshotKey}). Awaiting website producer reboot (~15s)…`,
          );
          // Fixed conservative wait — see import_excel above for the
          // rationale (no direct ProducerSupervisor handle in this scope).
          await new Promise((r) => setTimeout(r, 15_000));
          ctx.log("import_from_crm: producer reboot window elapsed");
        }
      }

      const response = await deps.gateway.request<
        { transactionId: string; companyCount: number } | ImportPreview
      >("/v1/imports/from-list", {
        method: "POST",
        body: {
          companies: wireCompanies,
          ...(args.transactionName
            ? { transactionName: args.transactionName }
            : {}),
          ...(args.isFuzzy !== undefined ? { isFuzzy: args.isFuzzy } : {}),
          ...(args.dryRun ? { dryRun: true } : {}),
        },
        idempotencyKey: randomUUID(),
        signal: ctx.signal,
        attachUserLlm: true,
      });

      // v0.1.179 — Attach skip-mode snapshot to the new transaction
      // so auto-restore can find it.
      if (skipSnapshotKey && !args.dryRun) {
        const realTx = (response as { transactionId: string }).transactionId;
        const { ResearchFeaturesStore } = await import("../../research/store");
        ResearchFeaturesStore.shared().attachSkipSnapshotToTransaction(
          skipSnapshotKey,
          realTx,
        );
      }

      if (args.dryRun) {
        return {
          provider,
          skipped,
          total,
          preview: response as ImportPreview,
        };
      }

      const committed = response as {
        transactionId: string;
        companyCount: number;
      };
      return {
        transactionId: committed.transactionId,
        provider,
        companyCount: committed.companyCount,
        skipped,
        total,
      };
    },
  });

  // ---- import_companies (v0.1.390 — Inline-Bulk-Liste) -------------------
  //
  // Das Universal-Import-Tool für in den Chat genannte/eingefügte Firmen
  // (KEINE Datei, KEIN verbundenes CRM): EINE Firma oder eine ganze LISTE
  // (z. B. aus LinkedIn kopiert) — immer in EINER Transaktion. Postet die
  // Inline-Liste an denselben Bulk-Endpunkt wie der CRM-Import
  // (`/v1/imports/from-list`) → eine Transaktion mit voller Pipeline-
  // Anreicherung. Ersetzt das frühere Einzel-Tool `import_company` (v0.1.391).
  //
  // Ablauf (vom System-Prompt vorgegeben): ERST `dryRun: true` → Matching-
  // Vorschau + Excel-Report (Downloads); dem Nutzer matched/unmatched zeigen;
  // nach Bestätigung `dryRun: false` → Commit.

  const importCompanies = defineTool({
    name: "import_companies",
    description:
      "Ingest ONE OR MORE companies (by name + city) as a SINGLE transaction, " +
      "kicking off the full master-data pipeline (profile, website, " +
      "publications, contacts, evaluations). This is THE import tool when the " +
      "user names or pastes companies in chat (no file attachment): a single " +
      "company (\"leg mir Foo GmbH aus Berlin an\") is just a one-item list, a " +
      "pasted list (e.g. from LinkedIn) is the many-item case. Pass ALL " +
      "companies in this ONE call — never split into multiple calls, that " +
      "scatters the Transactions view into one transaction per company. " +
      "WORKFLOW for lists: call FIRST with `dryRun: true` — you get a matching " +
      "preview AND a downloadable Excel report (path in `reportPath`); show the " +
      "user matched / not-uniquely-matched + the report link, let them confirm " +
      "or correct, THEN call again with `dryRun: false` to commit. For a single, " +
      "clearly-specified company you may commit directly. Each row needs " +
      "name + city (city disambiguates same-named companies); if the user gave " +
      "no city, use the best-known HQ — the dry-run report flags wrong guesses. " +
      "Returns a transactionId on commit; progress via `import_status`.",
    parameters: {
      type: "object",
      required: ["companies"],
      properties: {
        companies: {
          type: "array",
          minItems: 1,
          description:
            "The companies to import. Each item is `{name, city}` (plus optional `crm` to bind to a CRM record). Pass ALL of them in this ONE call — a single company is a one-item list.",
          items: {
            type: "object",
            required: ["name", "city"],
            properties: {
              name: { type: "string", minLength: 1 },
              city: { type: "string", minLength: 1 },
              crm: {
                type: "object",
                description:
                  "Optional CRM-side identifier for this row. On commit (dryRun=false) the gateway binds the resulting master-data companyId to this external id (e.g. 'add HubSpot company 12345').",
                required: ["type", "externalId"],
                properties: {
                  type: {
                    type: "string",
                    enum: ["hubspot", "salesforce", "dynamics"],
                  },
                  externalId: { type: "string" },
                  displayName: { type: "string" },
                },
              },
            },
          },
        },
        transactionName: {
          type: "string",
          description:
            "Optional human-readable label for the run (shows in the Transactions view). Defaults to a generic 'Liste: N Firmen'.",
        },
        isFuzzy: {
          type: "boolean",
          description:
            "Allow fuzzy matching against existing companies. Default false (strict).",
        },
        dryRun: {
          type: "boolean",
          description:
            "Preview matches + generate the Excel report WITHOUT creating a transaction. Returns `{dryRun:true, preview, reportPath, reportFilename}`. ALWAYS do this first.",
        },
      },
    },
    schema: yup
      .object({
        companies: yup
          .array()
          .of(
            yup
              .object({
                name: yup.string().required().min(1),
                city: yup.string().required().min(1),
                crm: yup
                  .object({
                    type: yup
                      .string()
                      .required()
                      .oneOf(["hubspot", "salesforce", "dynamics"]),
                    externalId: yup.string().required().min(1),
                    displayName: yup.string().optional(),
                  })
                  .noUnknown(true)
                  .optional()
                  .default(undefined),
              })
              .noUnknown(true),
          )
          .required()
          .min(1),
        transactionName: yup.string().optional(),
        isFuzzy: yup.boolean().optional(),
        dryRun: yup.boolean().optional(),
      })
      .noUnknown(true),
    preview: (r: {
      transactionId?: string;
      companyCount?: number;
      reportFilename?: string;
      matchedCount?: number;
      unmatchedCount?: number;
    }) =>
      r.reportFilename !== undefined
        ? `dry-run: ${r.matchedCount ?? 0} gefunden, ${r.unmatchedCount ?? 0} nicht eindeutig → Report "${r.reportFilename}"`
        : `import ${r.companyCount ?? 0} Firmen → tx ${(r.transactionId ?? "").slice(0, 8)}…`,
    run: async (args, ctx) => {
      const companies = args.companies as Array<{
        name: string;
        city: string;
        crm?: { type: string; externalId: string; displayName?: string };
      }>;
      const toWire = (c: (typeof companies)[number]) => ({
        name: c.name,
        city: c.city,
        ...(c.crm ? { crm: c.crm } : {}),
      });
      const label =
        args.transactionName ?? `Liste: ${companies.length} Firmen`;

      // ---- Dry-Run: Vorschau + Excel-Report, KEINE Transaktion. ----------
      if (args.dryRun) {
        ctx.log(
          `import_companies: dry-run für ${companies.length} Firmen → /v1/imports/from-list`,
        );
        const preview = await deps.gateway.request<ImportPreview>(
          "/v1/imports/from-list",
          {
            method: "POST",
            body: {
              companies: companies.map(toWire),
              transactionName: label,
              ...(args.isFuzzy !== undefined ? { isFuzzy: args.isFuzzy } : {}),
              dryRun: true,
            },
            idempotencyKey: randomUUID(),
            signal: ctx.signal,
          },
        );
        let reportPath: string | undefined;
        let reportFilename: string | undefined;
        try {
          const report = await writeImportReport(
            preview as unknown as Parameters<typeof writeImportReport>[0],
            { now: Date.now(), label: args.transactionName },
          );
          reportPath = report.path;
          reportFilename = report.filename;
          ctx.log(`import_companies: Report geschrieben → ${report.path}`);
        } catch (err) {
          // Report ist Komfort, kein Muss — bei Schreibfehler trotzdem die
          // Vorschau zurückgeben.
          ctx.log(
            `import_companies: Report-Schreiben fehlgeschlagen (${err instanceof Error ? err.message : String(err)})`,
          );
        }
        // v0.1.393 — Vorschau cachen + nur ein kurzes Token zurückgeben.
        // Das volle `preview` NICHT ins Tool-Result spiegeln (das Modell muss
        // es weder lesen noch — für resolve_import_matches — neu ausschreiben;
        // es übergibt nur `resolveToken`). Spart die lange Tool-Argument-
        // Generierung, die die Zuordnungs-Karte verzögert hat.
        const resolveToken = randomUUID();
        dryRunPreviewCache.set(resolveToken, {
          matched: preview.matched.map((m) => ({
            name: m.name,
            location: m.location,
          })),
          unmatched: preview.unmatched.map((u) => ({
            name: u.name,
            location: u.location,
            candidates: (u.candidates ?? []).map((c) => ({
              companyId: c.companyId,
              name: c.name,
              location: c.location,
              score: c.score,
            })),
          })),
          at: Date.now(),
        });
        pruneDryRunCache();
        return {
          dryRun: true as const,
          providedCount: preview.providedCount,
          matchedCount: preview.matched.length,
          unmatchedCount: preview.unmatched.length,
          // Token für resolve_import_matches — KEINE Daten kopieren.
          resolveToken,
          ...(reportPath ? { reportPath } : {}),
          ...(reportFilename ? { reportFilename } : {}),
        };
      }

      // ---- Commit: Kosten-Gate + EINE Transaktion. -----------------------
      // v0.1.179-Logik (analog import_companies_from_crm): vor dem AMQP-
      // Fan-out die geschätzten Anreicherungskosten zeigen.
      let useSkipMode = false;
      let skipSnapshotKey: string | null = null;
      {
        const { ResearchFeaturesStore } = await import("../../research/store");
        const { estimateImportCost, FEATURE_LABEL, formatEuroRange } =
          await import("../../../shared/research-cost");
        const store = ResearchFeaturesStore.shared();
        const estimate = estimateImportCost(store.getConfig(), companies.length);
        if (estimate) {
          const lines: string[] = [
            `Du importierst ${companies.length.toLocaleString("de-DE")} Firmen aus einer Liste.`,
            "",
            "Folgende kostenpflichtige Anreicherungen sind aktiv:",
            ...estimate.perFeature.map(
              (p) =>
                `  • ${FEATURE_LABEL[p.feature]} (${p.provider === "openai" ? "OpenAI" : "Anthropic"} ${p.tier === "deep" ? "Deep Research" : "Standard"}): ${formatEuroRange(p.perFirma, { perFirma: true })} je Firma → ${formatEuroRange(p.total)} total`,
            ),
            "",
            `Gesamtschätzung: ${formatEuroRange(estimate.total)}. Diese Kosten werden direkt deinen API-Konten belastet.`,
          ];
          const choice = await ctx.ui.askChoice(
            lines.join("\n"),
            [
              { value: "with", label: "Mit Anreicherung importieren" },
              { value: "without", label: "Ohne Anreicherung (diesmal)" },
              { value: "cancel", label: "Abbrechen" },
            ],
            ctx.signal,
          );
          if (choice === "cancel") {
            return { cancelled: true, companyCount: companies.length } as never;
          }
          useSkipMode = choice === "without";
          if (useSkipMode) {
            skipSnapshotKey = store.beginSkipMode();
            ctx.log(
              `import_companies: skip-mode active (snapshot=${skipSnapshotKey}). Awaiting website producer reboot (~15s)…`,
            );
            await new Promise((r) => setTimeout(r, 15_000));
            ctx.log("import_companies: producer reboot window elapsed");
          }
        }
      }

      ctx.log(
        `import_companies: commit ${companies.length} Firmen → /v1/imports/from-list`,
      );
      const response = await deps.gateway.request<{
        transactionId: string;
        companyCount: number;
      }>("/v1/imports/from-list", {
        method: "POST",
        body: {
          companies: companies.map((c) => ({ name: c.name, city: c.city })),
          transactionName: label,
          ...(args.isFuzzy !== undefined ? { isFuzzy: args.isFuzzy } : {}),
        },
        idempotencyKey: randomUUID(),
        signal: ctx.signal,
        attachUserLlm: true,
      });

      if (skipSnapshotKey) {
        const { ResearchFeaturesStore } = await import("../../research/store");
        ResearchFeaturesStore.shared().attachSkipSnapshotToTransaction(
          skipSnapshotKey,
          response.transactionId,
        );
      }

      return {
        transactionId: response.transactionId,
        companyCount: response.companyCount,
      };
    },
  });

  // ---- resolve_import_matches (v0.1.392 — Batch-Zuordnung) ---------------
  //
  // Nach einem `import_companies`-Dry-Run liefert das Gateway `matched`
  // (eindeutig) + `unmatched` (mehrdeutig, mit Kandidaten). Dieses Tool zeigt
  // ALLE Zweifelsfälle in EINER scrollbaren Karte (ui.askMatch) statt N
  // einzelner Dialoge. Eindeutige Einzel-Kandidaten (oder klar dominanter
  // Top-Treffer) werden automatisch zugeordnet und NICHT angezeigt. Ergebnis:
  // eine fertige `commitCompanies`-Liste, die direkt an `import_companies`
  // (dryRun=false) geht.

  const resolveImportMatches = defineTool({
    name: "resolve_import_matches",
    description:
      "After an `import_companies` dry-run returned a `resolveToken` (and a " +
      "non-zero unmatched count), call this to let the user resolve the " +
      "ambiguous companies in ONE scrollable card. STRONGLY PREFERRED: pass " +
      "just the `resolveToken` from the dry-run result — the matched/unmatched " +
      "data is fetched server-side, so you do NOT re-emit the whole company " +
      "list (which is slow). Only fall back to passing `matched`/`unmatched` " +
      "arrays inline if no token is available. Companies with a single clear " +
      "candidate are auto-assigned (not shown); only genuine doubt cases are " +
      "presented, each with candidates + a 'skip' option. Returns " +
      "`commitCompanies` — the final {name, city} list ready to pass to " +
      "`import_companies` with `dryRun: false`. Skipped companies are omitted.",
    parameters: {
      type: "object",
      properties: {
        resolveToken: {
          type: "string",
          description:
            "The `resolveToken` from the `import_companies` dry-run result. PREFERRED input — pass this alone, don't copy the company arrays.",
        },
        matched: {
          type: "array",
          description:
            "The dry-run's `matched` array (already resolved). Each item `{name, location}`.",
          items: {
            type: "object",
            required: ["name", "location"],
            properties: {
              name: { type: "string" },
              location: { type: "string" },
            },
          },
        },
        unmatched: {
          type: "array",
          description:
            "Fallback only (prefer `resolveToken`). The dry-run's `unmatched` array. Each item `{name, location, candidates: [{companyId, name, location, score}]}`.",
          items: {
            type: "object",
            required: ["name", "location", "candidates"],
            properties: {
              name: { type: "string" },
              location: { type: "string" },
              candidates: {
                type: "array",
                items: {
                  type: "object",
                  required: ["companyId", "name", "location", "score"],
                  properties: {
                    companyId: { type: "string" },
                    name: { type: "string" },
                    location: { type: "string" },
                    score: { type: "number" },
                  },
                },
              },
            },
          },
        },
        prompt: {
          type: "string",
          description:
            "Optional headline shown above the card. Defaults to a generic German prompt.",
        },
      },
    },
    schema: yup
      .object({
        resolveToken: yup.string().optional(),
        matched: yup
          .array()
          .of(
            yup
              .object({
                name: yup.string().required(),
                location: yup.string().defined(),
              })
              .noUnknown(true),
          )
          .optional()
          .default([]),
        unmatched: yup
          .array()
          .of(
            yup
              .object({
                name: yup.string().required(),
                location: yup.string().defined(),
                candidates: yup
                  .array()
                  .of(
                    yup
                      .object({
                        companyId: yup.string().required(),
                        name: yup.string().required(),
                        location: yup.string().defined(),
                        score: yup.number().defined(),
                      })
                      .noUnknown(true),
                  )
                  .required(),
              })
              .noUnknown(true),
          )
          .optional()
          .default([]),
        prompt: yup.string().optional(),
      })
      .noUnknown(true),
    preview: (r: {
      autoAssigned?: number;
      resolved?: number;
      skipped?: number;
    }) =>
      `Zuordnung: ${r.autoAssigned ?? 0} automatisch, ${r.resolved ?? 0} bestätigt, ${r.skipped ?? 0} übersprungen`,
    run: async (args, ctx) => {
      // v0.1.393 — Bevorzugt aus dem Dry-Run-Cache über `resolveToken` laden
      // (kein Re-Ausschreiben der Firmen durch das Modell). Fallback: die
      // inline übergebenen Arrays.
      let matched: Array<{ name: string; location: string }>;
      let unmatched: Array<{
        name: string;
        location: string;
        candidates: Array<{
          companyId: string;
          name: string;
          location: string;
          score: number;
        }>;
      }>;
      const token = args.resolveToken?.trim();
      const cached = token ? dryRunPreviewCache.get(token) : undefined;
      if (cached) {
        matched = cached.matched;
        unmatched = cached.unmatched;
      } else {
        matched = (args.matched ?? []) as typeof matched;
        unmatched = (args.unmatched ?? []) as typeof unmatched;
      }
      if (unmatched.length === 0) {
        // Nichts zu klären (oder Token abgelaufen ohne Fallback-Daten).
        return {
          commitCompanies: matched.map((m) => ({
            name: m.name,
            city: m.location,
          })),
          autoAssigned: 0,
          resolved: 0,
          skipped: 0,
          ...(token && !cached
            ? {
                note: "resolveToken abgelaufen/unbekannt und keine Inline-Daten — bitte import_companies-Dry-Run erneut ausführen.",
              }
            : {}),
        };
      }

      // Klar dominanter Top-Treffer (≥1.6× zweitbester) oder einziger
      // Kandidat → automatisch zuordnen, NICHT in der Karte zeigen.
      const DOMINANCE = 1.6;
      const autoResolved: Array<{ name: string; city: string }> = [];
      const doubt: Array<{
        name: string;
        location: string;
        candidates: Array<{
          companyId: string;
          name: string;
          location: string;
          score: number;
        }>;
      }> = [];
      for (const u of unmatched) {
        const cands = [...(u.candidates ?? [])].sort(
          (a, b) => (b.score ?? 0) - (a.score ?? 0),
        );
        if (cands.length === 0) {
          doubt.push({ name: u.name, location: u.location, candidates: [] });
          continue;
        }
        const top = cands[0]!;
        const second = cands[1];
        const dominant =
          !second || (top.score > 0 && top.score >= DOMINANCE * (second.score ?? 0));
        if (cands.length === 1 || dominant) {
          autoResolved.push({ name: top.name, city: top.location });
        } else {
          doubt.push({ name: u.name, location: u.location, candidates: cands });
        }
      }

      const rows: AgentMatchRow[] = doubt.map((d, i) => ({
        rowId: String(i),
        name: d.name,
        location: d.location,
        candidates: d.candidates.map((c) => ({
          companyId: c.companyId,
          name: c.name,
          location: c.location,
          score: c.score,
        })),
      }));

      const userResolved: Array<{ name: string; city: string }> = [];
      let skipped = 0;
      if (rows.length > 0) {
        const promptText =
          args.prompt ??
          `Bitte ${rows.length} nicht eindeutig erkannte ${rows.length === 1 ? "Firma" : "Firmen"} zuordnen oder überspringen.`;
        const map = await ctx.ui.askMatch(promptText, rows, ctx.signal);
        for (const r of rows) {
          const pick = map[r.rowId];
          if (!pick || pick === "skip") {
            skipped += 1;
            continue;
          }
          const cand = r.candidates.find((c) => c.companyId === pick);
          if (cand) userResolved.push({ name: cand.name, city: cand.location });
          else skipped += 1;
        }
      }

      const commitCompanies = [
        ...matched.map((m) => ({ name: m.name, city: m.location })),
        ...autoResolved,
        ...userResolved,
      ];

      return {
        commitCompanies,
        autoAssigned: autoResolved.length,
        resolved: userResolved.length,
        skipped,
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
            // v0.1.243 — Sub-Pipelines des Website-Producers.
            // `deepResearch` umfasst Ausschreibungen + Expansion +
            // Beschaffung, `jobPostings` deckt Stellenanzeigen ab.
            // Beide retriggern intern den vollen Website-Chain.
            "deepResearch",
            "jobPostings",
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
            "deepResearch",
            "jobPostings",
          ]),
        companyName: yup.string().optional(),
      })
      .noUnknown(true),
    preview: (r: {
      ok: boolean;
      stage: string;
      dispatched: {
        ok: boolean;
        error?: string;
        body?: unknown;
      }[];
    }) => {
      const total = r.dispatched.length;
      const okCount = r.dispatched.filter((d) => d.ok).length;
      // v0.1.170 — pattern-match the dispatch errors for the
      // OPENAI_API_KEY-missing case. Without this hint, the
      // user just sees "retry website → 0/1 dispatched" with no
      // clue why; with it, the activity row reads
      // "Deep Research / Google-Maps deaktiviert — OpenAI-Key fehlt".
      const errorBlobs = r.dispatched
        .map((d) =>
          typeof d.error === "string"
            ? d.error
            : typeof d.body === "string"
              ? d.body
              : d.body
                ? JSON.stringify(d.body)
                : "",
        )
        .join(" | ");
      if (/OPENAI_API_KEY ist nicht konfiguriert/i.test(errorBlobs)) {
        return `retry ${r.stage} → OpenAI-Key fehlt (Deep Research / Google-Maps-Entity-Resolution deaktiviert)`;
      }
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

  return [
    importExcel,
    importStatus,
    importCompanies,
    resolveImportMatches,
    importFromCrm,
    retryStage,
  ];
}

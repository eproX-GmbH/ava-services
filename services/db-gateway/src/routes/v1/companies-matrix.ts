// v0.1.61 — global per-tenant company-matrix view.
//
// Backs the desktop's "Alle Firmen" / Globaler Status route. Reads
// every distinct companyId the tenant has touched (across every
// transaction of every user in the tenant), enriches each with the
// LATEST per-stage state from EntityProgress, and returns a paginated
// matrix.
//
// Why a dedicated endpoint instead of reusing /v1/transactions/:id/
// entities: that endpoint is per-transaction. A user with 30+ batches
// would have to flip through 30+ matrices to find "is Foo GmbH's
// profile done somewhere?". This collapses everything to the company
// level so a single view answers that question for every company.
//
// Aggregation logic, per (companyId, producer):
//   - latest by updatedAt wins (DISTINCT ON / ORDER BY DESC)
//   - state matches EntityProgress: completed | failed | skipped |
//     in_progress | pending. If no row exists for a stage, we default
//     to "pending" since the company has been dispatched (otherwise
//     it wouldn't be in master-data) but the producer hasn't touched
//     it yet OR the producer was disabled in the original transaction.
//
// Pagination is forwarded from master-data verbatim — the master-data
// query already handles tenant scoping + search, we don't re-paginate
// at the gateway.

import { OpenAPIHono, createRoute, z } from "@hono/zod-openapi";
import { HTTPException } from "hono/http-exception";
import { callUpstream } from "../../lib/upstream";
import { getGatewayPool } from "../../lib/producer-pools";
import { PRODUCER_NAMES } from "../../lib/db-urls";
import { ErrorShape } from "./schemas";

export const companiesMatrixRouter = new OpenAPIHono();

const StageStateShape = z
  .object({
    state: z.enum([
      "pending",
      "in_progress",
      "completed",
      "failed",
      "skipped",
    ]),
    updatedAt: z.string().nullable(),
    errorMessage: z.string().nullable(),
  })
  .openapi("CompanyMatrixStageState");

const CompanyMatrixRowShape = z
  .object({
    companyId: z.string(),
    name: z.string(),
    location: z.string(),
    /** ISO; the most-recent transaction.startTime that included this
     *  company. Surfaced so the desktop can show "last seen 2 days
     *  ago" next to the row. */
    lastSeenAt: z.string(),
    /** Per-producer latest state. Keys match PRODUCER_NAMES. */
    stages: z.record(z.string(), StageStateShape),
  })
  .openapi("CompanyMatrixRow");

const CompaniesMatrixResponseShape = z
  .object({
    pageNumber: z.number().int().min(1),
    pageSize: z.number().int().min(1),
    count: z.number().int().nonnegative(),
    companies: z.array(CompanyMatrixRowShape),
  })
  .openapi("CompaniesMatrixResponse");

const CompaniesMatrixQuery = z.object({
  pageNumber: z.coerce.number().int().min(1).default(1),
  pageSize: z.coerce.number().int().min(1).max(200).default(50),
  search: z.string().min(1).max(200).optional(),
});

interface UpstreamCompany {
  companyId: string;
  name: string;
  location: string;
  lastSeenAt: string;
}
interface UpstreamPage {
  pageNumber: number;
  pageSize: number;
  count: number;
  companies: UpstreamCompany[];
}

const matrixRoute = createRoute({
  method: "get",
  path: "/companies/matrix",
  tags: ["companies"],
  summary:
    "Global per-tenant company-matrix view (every company × per-producer latest state)",
  request: { query: CompaniesMatrixQuery },
  responses: {
    200: {
      content: { "application/json": { schema: CompaniesMatrixResponseShape } },
      description: "paginated list with per-stage state per company",
    },
    401: {
      content: { "application/json": { schema: ErrorShape } },
      description: "unauthenticated",
    },
  },
});

companiesMatrixRouter.openapi(matrixRoute, async (c) => {
  const auth = c.get("auth");
  if (!auth?.tenantId) {
    throw new HTTPException(401, { message: "auth_context_missing" });
  }
  const { pageNumber, pageSize, search } = c.req.valid("query");

  // ---- 1. master-data: page of {companyId, name, location, lastSeenAt} ----
  const upstream = await callUpstream<UpstreamPage>(c, "masterData", "/api/v1/tenants/me/companies", {
    query: {
      pageNumber,
      pageSize,
      ...(search ? { search } : {}),
    },
  });
  const companyIds = upstream.companies.map((c) => c.companyId);

  // ---- 2. gateway: latest per-stage state for those companies ----
  //
  // v0.1.279 — Terminal-State-Preference. Vorher: ORDER BY updatedAt DESC.
  // Problem: ein stuck "in_progress"-Eintrag (z. B. abgebrochener Producer-
  // Run, Race in der persist-bus) ließ die Stage-Pille permanent gelb,
  // obwohl historisch schon ein "completed" da war. Dieselbe Firma sah
  // in der Transactions-Detail-Ansicht (die per-Transaction state-aware
  // rechnet) komplett grün aus — Mismatch zwischen den beiden Views.
  //
  // Neue Reihenfolge: terminale States (completed/failed/skipped) gewinnen
  // gegen non-terminale (in_progress/pending), sekundär updatedAt DESC.
  // Heißt: wenn eine Firma jemals einen Producer komplett durchlaufen
  // hat, sieht man das in der Matrix, auch wenn ein späterer Re-Run
  // mittendrin abgewürgt wurde. "Aktuelle Re-Run-Progress"-Info gehört
  // zur Transactions-Ansicht, nicht zum Globale-Firmen-Überblick.
  let stageRows: Array<{
    companyId: string;
    producer: string;
    state: string;
    errorMessage: string | null;
    updatedAt: Date;
  }> = [];
  if (companyIds.length > 0) {
    const pool = getGatewayPool();
    const res = await pool.query(
      `SELECT DISTINCT ON ("companyId", producer)
         "companyId", producer, state, "errorMessage", "updatedAt"
       FROM "EntityProgress"
       WHERE "companyId" = ANY($1::text[])
       ORDER BY "companyId", producer,
         CASE state
           WHEN 'completed'   THEN 0
           WHEN 'failed'      THEN 1
           WHEN 'skipped'     THEN 2
           WHEN 'in_progress' THEN 3
           WHEN 'pending'     THEN 4
           ELSE 5
         END,
         "updatedAt" DESC`,
      [companyIds],
    );
    stageRows = res.rows as typeof stageRows;
  }

  // ---- 3. assemble the matrix shape ----
  // Group stageRows by companyId for O(1) lookup during the page walk.
  const byCompany = new Map<
    string,
    Map<
      string,
      { state: string; updatedAt: Date; errorMessage: string | null }
    >
  >();
  for (const r of stageRows) {
    let m = byCompany.get(r.companyId);
    if (!m) {
      m = new Map();
      byCompany.set(r.companyId, m);
    }
    m.set(r.producer, {
      state: r.state,
      updatedAt: r.updatedAt,
      errorMessage: r.errorMessage,
    });
  }

  const companies = upstream.companies.map((co) => {
    type StageCell = {
      state: "pending" | "in_progress" | "completed" | "failed" | "skipped";
      updatedAt: string | null;
      errorMessage: string | null;
    };
    const stages: Record<string, StageCell> = {};
    const found = byCompany.get(co.companyId) ?? new Map();
    for (const producer of PRODUCER_NAMES) {
      const row = found.get(producer);
      if (row) {
        stages[producer] = {
          // Defensive: clamp to the enum we advertise to the client.
          state: normalizeState(row.state),
          updatedAt: row.updatedAt.toISOString(),
          errorMessage: row.errorMessage,
        };
      } else {
        // No EntityProgress row for this (company, producer) — the
        // producer was either never dispatched (services array
        // excluded it) or pre-§8.v3 (no EntityProgress seeding). We
        // surface "pending" rather than guessing; the desktop renders
        // it the same as a fresh import row.
        stages[producer] = {
          state: "pending",
          updatedAt: null,
          errorMessage: null,
        };
      }
    }

    // v0.1.363 — company-profile / company-contact hängen vom
    // website-URL-Treffer ab (Producer dispatcht ihre Trigger nur bei
    // gefundener URL). Fand der LLM-Judge keine Webseite, läuft website
    // auf `failed` und es entsteht nie eine EntityProgress-Zeile für
    // Profil/Kontakt → die Zelle bliebe ewig `pending` (gelb). In genau
    // diesem Fall als `skipped` ableiten, damit die Matrix terminal wird.
    // (Spiegelt deriveDependentOnWebsite in transactions.ts.)
    {
      const websiteCell = stages["website"];
      const websiteTerminalNoResult =
        websiteCell?.state === "failed" || websiteCell?.state === "skipped";
      for (const dep of ["company-profile", "company-contact"] as const) {
        const cell = stages[dep];
        if (cell && cell.state === "pending" && websiteTerminalNoResult) {
          stages[dep] = {
            state: "skipped",
            updatedAt: websiteCell?.updatedAt ?? null,
            errorMessage: null,
          };
        }
      }
    }

    // v0.1.279 — companyEvaluation aus Upstreams DERIVEN, statt den
    // rohen EntityProgress-Status zu nehmen. Sonst sahen Firmen, deren
    // 5 Upstream-Producer alle completed sind, in der Matrix gelb aus
    // (evaluation-Producer wurde noch nicht oder unsauber gefahren),
    // während die Transactions-Detail-Ansicht denselben Datenstand als
    // grün rendert (dort gibt es schon die identische Ableitung —
    // siehe deriveEvaluationCell in transactions.ts). Wir spiegeln die
    // Logik 1:1: alle Upstreams terminal + mind. eines completed →
    // companyEvaluation completed.
    if (stages["companyEvaluation"]) {
      const upstreamNames = [
        "structuredContent",
        "companyPublication",
        "website",
        "companyProfile",
        "companyContact",
      ] as const;
      const upstreams = upstreamNames
        .map((n) => stages[n])
        .filter((c): c is StageCell => Boolean(c));
      const allTerminal =
        upstreams.length === upstreamNames.length &&
        upstreams.every(
          (u) =>
            u.state === "completed" ||
            u.state === "failed" ||
            u.state === "skipped",
        );
      const anyInProgress = upstreams.some((u) => u.state === "in_progress");
      const anyCompleted = upstreams.some((u) => u.state === "completed");
      const ts = upstreams
        .map((u) => u.updatedAt)
        .filter((t): t is string => typeof t === "string");
      const lastTs =
        ts.length > 0 ? ts.reduce((a, b) => (a > b ? a : b)) : null;
      // Nur ableiten, wenn die rohe Bewertungs-Zelle NICHT schon "completed"
      // ist — sonst respektieren wir den persistierten Erfolg.
      if (stages["companyEvaluation"].state !== "completed") {
        if (anyInProgress) {
          stages["companyEvaluation"] = {
            state: "in_progress",
            updatedAt: lastTs,
            errorMessage: null,
          };
        } else if (allTerminal && anyCompleted) {
          stages["companyEvaluation"] = {
            state: "completed",
            updatedAt: lastTs,
            errorMessage: null,
          };
        } else if (allTerminal) {
          stages["companyEvaluation"] = {
            state: "skipped",
            updatedAt: lastTs,
            errorMessage: null,
          };
        }
      }
    }

    return {
      companyId: co.companyId,
      name: co.name,
      location: co.location,
      lastSeenAt: co.lastSeenAt,
      stages,
    };
  });

  return c.json(
    {
      pageNumber: upstream.pageNumber,
      pageSize: upstream.pageSize,
      count: upstream.count,
      companies,
    },
    200,
  );
});

function normalizeState(
  s: string,
): "pending" | "in_progress" | "completed" | "failed" | "skipped" {
  if (
    s === "pending" ||
    s === "in_progress" ||
    s === "completed" ||
    s === "failed" ||
    s === "skipped"
  ) {
    return s;
  }
  return "pending";
}

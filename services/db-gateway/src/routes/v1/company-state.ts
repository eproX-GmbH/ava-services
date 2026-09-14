// v0.1.63 — F3 producer pre-check endpoint.
//
// Returns per-stage ContentFreshness for one company. Producers call
// this at the top of compute(), pass the response into the same
// `tierShouldWrite()` rule the gateway uses post-write, and skip
// their Selenium / LLM work entirely when the canonical data is
// already fresh + same-or-better-tier.
//
// This is purely an optimization over the F2 gateway-side gate. Even
// without F3, F2 already prevents bad writes from landing — F3 just
// saves the user's machine the cycles of doing the work that would
// have been thrown away anyway.

import { OpenAPIHono, createRoute, z } from "@hono/zod-openapi";
import { HTTPException } from "hono/http-exception";
import { getGatewayPool } from "../../lib/producer-pools";
import { ErrorShape } from "./schemas";
import { CompanyIdParam } from "./schemas";

export const companyStateRouter = new OpenAPIHono();

const StageStateShape = z
  .object({
    /** ISO-8601. null = no row yet (treat as Infinity age). */
    updatedAt: z.string().nullable(),
    /** 1..4 (C..S) — see /MODEL_TIERS.md. null for non-LLM stages
     *  OR untiered legacy writes. */
    llmTier: z.number().int().min(1).max(4).nullable(),
    /** v0.1.65 — exact model id (e.g. "gpt-4o", "qwen2.5:7b").
     *  null for non-LLM stages OR rows written before the column
     *  landed. Surfaced on CompanyDetail tooltips + agent context. */
    llmModel: z.string().nullable(),
    /** Register-Delta S7 — Registerblatt hat sich nach dem letzten Lauf
     *  geaendert; updatedAt wird dann als null gemeldet, damit der
     *  Producer neu laeuft. */
    veraltetSeit: z.string().nullable().optional(),
    veraltetGrund: z.string().nullable().optional(),
  })
  .openapi("StageState");

const CompanyStateResponseShape = z
  .object({
    companyId: z.string(),
    /** Map of producer name → freshness. Includes ALL producers,
     *  not just ones with rows; missing rows are returned as
     *  {updatedAt: null, llmTier: null}. */
    stages: z.record(z.string(), StageStateShape),
  })
  .openapi("CompanyStateResponse");

const stateRoute = createRoute({
  method: "get",
  path: "/companies/{companyId}/state",
  tags: ["companies"],
  summary:
    "Per-stage freshness snapshot for one company. Used by producer pre-check to skip already-fresh work.",
  request: { params: CompanyIdParam },
  responses: {
    200: {
      content: { "application/json": { schema: CompanyStateResponseShape } },
      description: "per-stage updatedAt + llmTier",
    },
    401: {
      content: { "application/json": { schema: ErrorShape } },
      description: "unauthenticated",
    },
  },
});

const KNOWN_STAGES = [
  "structured-content",
  "company-publication",
  "website",
  "company-profile",
  "company-contact",
  "company-evaluation",
] as const;

companyStateRouter.openapi(stateRoute, async (c) => {
  const auth = c.get("auth");
  if (!auth?.tenantId) {
    throw new HTTPException(401, { message: "auth_context_missing" });
  }
  const { companyId } = c.req.valid("param");

  const res = await getGatewayPool().query<{
    stage: string;
    llmTier: number | null;
    llmModel: string | null;
    updatedAt: Date;
  }>(
    `SELECT stage, "llmTier", "llmModel", "updatedAt"
       FROM "ContentFreshness"
      WHERE "companyId" = $1`,
    [companyId],
  );

  // Build a complete map keyed by every known stage so callers can
  // index without optional-chaining. Missing rows surface as nulls.
  const stages: Record<
    string,
    { updatedAt: string | null; llmTier: number | null; llmModel: string | null; veraltetSeit?: string | null; veraltetGrund?: string | null }
  > = {};
  for (const stage of KNOWN_STAGES) {
    stages[stage] = { updatedAt: null, llmTier: null, llmModel: null };
  }
  for (const row of res.rows) {
    stages[row.stage] = {
      updatedAt: row.updatedAt.toISOString(),
      llmTier: row.llmTier,
      llmModel: row.llmModel,
    };
  }

  // Register-Delta S7 — Veraltet-Markierung: ist das Registerblatt nach dem
  // letzten structured-content-Lauf geaendert worden, gilt die Stufe als
  // nicht frisch (updatedAt null), der Producer laeuft beim naechsten
  // Zugriff erneut. Die Markierung faellt mit dem naechsten Schreiben weg.
  const stale = await getGatewayPool().query<{ seit: Date; grund: string }>(
    `SELECT "seit", "grund" FROM "StructuredContentStale" WHERE "companyId" = $1`,
    [companyId],
  );
  const st = stale.rows[0];
  if (st) {
    const cell = stages["structured-content"];
    const alt = cell.updatedAt ? Date.parse(cell.updatedAt) : 0;
    if (st.seit.getTime() > alt) {
      stages["structured-content"] = { ...cell, updatedAt: null, veraltetSeit: st.seit.toISOString(), veraltetGrund: st.grund };
    }
  }

  return c.json({ companyId, stages }, 200);
});

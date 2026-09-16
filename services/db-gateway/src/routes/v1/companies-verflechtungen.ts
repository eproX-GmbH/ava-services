// Firmen-Verflechtungen (docs/PLAN_VERFLECHTUNGEN.md §5): Gesellschafter der
// neuesten Liste, Beteiligungen und das Netz (Breitensuche) aus master-data,
// fuer den Reiter "Verflechtungen" in den Firmendetails und die Chat-Tools.
// Nur mit Org-Feature `verflechtungen`.

import { OpenAPIHono, createRoute, z } from "@hono/zod-openapi";
import { requireScope } from "../../middleware/auth";
import { callUpstream } from "../../lib/upstream";
import { getGatewayPool } from "../../lib/producer-pools";
import { requireFeature } from "../../lib/policy-guard";
import { ErrorShape, CompanyIdParam } from "./schemas";

export const companiesVerflechtungenRouter = new OpenAPIHono();
companiesVerflechtungenRouter.use("*", requireScope("company:read"));
const tag = "companies";
const err = {
  401: { content: { "application/json": { schema: ErrorShape } }, description: "unauthenticated" },
  403: { content: { "application/json": { schema: ErrorShape } }, description: "feature disabled" },
  404: { content: { "application/json": { schema: ErrorShape } }, description: "not found" },
};

const shareholdersRoute = createRoute({
  method: "get",
  path: "/companies/{companyId}/shareholders",
  tags: [tag],
  summary: "Gesellschafter (neueste Liste), Stand der Pruefung und Beteiligungen der Firma",
  request: { params: CompanyIdParam },
  responses: { 200: { content: { "application/json": { schema: z.record(z.string(), z.unknown()) } }, description: "Gesellschafter" }, ...err },
});
companiesVerflechtungenRouter.openapi(shareholdersRoute, async (c) => {
  await requireFeature(getGatewayPool(), c.get("auth"), "verflechtungen");
  const { companyId } = c.req.valid("param");
  const u = await callUpstream<Record<string, unknown>>(c, "masterData", `/api/germany/v1/companies/${encodeURIComponent(companyId)}/shareholders`);
  return c.json(u, 200);
});

const networkRoute = createRoute({
  method: "get",
  path: "/companies/{companyId}/network",
  tags: [tag],
  summary: "Netz um eine Firma: Beteiligungen in beide Richtungen, Geschaeftsfuehrer, Breitensuche bis tiefe",
  request: { params: CompanyIdParam, query: z.object({ tiefe: z.coerce.number().int().min(1).max(6).default(2) }) },
  responses: { 200: { content: { "application/json": { schema: z.record(z.string(), z.unknown()) } }, description: "Netz" }, ...err },
});
companiesVerflechtungenRouter.openapi(networkRoute, async (c) => {
  await requireFeature(getGatewayPool(), c.get("auth"), "verflechtungen");
  const { companyId } = c.req.valid("param");
  const { tiefe } = c.req.valid("query");
  const u = await callUpstream<Record<string, unknown>>(c, "masterData", `/api/germany/v1/companies/${encodeURIComponent(companyId)}/network`, { query: { tiefe } });
  return c.json(u, 200);
});

// PM-2026-0045 — Website einer Firma von Hand vorgeben (Chat-Werkzeug
// company_website_festlegen). Die Website-Stufe uebernimmt die Vorgabe ohne Suche.

import { OpenAPIHono, createRoute, z } from "@hono/zod-openapi";
import { HTTPException } from "hono/http-exception";
import { vorgabeEntfernen, vorgabeLesen, vorgabeNormalisieren, vorgabeSetzen } from "../../lib/website-vorgabe";
import { logger } from "../../lib/logger";
import { ErrorShape } from "./schemas";

export const websiteVorgabeRouter = new OpenAPIHono();

const Param = z.object({ companyId: z.string().min(1).max(200) });
const VorgabeShape = z.object({ companyId: z.string(), url: z.string(), domain: z.string(), actorId: z.string(), updatedAt: z.string() });
const fehler = {
  400: { content: { "application/json": { schema: ErrorShape } }, description: "ungueltige Adresse" },
  401: { content: { "application/json": { schema: ErrorShape } }, description: "unauthenticated" },
} as const;

websiteVorgabeRouter.openapi(
  createRoute({
    method: "get", path: "/companies/{companyId}/website-vorgabe", tags: ["companies"],
    summary: "Von Hand vorgegebene Website einer Firma lesen",
    request: { params: Param },
    responses: { 200: { content: { "application/json": { schema: z.object({ vorgabe: VorgabeShape.nullable() }) } }, description: "Vorgabe oder null" }, ...fehler },
  }),
  async (c) => {
    if (!c.get("auth")?.tenantId) throw new HTTPException(401, { message: "auth_context_missing" });
    const { companyId } = c.req.valid("param");
    return c.json({ vorgabe: await vorgabeLesen(companyId) }, 200);
  },
);

websiteVorgabeRouter.openapi(
  createRoute({
    method: "put", path: "/companies/{companyId}/website-vorgabe", tags: ["companies"],
    summary: "Website einer Firma von Hand vorgeben. Die Website-Stufe nutzt sie beim naechsten Lauf ohne Suche; die Frische der Stufe wird geloescht.",
    request: { params: Param, body: { content: { "application/json": { schema: z.object({ url: z.string().min(4).max(300) }) } } } },
    responses: { 200: { content: { "application/json": { schema: z.object({ vorgabe: VorgabeShape }) } }, description: "gesetzt" }, ...fehler },
  }),
  async (c) => {
    const auth = c.get("auth");
    if (!auth?.tenantId || !auth.actorId) throw new HTTPException(401, { message: "auth_context_missing" });
    const { companyId } = c.req.valid("param");
    const n = vorgabeNormalisieren(c.req.valid("json").url);
    if (!n) throw new HTTPException(400, { message: "ungueltige_adresse" });
    const vorgabe = await vorgabeSetzen({ companyId, url: n.url, domain: n.domain, tenantId: auth.tenantId, actorId: auth.actorId });
    logger.info({ companyId, domain: n.domain, actorId: auth.actorId, tenantId: auth.tenantId }, "[website-vorgabe] gesetzt");
    return c.json({ vorgabe }, 200);
  },
);

websiteVorgabeRouter.openapi(
  createRoute({
    method: "delete", path: "/companies/{companyId}/website-vorgabe", tags: ["companies"],
    summary: "Von Hand vorgegebene Website entfernen (die Website-Stufe sucht wieder selbst)",
    request: { params: Param },
    responses: { 200: { content: { "application/json": { schema: z.object({ entfernt: z.boolean() }) } }, description: "entfernt" }, ...fehler },
  }),
  async (c) => {
    const auth = c.get("auth");
    if (!auth?.tenantId) throw new HTTPException(401, { message: "auth_context_missing" });
    const { companyId } = c.req.valid("param");
    const entfernt = await vorgabeEntfernen(companyId);
    if (entfernt) logger.info({ companyId, actorId: auth.actorId, tenantId: auth.tenantId }, "[website-vorgabe] entfernt");
    return c.json({ entfernt }, 200);
  },
);

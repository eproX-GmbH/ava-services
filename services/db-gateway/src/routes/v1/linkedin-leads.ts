// LinkedIn-Leads (docs/PLAN_LINKEDIN_LEADS.md L1): Personen, die auf beobachtete Posts
// reagiert haben, je Tenant. Der Personen-Radar der AVA legt sie ab (batch), die
// Oberflaeche liest, ignoriert oder uebernimmt. Die Uebernahme (Firma + Kontakt) steuert
// die AVA, weil Import und Kontaktanlage ihre eigenen Routen haben; hier wird nur der
// Stand am Lead festgehalten.

import { OpenAPIHono, createRoute, z } from "@hono/zod-openapi";
import { HTTPException } from "hono/http-exception";
import { getGatewayPool } from "../../lib/producer-pools";
import { leadAendern, leadLesen, leadsAblegen, leadsListe, leadsPosts } from "../../lib/linkedin-leads";
import { ErrorShape } from "./schemas";

export const linkedinLeadsRouter = new OpenAPIHono();

const Status = z.enum(["offen", "uebernommen", "ignoriert", "ungeklaert"]);
const ok = (d: string) => ({ 200: { content: { "application/json": { schema: z.object({}).passthrough() } }, description: d }, 401: { content: { "application/json": { schema: ErrorShape } }, description: "unauthenticated" } });

const LeadEingabe = z.object({
  postUrl: z.string().min(10).max(600),
  postTitel: z.string().max(200).nullish(),
  personName: z.string().max(200).nullable(),
  profileUrl: z.string().min(10).max(600),
  headline: z.string().max(300).nullish(),
  rolle: z.string().max(200).nullish(),
  aktivitaet: z.enum(["reaction", "comment"]),
  reactionType: z.string().max(40).nullish(),
  kommentar: z.string().max(2000).nullish(),
  firmaDomain: z.string().max(253).nullish(),
  firmaName: z.string().max(300).nullish(),
  konfidenz: z.number().min(0).max(1).nullish(),
  status: z.enum(["offen", "ungeklaert"]).optional(),
  grund: z.string().max(300).nullish(),
});

linkedinLeadsRouter.openapi(createRoute({ method: "post", path: "/linkedin-leads/batch", tags: ["linkedin-leads"], summary: "Leads eines Personen-Radar-Laufs ablegen (je Person und Post einer)", request: { body: { content: { "application/json": { schema: z.object({ leads: z.array(LeadEingabe).min(1).max(500) }) } } } }, responses: ok("abgelegt") }), async (c) => {
  const auth = c.get("auth");
  if (!auth?.tenantId) throw new HTTPException(401, { message: "auth_context_missing" });
  const { leads } = c.req.valid("json");
  return c.json(await leadsAblegen(getGatewayPool(), auth.tenantId, auth.actorId ?? null, leads), 200);
});

linkedinLeadsRouter.openapi(createRoute({ method: "get", path: "/linkedin-leads", tags: ["linkedin-leads"], summary: "Leads lesen (Standard: offen und ungeklaert)", request: { query: z.object({ status: Status.or(z.literal("alle")).optional(), postUrl: z.string().max(600).optional(), nurKommentare: z.coerce.boolean().default(false), seite: z.coerce.number().int().min(1).default(1), groesse: z.coerce.number().int().min(1).max(200).default(50) }) }, responses: ok("Leads") }), async (c) => {
  const auth = c.get("auth");
  if (!auth?.tenantId) throw new HTTPException(401, { message: "auth_context_missing" });
  const q = c.req.valid("query");
  return c.json(await leadsListe(getGatewayPool(), auth.tenantId, q), 200);
});

linkedinLeadsRouter.openapi(createRoute({ method: "get", path: "/linkedin-leads/posts", tags: ["linkedin-leads"], summary: "Beobachtete Posts mit Zaehlern", responses: ok("Posts") }), async (c) => {
  const auth = c.get("auth");
  if (!auth?.tenantId) throw new HTTPException(401, { message: "auth_context_missing" });
  return c.json({ posts: await leadsPosts(getGatewayPool(), auth.tenantId) }, 200);
});

linkedinLeadsRouter.openapi(createRoute({ method: "get", path: "/linkedin-leads/{id}", tags: ["linkedin-leads"], summary: "Einen Lead lesen", request: { params: z.object({ id: z.string().min(4).max(64) }) }, responses: ok("Lead") }), async (c) => {
  const auth = c.get("auth");
  if (!auth?.tenantId) throw new HTTPException(401, { message: "auth_context_missing" });
  const lead = await leadLesen(getGatewayPool(), auth.tenantId, c.req.valid("param").id);
  if (!lead) throw new HTTPException(404, { message: "lead_not_found" });
  return c.json(lead as unknown as Record<string, never>, 200);
});

linkedinLeadsRouter.openapi(createRoute({ method: "patch", path: "/linkedin-leads/{id}", tags: ["linkedin-leads"], summary: "Lead aendern: ignorieren, zuruecknehmen, Uebernahme festhalten", request: { params: z.object({ id: z.string().min(4).max(64) }), body: { content: { "application/json": { schema: z.object({ status: Status.optional(), ignoriertGrund: z.string().max(200).nullish(), companyId: z.string().max(120).nullish(), personId: z.string().max(120).nullish(), firmaDomain: z.string().max(253).nullish(), firmaName: z.string().max(300).nullish() }) } } } }, responses: ok("geaendert") }), async (c) => {
  const auth = c.get("auth");
  if (!auth?.tenantId) throw new HTTPException(401, { message: "auth_context_missing" });
  const b = c.req.valid("json");
  const lead = await leadAendern(getGatewayPool(), auth.tenantId, c.req.valid("param").id, {
    ...(b.status ? { status: b.status } : {}),
    ...(b.ignoriertGrund !== undefined ? { ignoriertGrund: b.ignoriertGrund ?? null } : {}),
    ...(b.companyId !== undefined ? { companyId: b.companyId ?? null } : {}),
    ...(b.personId !== undefined ? { personId: b.personId ?? null } : {}),
    ...(b.firmaDomain !== undefined ? { firmaDomain: b.firmaDomain ?? null } : {}),
    ...(b.firmaName !== undefined ? { firmaName: b.firmaName ?? null } : {}),
  }, auth.actorId ?? null);
  if (!lead) throw new HTTPException(404, { message: "lead_not_found" });
  return c.json(lead as unknown as Record<string, never>, 200);
});

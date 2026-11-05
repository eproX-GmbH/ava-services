// Rueckkanal fremder Dienste (docs/PLAN_CLOSE_MCP.md, C4).
//
//   oeffentlich (vor dem JWT-Zaun gemountet, Token in der Adresse):
//     POST /v1/webhooks/ereignis/{token}
//   angemeldet:
//     GET    /v1/dienste/webhooks            Empfangsadressen des Nutzers
//     POST   /v1/dienste/webhooks            anlegen oder vorhandene liefern { dienst }
//     DELETE /v1/dienste/webhooks/{id}
//     GET    /v1/dienste/ereignisse          ?dienst&seit&ungelesen&limit
//     POST   /v1/dienste/ereignisse/gelesen  { ids }

import { OpenAPIHono, createRoute, z } from "@hono/zod-openapi";
import { HTTPException } from "hono/http-exception";
import { loadEnv } from "../../lib/env";
import { logger } from "../../lib/logger";
import { getGatewayPool } from "../../lib/producer-pools";
import { requireScope } from "../../middleware/auth";
import { empfaengerAnlegen, empfaengerListe, empfaengerLoeschen, empfangsUrl, ereignisAblegen, ereignisseGelesen, ereignisseLesen } from "../../lib/dienst-webhooks";

const ErrorShape = z.object({ error: z.string() });
const errorResponses = {
  401: { content: { "application/json": { schema: ErrorShape } }, description: "unauthenticated" },
  404: { content: { "application/json": { schema: ErrorShape } }, description: "not found" },
} as const;

const MAX_BODY = 256 * 1024;

// ---- oeffentlich ----

export const webhookEmpfangRouter = new OpenAPIHono();
webhookEmpfangRouter.post("/v1/webhooks/ereignis/:token", async (c) => {
  const token = c.req.param("token");
  if (!token || token.length < 16 || token.length > 128) return c.json({ error: "unknown_token" }, 404);
  const roh = await c.req.text().catch(() => "");
  if (roh.length > MAX_BODY) return c.json({ error: "payload_too_large" }, 413);
  let nutzlast: unknown = roh;
  try {
    nutzlast = roh ? JSON.parse(roh) : {};
  } catch {
    nutzlast = { text: roh.slice(0, 10_000) };
  }
  const r = await ereignisAblegen(getGatewayPool(), token, nutzlast);
  if (!r) return c.json({ error: "unknown_token" }, 404);
  logger.info({ dienst: r.empfaenger.dienst, actorId: r.empfaenger.actorId, id: r.id }, "[dienst-webhooks] Ereignis angenommen");
  return c.json({ ok: true, id: r.id }, 200);
});

// ---- angemeldet ----

export const dienstWebhooksRouter = new OpenAPIHono();
dienstWebhooksRouter.use("*", requireScope("company:read"));

function actor(c: { get: (k: "auth") => unknown }): { tenantId: string; actorId: string } {
  const auth = c.get("auth") as { tenantId?: string | null; actorId?: string | null } | undefined;
  if (!auth?.tenantId || !auth.actorId) throw new HTTPException(401, { message: "auth_context_missing" });
  return { tenantId: auth.tenantId, actorId: auth.actorId };
}

const EmpfaengerShape = z.object({ id: z.string(), dienst: z.string(), url: z.string(), createdAt: z.string(), zuletztAt: z.string().nullable(), anzahl: z.number() });

const listeRoute = createRoute({
  method: "get", path: "/dienste/webhooks", tags: ["dienste"], summary: "Empfangsadressen des Nutzers fuer Ereignisse fremder Dienste",
  responses: { 200: { content: { "application/json": { schema: z.object({ empfaenger: z.array(EmpfaengerShape) }) } }, description: "Liste" }, ...errorResponses },
});
dienstWebhooksRouter.openapi(listeRoute, async (c) => {
  const a = actor(c);
  const basis = loadEnv().GATEWAY_PUBLIC_URL;
  const l = await empfaengerListe(getGatewayPool(), a.actorId);
  return c.json({ empfaenger: l.map((e) => ({ id: e.id, dienst: e.dienst, url: empfangsUrl(basis, e.token), createdAt: e.createdAt.toISOString(), zuletztAt: e.zuletztAt ? e.zuletztAt.toISOString() : null, anzahl: Number(e.anzahl) })) }, 200);
});

const anlegenRoute = createRoute({
  method: "post", path: "/dienste/webhooks", tags: ["dienste"], summary: "Empfangsadresse anlegen (oder vorhandene liefern)",
  request: { body: { content: { "application/json": { schema: z.object({ dienst: z.string().min(1).max(60) }) } } } },
  responses: { 200: { content: { "application/json": { schema: EmpfaengerShape } }, description: "Empfaenger" }, ...errorResponses },
});
dienstWebhooksRouter.openapi(anlegenRoute, async (c) => {
  const a = actor(c);
  const e = await empfaengerAnlegen(getGatewayPool(), { ...a, dienst: c.req.valid("json").dienst });
  return c.json({ id: e.id, dienst: e.dienst, url: empfangsUrl(loadEnv().GATEWAY_PUBLIC_URL, e.token), createdAt: e.createdAt.toISOString(), zuletztAt: e.zuletztAt ? e.zuletztAt.toISOString() : null, anzahl: Number(e.anzahl) }, 200);
});

const loeschenRoute = createRoute({
  method: "delete", path: "/dienste/webhooks/{id}", tags: ["dienste"], summary: "Empfangsadresse entfernen",
  request: { params: z.object({ id: z.string().min(1) }) },
  responses: { 200: { content: { "application/json": { schema: z.object({ ok: z.boolean() }) } }, description: "ok" }, ...errorResponses },
});
dienstWebhooksRouter.openapi(loeschenRoute, async (c) => {
  const a = actor(c);
  const ok = await empfaengerLoeschen(getGatewayPool(), a.actorId, c.req.valid("param").id);
  if (!ok) throw new HTTPException(404, { message: "not_found" });
  return c.json({ ok: true }, 200);
});

const EreignisShape = z.object({ id: z.string(), dienst: z.string(), typ: z.string().nullable(), nutzlast: z.unknown(), empfangenAt: z.string(), gelesenAt: z.string().nullable() });

const ereignisseRoute = createRoute({
  method: "get", path: "/dienste/ereignisse", tags: ["dienste"], summary: "Ereignisse fremder Dienste (neueste zuerst)",
  request: { query: z.object({ dienst: z.string().max(60).optional(), seit: z.string().datetime().optional(), ungelesen: z.enum(["1", "0"]).optional(), limit: z.coerce.number().int().min(1).max(200).default(50) }) },
  responses: { 200: { content: { "application/json": { schema: z.object({ ereignisse: z.array(EreignisShape) }) } }, description: "Ereignisse" }, ...errorResponses },
});
dienstWebhooksRouter.openapi(ereignisseRoute, async (c) => {
  const a = actor(c);
  const q = c.req.valid("query");
  const l = await ereignisseLesen(getGatewayPool(), { actorId: a.actorId, dienst: q.dienst, seit: q.seit ? new Date(q.seit) : undefined, nurUngelesen: q.ungelesen === "1", limit: q.limit });
  return c.json({ ereignisse: l.map((e) => ({ id: e.id, dienst: e.dienst, typ: e.typ, nutzlast: e.nutzlast, empfangenAt: e.empfangenAt.toISOString(), gelesenAt: e.gelesenAt ? e.gelesenAt.toISOString() : null })) }, 200);
});

const gelesenRoute = createRoute({
  method: "post", path: "/dienste/ereignisse/gelesen", tags: ["dienste"], summary: "Ereignisse als gelesen markieren",
  request: { body: { content: { "application/json": { schema: z.object({ ids: z.array(z.string().min(1)).min(1).max(500) }) } } } },
  responses: { 200: { content: { "application/json": { schema: z.object({ markiert: z.number() }) } }, description: "Anzahl" }, ...errorResponses },
});
dienstWebhooksRouter.openapi(gelesenRoute, async (c) => {
  const a = actor(c);
  return c.json({ markiert: await ereignisseGelesen(getGatewayPool(), a.actorId, c.req.valid("json").ids) }, 200);
});

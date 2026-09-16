// Firmen-Verflechtungen V4 (docs/PLAN_VERFLECHTUNGEN.md §4 Nr. 6, §8 Nr. 5):
// tieferer Lauf auf Wunsch (App, Chat-Tool) und Stand eines Kontexts.
// Der Standardlauf je Pool-Firma (eine Ebene) braucht keine Route; er
// entsteht im persist-bus, sobald eine Liste ankommt.

import { OpenAPIHono, createRoute, z } from "@hono/zod-openapi";
import { HTTPException } from "hono/http-exception";
import { requireScope } from "../../middleware/auth";
import { getGatewayPool } from "../../lib/producer-pools";
import { kontextAnlegen, kontextStand, kontexteVon, listeFaellig, MAX_TIEFE } from "../../lib/verflechtungen";
import { ErrorShape } from "./schemas";

export const verflechtungenRouter = new OpenAPIHono();
verflechtungenRouter.use("*", requireScope("company:read"));
const tag = "verflechtungen";
const err = {
  400: { content: { "application/json": { schema: ErrorShape } }, description: "bad request" },
  401: { content: { "application/json": { schema: ErrorShape } }, description: "unauthenticated" },
  404: { content: { "application/json": { schema: ErrorShape } }, description: "not found" },
};
const auth = (c: { get: (k: "auth") => { tenantId: string; actorId: string } }) => c.get("auth");

const KontextShape = z.object({
  kontext: z.string(),
  ursprungCompanyId: z.string(),
  transactionId: z.string(),
  maxTiefe: z.number(),
  maxFirmen: z.number(),
  ohneBremse: z.boolean(),
  erstelltAt: z.string(),
  offen: z.number(),
  erledigt: z.number(),
});

const anlegenRoute = createRoute({
  method: "post",
  path: "/verflechtungen/kontexte",
  tags: [tag],
  summary: "Firmengeflecht ab einer Firma tiefer verfolgen (Rekursion ueber Firmen-Gesellschafter)",
  request: {
    body: {
      content: {
        "application/json": {
          schema: z.object({
            companyId: z.string().min(3).max(120),
            name: z.string().max(200).optional(),
            maxTiefe: z.number().int().min(1).max(12).default(MAX_TIEFE),
            /** Notbremsen (Tiefe, 200 Firmen) aufheben; nur nach ausdruecklicher Bestaetigung. */
            ohneBremse: z.boolean().default(false),
          }),
        },
      },
    },
  },
  responses: {
    200: { content: { "application/json": { schema: z.object({ kontext: z.string(), transactionId: z.string(), angestossen: z.boolean(), unbekannt: z.boolean() }) } }, description: "Kontext angelegt" },
    ...err,
  },
});
verflechtungenRouter.openapi(anlegenRoute, async (c) => {
  const a = auth(c);
  const body = c.req.valid("json");
  if (!/^[A-Z0-9]+_HR[AB]_/.test(body.companyId)) throw new HTTPException(400, { message: "nur deutsche Firmen (HRA/HRB)" });
  const r = await kontextAnlegen(getGatewayPool(), {
    tenantId: a.tenantId,
    userId: a.actorId,
    companyId: body.companyId,
    ursprungName: body.name ?? null,
    maxTiefe: body.maxTiefe,
    ohneBremse: body.ohneBremse,
  });
  return c.json(r, 200);
});

const listeRoute = createRoute({
  method: "get",
  path: "/verflechtungen/kontexte",
  tags: [tag],
  summary: "Kontexte einer Firma (neueste zuerst)",
  request: { query: z.object({ companyId: z.string().min(3) }) },
  responses: { 200: { content: { "application/json": { schema: z.object({ items: z.array(KontextShape) }) } }, description: "Kontexte" }, ...err },
});
verflechtungenRouter.openapi(listeRoute, async (c) => {
  const a = auth(c);
  const rows = await kontexteVon(getGatewayPool(), a.tenantId, c.req.valid("query").companyId);
  return c.json({ items: rows.map((k) => ({ kontext: k.kontext, ursprungCompanyId: k.ursprungCompanyId, transactionId: k.transactionId, maxTiefe: k.maxTiefe, maxFirmen: k.maxFirmen, ohneBremse: k.ohneBremse, erstelltAt: k.erstelltAt.toISOString(), offen: k.offen, erledigt: k.erledigt })) }, 200);
});

const standRoute = createRoute({
  method: "get",
  path: "/verflechtungen/kontexte/{kontext}",
  tags: [tag],
  summary: "Stand eines Kontexts (Besuchsliste)",
  request: { params: z.object({ kontext: z.string().min(3) }) },
  responses: {
    200: {
      content: {
        "application/json": {
          schema: z.object({
            kontext: z.string(),
            ursprungCompanyId: z.string(),
            transactionId: z.string(),
            maxTiefe: z.number(),
            maxFirmen: z.number(),
            ohneBremse: z.boolean(),
            zaehler: z.record(z.string(), z.number()),
            besuche: z.array(z.object({ companyId: z.string(), tiefe: z.number(), status: z.string(), grund: z.string().nullable() })),
          }),
        },
      },
      description: "Stand",
    },
    ...err,
  },
});
verflechtungenRouter.openapi(standRoute, async (c) => {
  const a = auth(c);
  const s = await kontextStand(getGatewayPool(), a.tenantId, c.req.valid("param").kontext);
  if (!s) throw new HTTPException(404, { message: "Kontext unbekannt" });
  return c.json({ kontext: s.kontext.kontext, ursprungCompanyId: s.kontext.ursprungCompanyId, transactionId: s.kontext.transactionId, maxTiefe: s.kontext.maxTiefe, maxFirmen: s.kontext.maxFirmen, ohneBremse: s.kontext.ohneBremse, zaehler: s.zaehler, besuche: s.besuche }, 200);
});

// Producer-Abfrage vor dem DK-Abruf: 30-Tage-Sperre wie bei allen Producern,
// manueller Start (Retry, "Tiefer verfolgen") hebt sie einmalig auf.
const faelligRoute = createRoute({
  method: "get",
  path: "/verflechtungen/faellig/{companyId}",
  tags: [tag],
  summary: "Darf die Gesellschafterliste dieser Firma jetzt gelesen werden? (30-Tage-Sperre, manuell erzwungen)",
  request: { params: z.object({ companyId: z.string().min(3) }) },
  responses: { 200: { content: { "application/json": { schema: z.object({ faellig: z.boolean(), grund: z.string() }) } }, description: "Stand" }, ...err },
});
verflechtungenRouter.openapi(faelligRoute, async (c) => {
  auth(c);
  return c.json(await listeFaellig(getGatewayPool(), c.req.valid("param").companyId), 200);
});

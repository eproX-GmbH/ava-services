// Verbundene Dienste (docs/PLAN_MCP_OEFFNUNG.md, P5): Welche OAuth-Clients
// (Claude, ChatGPT, Claude Code …) hat der Nutzer fuer AVA freigegeben, und
// Widerruf. Quelle ist Keycloak: die Einwilligungen (consents) des Nutzers
// ueber die Admin-API mit dem Service-Account `ava-registrar`
// (Realm-Rolle manage-users reicht fuer /users/{id}/consents).
//
// Nur die eigenen Daten des angemeldeten Nutzers (sub = Keycloak-User-ID).
// Widerruf loescht die Einwilligung (Refresh-Tokens werden ungueltig); ein
// dynamisch registrierter `mcp-`-Client ohne weitere Einwilligungen wird
// zusaetzlich entfernt, damit Keycloak nicht mit Leichen vollaeuft.

import { OpenAPIHono, createRoute, z } from "@hono/zod-openapi";
import { HTTPException } from "hono/http-exception";
import { requireScope } from "../../middleware/auth";
import { listeEinwilligungen, widerrufeEinwilligung, RegistrationDisabledError } from "../../lib/keycloak-admin";
import { ErrorShape } from "./schemas";
import { logger } from "../../lib/logger";

export const verbindungenRouter = new OpenAPIHono();
verbindungenRouter.use("*", requireScope("company:read"));
const tag = "auth";

const VerbindungShape = z
  .object({
    clientId: z.string(),
    name: z.string().nullable(),
    /** Dynamisch registrierter MCP-Client (mcp-…)? */
    mcp: z.boolean(),
    erteiltAt: z.string().nullable(),
    zuletztAt: z.string().nullable(),
    scopes: z.array(z.string()),
  })
  .openapi("Verbindung");

const listeRoute = createRoute({
  method: "get",
  path: "/auth/verbindungen",
  tags: [tag],
  summary: "Vom Nutzer freigegebene OAuth-Clients (MCP: Claude, ChatGPT, Claude Code)",
  responses: {
    200: { content: { "application/json": { schema: z.object({ items: z.array(VerbindungShape) }) } }, description: "Verbindungen" },
    401: { content: { "application/json": { schema: ErrorShape } }, description: "unauthenticated" },
    503: { content: { "application/json": { schema: ErrorShape } }, description: "Keycloak-Admin nicht eingerichtet" },
  },
});
verbindungenRouter.openapi(listeRoute, async (c) => {
  const auth = c.get("auth");
  try {
    const items = await listeEinwilligungen(auth.actorId);
    return c.json({ items }, 200);
  } catch (err) {
    if (err instanceof RegistrationDisabledError) throw new HTTPException(503, { message: "Keycloak-Admin ist auf diesem Gateway nicht eingerichtet." });
    throw err;
  }
});

const widerrufRoute = createRoute({
  method: "delete",
  path: "/auth/verbindungen/{clientId}",
  tags: [tag],
  summary: "Verbindung widerrufen (Einwilligung loeschen; dynamische MCP-Clients werden entfernt)",
  request: { params: z.object({ clientId: z.string().min(1).max(120) }) },
  responses: {
    200: { content: { "application/json": { schema: z.object({ ok: z.boolean(), entfernt: z.boolean() }) } }, description: "widerrufen" },
    401: { content: { "application/json": { schema: ErrorShape } }, description: "unauthenticated" },
    404: { content: { "application/json": { schema: ErrorShape } }, description: "keine solche Verbindung" },
  },
});
verbindungenRouter.openapi(widerrufRoute, async (c) => {
  const auth = c.get("auth");
  const { clientId } = c.req.valid("param");
  const r = await widerrufeEinwilligung(auth.actorId, clientId);
  if (!r.gefunden) throw new HTTPException(404, { message: "Keine Verbindung mit diesem Client." });
  logger.info({ actorId: auth.actorId, clientId, entfernt: r.entfernt }, "[verbindungen] widerrufen");
  return c.json({ ok: true, entfernt: r.entfernt }, 200);
});

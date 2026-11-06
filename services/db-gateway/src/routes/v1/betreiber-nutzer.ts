// Betreiber: aktive Nutzer (Joyce 2026-11-06) — wer hat zuletzt mit AVA
// gearbeitet, auf welchem Geraet, mit welcher Version. Nur Betreiber (sonst 404).

import { OpenAPIHono, createRoute, z } from "@hono/zod-openapi";
import { HTTPException } from "hono/http-exception";
import { getGatewayPool } from "../../lib/producer-pools";
import { aktiveNutzerListe } from "../../lib/nutzer-aktivitaet";
import { istBetreiber } from "../../middleware/auth";
import { ErrorShape } from "./schemas";

export const betreiberNutzerRouter = new OpenAPIHono();

betreiberNutzerRouter.openapi(
  createRoute({
    method: "get",
    path: "/betreiber/nutzer/aktiv",
    tags: ["betreiber"],
    summary: "Betreiber: Nutzer nach letzter Aktivitaet (aktiv = Anfrage in den letzten 15 Minuten)",
    request: { query: z.object({ seite: z.coerce.number().int().min(1).default(1), groesse: z.coerce.number().int().min(1).max(50).default(50), nurAktiv: z.enum(["0", "1"]).default("0") }) },
    responses: {
      200: { content: { "application/json": { schema: z.object({}).passthrough() } }, description: "Nutzer" },
      404: { content: { "application/json": { schema: ErrorShape } }, description: "kein Betreiber" },
    },
  }),
  async (c) => {
    if (!istBetreiber(c.get("auth"))) throw new HTTPException(404, { message: "not_found" });
    const q = c.req.valid("query");
    return c.json(await aktiveNutzerListe(getGatewayPool(), { seite: q.seite, groesse: q.groesse, nurAktiv: q.nurAktiv === "1" }), 200);
  },
);

// Öffentliches Angebot des AVA-Servers (docs/PLAN_CLOUD_SELBSTBEDIENUNG.md Z6): Website
// (/willkommen, /preise) fragt, ob der Server schon buchbar ist und was er kostet. Keine Auth,
// nur der Schalter CLOUD_SELBSTBEDIENUNG und Listenpreise.
import { OpenAPIHono, createRoute, z } from "@hono/zod-openapi";
import { planEintrag } from "../../lib/billing-plans";
import { cloudPreise } from "../../lib/cloud/abrechnung";

export const cloudAngebotRouter = new OpenAPIHono();

cloudAngebotRouter.openapi(
  createRoute({
    method: "get",
    path: "/cloud/angebot",
    tags: ["cloud"],
    summary: "AVA-Server (öffentlich): buchbar ja/nein und Preise netto in Cent",
    responses: {
      200: {
        content: { "application/json": { schema: z.object({ buchbar: z.boolean(), preis: z.object({ serverCents: z.number().int(), paketCents: z.number().int(), proCents: z.number().int() }) }) } },
        description: "Angebot",
      },
    },
  }),
  (c) => {
    const proCents = planEintrag("pro").preisCents ?? 4900;
    c.header("cache-control", "public, max-age=60");
    return c.json({ buchbar: process.env.CLOUD_SELBSTBEDIENUNG === "1", preis: { ...cloudPreise(proCents), proCents } }, 200);
  },
);

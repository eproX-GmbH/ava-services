// docs/PLAN_PRICING_TIERS.md P1 — oeffentlicher Plan-Katalog fuer App, Konsole,
// PWA und Website. Keine Auth: enthaelt nur Listenpreise und Merkmale.
import { OpenAPIHono, createRoute, z } from "@hono/zod-openapi";
import { planKatalog } from "../../lib/billing-plans";
import { stufenPreise } from "../../lib/stufen";

export const plaeneRouter = new OpenAPIHono();

const PlanShape = z.object({
  plan: z.string(),
  name: z.string(),
  rang: z.number().int(),
  preisCents: z.number().int().nullable(),
  kontingentCents: z.number().int().nullable(),
  firmenLebenslang: z.number().int().nullable(),
  payg: z.boolean(),
  linkedinBeobachtung: z.boolean(),
  merkmale: z.array(z.string()),
  /** Beispiel: so viele Firmen passen ins Kontingent, wenn alle klein bzw. gross sind. */
  beispielFirmen: z.object({ klein: z.number().int(), gross: z.number().int() }).nullable(),
});

const route = createRoute({
  method: "get",
  path: "/plaene",
  tags: ["billing"],
  summary: "Plan-Katalog (oeffentlich): Sitzpreise, Kontingente, Merkmale, Stufenpreise je Firma.",
  responses: {
    200: {
      content: { "application/json": { schema: z.object({ plaene: z.array(PlanShape), stufen: z.object({ klein: z.number().int(), mittel: z.number().int(), gross: z.number().int() }), freePlaetzeJeOrganisation: z.number().int() }) } },
      description: "ok",
    },
  },
});

plaeneRouter.openapi(route, (c) => {
  const st = stufenPreise();
  const plaene = planKatalog().map((p) => ({
    ...p,
    beispielFirmen:
      p.kontingentCents !== null
        ? { klein: Math.floor(p.kontingentCents / st.klein.preisCents), gross: Math.floor(p.kontingentCents / st.gross.preisCents) }
        : null,
  }));
  return c.json({ plaene, stufen: { klein: st.klein.preisCents, mittel: st.mittel.preisCents, gross: st.gross.preisCents }, freePlaetzeJeOrganisation: 3 }, 200);
});

// Firmenhistorie (docs/PLAN_FIRMEN_HISTORIE.md, H1):
//   GET /firmen-ereignisse?meine=1|companyIds=a,b&arten=&gruppen=&ebene=&seit=&bis=&limit=
// Personal- und Geschaeftsfuehrungswechsel aus den zentralen Daten (lib/firmen-ereignisse.ts).
// `meine=1` nimmt alle Firmen der Organisation wie „Meine Firmen“ (ohne geloeschte und ruhende).

import { OpenAPIHono, createRoute, z } from "@hono/zod-openapi";
import { requireScope } from "../../middleware/auth";
import { firmenEreignisse, type EreignisArt } from "../../lib/firmen-ereignisse";
import { ROLLENGRUPPEN, type Rollengruppe } from "../../lib/rollengruppe";
import { firmenDesNutzers } from "../../lib/neuigkeiten-cron";
import { fluktuation } from "../../lib/fluktuation";
import { ErrorShape } from "./schemas";

export const firmenEreignisseRouter = new OpenAPIHono();
firmenEreignisseRouter.use("*", requireScope("company:read"));

const ARTEN = ["neu", "verlassen", "wechsel", "geschaeftsfuehrung"] as const;
const liste = (s: string | undefined) => (s ?? "").split(",").map((x) => x.trim()).filter(Boolean);

const Ereignis = z.object({
  id: z.string(),
  art: z.enum(ARTEN),
  companyId: z.string(),
  firma: z.string().nullable(),
  personId: z.string().nullable(),
  person: z.string().nullable(),
  rolleVorher: z.string().nullable(),
  rolle: z.string().nullable(),
  gruppe: z.string(),
  gruppeLabel: z.string(),
  ebene: z.enum(["leitung", "mitarbeit"]),
  gruppeVorher: z.string().nullable(),
  ebeneVorher: z.enum(["leitung", "mitarbeit"]).nullable(),
  zeitpunkt: z.string(),
  zeitpunktArt: z.enum(["laut_profil", "erstmals_gesehen", "festgestellt", "register"]),
  quelle: z.string().nullable(),
  url: z.string().nullable(),
  neuBestellt: z.array(z.string()).optional(),
  ausgeschieden: z.array(z.string()).optional(),
});

firmenEreignisseRouter.openapi(
  createRoute({
    method: "get",
    path: "/firmen-ereignisse",
    tags: ["firmen"],
    summary: "Personal- und Geschaeftsfuehrungswechsel einer Firmenliste (Firmenhistorie)",
    request: {
      query: z.object({
        meine: z.enum(["1", "true"]).optional(),
        companyIds: z.string().max(20_000).optional(),
        arten: z.string().max(200).optional(),
        gruppen: z.string().max(300).optional(),
        ebene: z.enum(["leitung", "mitarbeit"]).optional(),
        seit: z.string().datetime({ offset: true }).optional().or(z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional()),
        bis: z.string().datetime({ offset: true }).optional().or(z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional()),
        limit: z.coerce.number().int().min(1).max(500).default(100),
      }),
    },
    responses: {
      200: { content: { "application/json": { schema: z.object({ firmen: z.number().int(), items: z.array(Ereignis) }) } }, description: "ok" },
      400: { content: { "application/json": { schema: ErrorShape } }, description: "bad request" },
    },
  }),
  async (c) => {
    const q = c.req.valid("query");
    const auth = c.get("auth") as { actorId?: string | null };
    let ids = liste(q.companyIds);
    if (q.meine) {
      if (!auth.actorId) return c.json({ error: "kein_nutzer", message: "Für „meine Firmen“ fehlt der Nutzer." }, 400);
      const meine = await firmenDesNutzers(auth.actorId);
      ids = ids.length > 0 ? ids.filter((id) => meine.includes(id)) : meine;
    }
    if (ids.length === 0) return c.json({ firmen: 0, items: [] }, 200);
    const arten = liste(q.arten).filter((a): a is EreignisArt => (ARTEN as readonly string[]).includes(a));
    const gruppen = liste(q.gruppen).filter((g): g is Rollengruppe => g in ROLLENGRUPPEN);
    const items = await firmenEreignisse({
      companyIds: ids,
      arten,
      gruppen,
      ebene: q.ebene ?? null,
      seit: q.seit ? new Date(q.seit) : null,
      bis: q.bis ? new Date(q.bis.length === 10 ? `${q.bis}T23:59:59Z` : q.bis) : null,
      limit: q.limit,
    });
    return c.json({ firmen: ids.length, items: items.map((e) => ({ ...e, gruppeLabel: ROLLENGRUPPEN[e.gruppe] })) }, 200);
  },
);

// H4: Kennzahl Fluktuation je Firma (Leitungswechsel je Rollengruppe in 24 Monaten,
// mittlere Verweildauer der Leitung, Hinweise fuer Kopf/Uebersicht/Chat).
firmenEreignisseRouter.openapi(
  createRoute({
    method: "get",
    path: "/companies/{id}/fluktuation",
    tags: ["firmen"],
    summary: "Fluktuation der Leitung je Rollengruppe (24 Monate) und Verweildauer",
    request: { params: z.object({ id: z.string().min(1).max(200) }) },
    responses: {
      200: {
        description: "Kennzahl",
        content: {
          "application/json": {
            schema: z.object({
              companyId: z.string(),
              fensterMonate: z.number(),
              beobachtetSeit: z.string().nullable(),
              gruppen: z.array(z.object({ gruppe: z.string(), label: z.string(), zugaenge: z.number(), abgaenge: z.number(), wechsel: z.number() })),
              leitungVerweildauer: z.object({ medianMonate: z.number(), anzahl: z.number() }).nullable(),
              hinweise: z.array(z.string()),
            }),
          },
        },
      },
    },
  }),
  async (c) => {
    const { id } = c.req.valid("param");
    return c.json(await fluktuation(id), 200);
  },
);

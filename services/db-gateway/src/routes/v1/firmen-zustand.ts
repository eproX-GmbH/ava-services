// docs/PLAN_PRICING_TIERS.md P10 — Zustand je Nutzer und Firma: aktiv | ruhend.
// Lesen fuer Werkzeuge und Firmenansicht, Uebersicht fuer Meine Firmen,
// Aktivieren (sofort mit Vorabpruefung oder zum Monatswechsel mit Tausch),
// Ruhen lassen, Vormerkung widerrufen. Ohne PRICING_TIERS=1: alles aktiv.
import { OpenAPIHono, createRoute, z } from "@hono/zod-openapi";
import { HTTPException } from "hono/http-exception";
import { getGatewayPool } from "../../lib/producer-pools";
import { pricingAktiv } from "../../lib/kontingent";
import { zustaende, aktivierungPruefen, aktivieren, ruhendSetzen, vormerkungWiderrufen, uebersicht } from "../../lib/firmen-zustand";
import { ErrorShape } from "./schemas";

export const firmenZustandRouter = new OpenAPIHono();
const tag = "firmen-zustand";

const ZustandShape = z.object({
  companyId: z.string(),
  zustand: z.enum(["aktiv", "ruhend"]),
  seit: z.string().nullable(),
  geplant: z.enum(["aktiv", "ruhend"]).nullable(),
  geplantAb: z.string().nullable(),
  geplantTausch: z.array(z.string()),
}).openapi("FirmenZustand");

const AblehnungShape = z.object({
  code: z.string(),
  fehltCents: z.number().int(),
  passenNoch: z.array(z.string()),
  passenNochAnzahl: z.number().int(),
  naechsterPlan: z.string().nullable(),
  paygMoeglich: z.boolean(),
  kannSelbstWechseln: z.boolean(),
  plan: z.string(),
  kontingentCents: z.number().int().nullable(),
  verbrauchtCents: z.number().int(),
  benoetigtCents: z.number().int(),
  meldung: z.string(),
}).openapi("AktivierungAblehnung");

function actor(c: { get: (k: "auth") => { tenantId: string; actorId: string | null } }): { tenantId: string; actorId: string } {
  const auth = c.get("auth");
  if (!auth.actorId) throw new HTTPException(401, { message: "auth_context_missing" });
  return { tenantId: auth.tenantId, actorId: auth.actorId };
}

// GET /firmen/zustand?companyIds=a,b&pruefen=1
const lesenRoute = createRoute({
  method: "get",
  path: "/firmen/zustand",
  tags: [tag],
  summary: "Zustand (aktiv | ruhend) je Firma fuer den angemeldeten Nutzer; mit pruefen=1 auch, ob eine Aktivierung jetzt passt",
  request: { query: z.object({ companyIds: z.string().min(1).max(20000), pruefen: z.enum(["0", "1"]).optional() }) },
  responses: {
    200: {
      content: { "application/json": { schema: z.object({ aktivModell: z.boolean(), zustaende: z.array(ZustandShape), aktivierung: z.object({ moeglich: z.boolean(), ablehnung: AblehnungShape.nullable() }).nullable() }) } },
      description: "ok",
    },
    401: { content: { "application/json": { schema: ErrorShape } }, description: "unauthenticated" },
  },
});
firmenZustandRouter.openapi(lesenRoute, async (c) => {
  const { tenantId, actorId } = actor(c);
  const { companyIds, pruefen } = c.req.valid("query");
  const ids = [...new Set(companyIds.split(",").map((x) => x.trim()).filter(Boolean))].slice(0, 500);
  const pool = getGatewayPool();
  const z = await zustaende(pool, actorId, ids);
  const zustaendeListe = ids.map((id) => {
    const r = z.get(id);
    return r ?? { companyId: id, zustand: "aktiv" as const, seit: null, geplant: null, geplantAb: null, geplantTausch: [] };
  });
  let aktivierung: { moeglich: boolean; ablehnung: Awaited<ReturnType<typeof aktivierungPruefen>> } | null = null;
  if (pruefen === "1" && pricingAktiv()) {
    const ruhend = zustaendeListe.filter((x) => x.zustand === "ruhend").map((x) => x.companyId);
    const ablehnung = ruhend.length > 0 ? await aktivierungPruefen(pool, { tenantId, actorId, companyIds: ruhend }) : null;
    aktivierung = { moeglich: !ablehnung, ablehnung };
  }
  return c.json({ aktivModell: pricingAktiv(), zustaende: zustaendeListe, aktivierung: aktivierung ? { moeglich: aktivierung.moeglich, ablehnung: aktivierung.ablehnung ? { ...aktivierung.ablehnung, ok: undefined } : null } : null }, 200);
});

// GET /firmen/zustand/uebersicht
const uebersichtRoute = createRoute({
  method: "get",
  path: "/firmen/zustand/uebersicht",
  tags: [tag],
  summary: "Meine Firmen: wie viele aktiv/ruhend, Vormerkungen, Tauschvorschlaege, Free-Aktivierungen",
  responses: {
    200: {
      content: { "application/json": { schema: z.object({
        aktivModell: z.boolean(), gesamt: z.number().int(), aktiv: z.number().int(), ruhend: z.number().int(),
        geplantAktiv: z.array(z.object({ companyId: z.string(), name: z.string().nullable(), ab: z.string(), tausch: z.array(z.string()), wartet: z.boolean() })),
        geplantRuhend: z.array(z.object({ companyId: z.string(), name: z.string().nullable(), ab: z.string() })),
        tauschvorschlaege: z.array(z.object({ companyId: z.string(), name: z.string().nullable(), aktivSeit: z.string().nullable() })),
        free: z.object({ genutzt: z.number().int(), limit: z.number().int() }).nullable(),
        naechsterMonat: z.string(),
      }) } },
      description: "ok",
    },
    401: { content: { "application/json": { schema: ErrorShape } }, description: "unauthenticated" },
  },
});
firmenZustandRouter.openapi(uebersichtRoute, async (c) => {
  const { tenantId, actorId } = actor(c);
  const u = await uebersicht(getGatewayPool(), { tenantId, actorId });
  const { naechsterPeriodKey } = await import("../../lib/firmen-zustand");
  return c.json({ aktivModell: pricingAktiv(), ...u, naechsterMonat: naechsterPeriodKey() }, 200);
});

// PUT /firmen/{companyId}/zustand
const setzenRoute = createRoute({
  method: "put",
  path: "/firmen/{companyId}/zustand",
  tags: [tag],
  summary: "Firma aktivieren (sofort mit Vorabpruefung, 402 wenn das Kontingent nicht reicht; oder zum Monatswechsel mit Tausch) oder ruhen lassen",
  request: {
    params: z.object({ companyId: z.string().min(1) }),
    body: { content: { "application/json": { schema: z.object({
      zustand: z.enum(["aktiv", "ruhend"]),
      ab: z.enum(["sofort", "monatswechsel"]).default("sofort"),
      /** Bei aktiv ab monatswechsel: aktive Firmen, die dafuer ruhen sollen. */
      tausch: z.array(z.string()).max(50).optional(),
      quelle: z.string().max(40).optional(),
    }) } }, required: true },
  },
  responses: {
    200: { content: { "application/json": { schema: z.object({ ok: z.literal(true), zustand: ZustandShape, transactionId: z.string().nullable(), aktiv: z.array(z.string()), ruhend: z.array(z.string()) }) } }, description: "ok" },
    402: { content: { "application/json": { schema: AblehnungShape.extend({ error: z.string() }) } }, description: "Kontingent reicht nicht" },
    401: { content: { "application/json": { schema: ErrorShape } }, description: "unauthenticated" },
  },
});
firmenZustandRouter.openapi(setzenRoute, async (c) => {
  const { tenantId, actorId } = actor(c);
  const { companyId } = c.req.valid("param");
  const body = c.req.valid("json");
  const pool = getGatewayPool();
  const quelle = body.quelle ?? "nutzer";
  if (body.zustand === "ruhend") {
    await ruhendSetzen(pool, { actorId, companyIds: [companyId], quelle, ab: body.ab });
  } else {
    const e = await aktivieren(pool, { tenantId, actorId, companyIds: [companyId], quelle, ab: body.ab, tausch: body.tausch });
    if (!e.ok) {
      const res = new Response(JSON.stringify({ error: e.ablehnung.code, ...e.ablehnung, ok: undefined }), { status: 402, headers: { "content-type": "application/json" } });
      throw new HTTPException(402, { res, message: e.ablehnung.meldung });
    }
    const z = (await zustaende(pool, actorId, [companyId])).get(companyId) ?? { companyId, zustand: "aktiv" as const, seit: null, geplant: null, geplantAb: null, geplantTausch: [] };
    return c.json({ ok: true as const, zustand: z, transactionId: e.transactionId, aktiv: e.aktiv, ruhend: e.ruhend }, 200);
  }
  const z = (await zustaende(pool, actorId, [companyId])).get(companyId) ?? { companyId, zustand: "aktiv" as const, seit: null, geplant: null, geplantAb: null, geplantTausch: [] };
  return c.json({ ok: true as const, zustand: z, transactionId: null, aktiv: [], ruhend: body.ab === "sofort" ? [companyId] : [] }, 200);
});

// DELETE /firmen/{companyId}/zustand/geplant
const widerrufRoute = createRoute({
  method: "delete",
  path: "/firmen/{companyId}/zustand/geplant",
  tags: [tag],
  summary: "Vormerkung (ab Monatswechsel aktiv/ruhend) zuruecknehmen",
  request: { params: z.object({ companyId: z.string().min(1) }) },
  responses: {
    200: { content: { "application/json": { schema: z.object({ ok: z.literal(true) }) } }, description: "ok" },
    401: { content: { "application/json": { schema: ErrorShape } }, description: "unauthenticated" },
  },
});
firmenZustandRouter.openapi(widerrufRoute, async (c) => {
  const { actorId } = actor(c);
  const { companyId } = c.req.valid("param");
  await vormerkungWiderrufen(getGatewayPool(), actorId, companyId);
  return c.json({ ok: true as const }, 200);
});

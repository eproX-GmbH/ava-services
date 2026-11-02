// docs/PLAN_PRICING_TIERS.md P2 — Sitze einer Organisation: Stand, kaufen,
// zuweisen, entziehen, Reduktion vormerken/widerrufen; Plan-Anfrage eines
// Mitglieds; Pay-as-you-go-Freigabe (Ultra). Schreibwege nur Owner/Admin.
import { OpenAPIHono, createRoute, z } from "@hono/zod-openapi";
import { HTTPException } from "hono/http-exception";
import { getGatewayPool } from "../../lib/producer-pools";
import { TenantError } from "../../lib/tenant-error";
import { istAdmin } from "../../lib/tenants";
import { istSitzPlan } from "../../lib/billing-plans";
import { kontingentStand, pricingAktiv } from "../../lib/kontingent";
import { readBillingAccount, periodKeyFor } from "../../lib/billing";
import { recordBillingEvent } from "../../lib/billing-events";
import {
  sitzeStand, sitzeLesen, sitzeKaufen, sitzZuweisen, sitzEntziehen, sitzeReduzieren, reduktionWiderrufen, sitzeStripeSync, sitzVon,
} from "../../lib/sitze";
import { ErrorShape } from "./schemas";
import { istBetreiber } from "../../middleware/auth";
import { sitzeCheckout, sitzeVorschau, stripeKonfiguriert } from "../../lib/sitze-stripe";
import { linkedinStand, linkedinLimitSetzen, linkedinKonto } from "../../lib/linkedin-verbrauch";
import { kundenPreistabelle } from "../../lib/apify-preise";

export const sitzeRouter = new OpenAPIHono();
const tag = "sitze";

function wrap<T>(fn: () => Promise<T>): Promise<T> {
  return fn().catch((err: unknown) => {
    if (err instanceof TenantError) throw new HTTPException(err.status, { message: err.message });
    throw err;
  });
}

async function nurAdmin(tenantId: string, actorId: string): Promise<void> {
  if (!(await istAdmin(getGatewayPool(), tenantId, actorId))) throw new HTTPException(403, { message: "Nur Owner oder Admins der Organisation." });
}

function pruefeSchalter(): void {
  if (!pricingAktiv()) throw new HTTPException(404, { message: "pricing_tiers_inaktiv" });
}

const PlanParam = z.enum(["pro", "max", "ultra"]);
const Any = z.object({}).passthrough();

// GET /tenants/me/sitze — Stand je Plan, Mitglieder mit Plan, Free-Plaetze, Kontingent je Mitglied.
sitzeRouter.openapi(
  createRoute({
    method: "get", path: "/tenants/me/sitze", tags: [tag],
    summary: "Sitze der Organisation: je Plan gekauft/belegt/frei, Mitglieder mit Plan und Kontingentstand, Free-Plaetze.",
    responses: { 200: { content: { "application/json": { schema: Any } }, description: "ok" }, 401: { content: { "application/json": { schema: ErrorShape } }, description: "unauthenticated" } },
  }),
  async (c) => {
    pruefeSchalter();
    const auth = c.get("auth");
    const pool = getGatewayPool();
    const stand = await sitzeStand(pool, auth.tenantId);
    const sitze = await sitzeLesen(pool, auth.tenantId);
    const mitglieder = (await pool.query<{ actorId: string; role: string; email: string | null; name: string | null; status: string }>(
      `SELECT "actorId", "role", "email", "name", "status" FROM "TenantMember" WHERE "tenantId" = $1 ORDER BY "joinedAt"`,
      [auth.tenantId],
    )).rows;
    const admin = await istAdmin(pool, auth.tenantId, auth.actorId);
    const org = await readBillingAccount(pool, auth.tenantId);
    const enterprise = org?.mode === "enterprise";
    const liste = [];
    for (const m of mitglieder) {
      const sitz = sitze.find((s) => s.actorId === m.actorId) ?? null;
      const plan = enterprise ? "enterprise" : sitz?.plan ?? "free";
      const kontingent = admin || m.actorId === auth.actorId ? await kontingentStand(pool, enterprise ? auth.tenantId : m.actorId) : null;
      liste.push({ actorId: m.actorId, role: m.role, email: m.email, name: m.name, status: m.status, plan, sitzId: sitz?.id ?? null, kontingent });
    }
    return c.json({ ...stand, enterprise: enterprise ? { maxMitglieder: org?.maxMitglieder ?? null, firmenLimit: org?.firmenLimit ?? null, linkedinLimitCents: org?.linkedinLimitCents ?? null } : null, mitglieder: liste, kannVerwalten: admin }, 200);
  },
);

// POST /tenants/me/sitze — Sitze kaufen, optional gleich zuweisen.
sitzeRouter.openapi(
  createRoute({
    method: "post", path: "/tenants/me/sitze", tags: [tag],
    summary: "Sitze eines Plans kaufen (sofort, anteilig) und optional einem Mitglied zuweisen.",
    request: { body: { content: { "application/json": { schema: z.object({ plan: PlanParam, anzahl: z.number().int().min(1).max(500).default(1), actorId: z.string().min(1).optional(), rueckkehr: z.enum(["app", "konsole"]).optional() }) } } } },
    responses: { 200: { content: { "application/json": { schema: Any } }, description: "ok" }, 401: { content: { "application/json": { schema: ErrorShape } }, description: "unauthenticated" } },
  }),
  async (c) => {
    pruefeSchalter();
    const auth = c.get("auth");
    await nurAdmin(auth.tenantId, auth.actorId);
    const { plan, anzahl, actorId, rueckkehr } = c.req.valid("json");
    const pool = getGatewayPool();
    // P3 — ohne Stripe-Abo laeuft der erste Kauf ueber Checkout (Zahlungsmittel); nur der
    // Betreiber darf Sitze ohne Stripe anlegen (Enterprise, Tests).
    const org = await readBillingAccount(pool, auth.tenantId);
    if (stripeKonfiguriert() && !org?.stripeSubscriptionId && !istBetreiber(auth) && org?.mode !== "enterprise") {
      const s = await sitzeCheckout(pool, { tenantId: auth.tenantId, actorId: auth.actorId, plan, anzahl, rueckkehr: rueckkehr ?? "app", email: auth.email ?? null });
      return c.json({ ok: true, checkout: s, sitzIds: [], zuweisung: null, stand: await sitzeStand(pool, auth.tenantId) }, 200);
    }
    const client = await pool.connect();
    try {
      await client.query("BEGIN");
      const ids = await wrap(() => sitzeKaufen(client, { tenantId: auth.tenantId, plan, anzahl, von: auth.actorId }));
      let zuweisung: { sitzId: string } | null = null;
      if (actorId) zuweisung = await wrap(() => sitzZuweisen(client, { tenantId: auth.tenantId, actorId, plan, von: auth.actorId }));
      await client.query("COMMIT");
      void sitzeStripeSync(pool, auth.tenantId);
      return c.json({ ok: true, sitzIds: ids, zuweisung, stand: await sitzeStand(pool, auth.tenantId) }, 200);
    } catch (err) {
      await client.query("ROLLBACK").catch(() => undefined);
      throw err;
    } finally {
      client.release();
    }
  },
);

// PUT /tenants/me/mitglieder/{actorId}/sitz — zuweisen / umsetzen / entziehen (plan=free).
sitzeRouter.openapi(
  createRoute({
    method: "put", path: "/tenants/me/mitglieder/{actorId}/sitz", tags: [tag],
    summary: "Mitglied einen Sitz zuweisen oder umsetzen (kaufen=true kauft bei Bedarf einen dazu); plan=free entzieht den Sitz.",
    request: { params: z.object({ actorId: z.string().min(1) }), body: { content: { "application/json": { schema: z.object({ plan: z.enum(["free", "pro", "max", "ultra"]), kaufen: z.boolean().optional() }) } } } },
    responses: { 200: { content: { "application/json": { schema: Any } }, description: "ok" }, 401: { content: { "application/json": { schema: ErrorShape } }, description: "unauthenticated" } },
  }),
  async (c) => {
    pruefeSchalter();
    const auth = c.get("auth");
    await nurAdmin(auth.tenantId, auth.actorId);
    const { actorId } = c.req.valid("param");
    const { plan, kaufen } = c.req.valid("json");
    const pool = getGatewayPool();
    const client = await pool.connect();
    try {
      await client.query("BEGIN");
      let ergebnis: unknown;
      if (plan === "free") ergebnis = await wrap(() => sitzEntziehen(client, { tenantId: auth.tenantId, actorId, von: auth.actorId }));
      else if (istSitzPlan(plan)) ergebnis = await wrap(() => sitzZuweisen(client, { tenantId: auth.tenantId, actorId, plan, von: auth.actorId, kaufen }));
      await client.query("COMMIT");
      void sitzeStripeSync(pool, auth.tenantId);
      return c.json({ ok: true, ergebnis, stand: await sitzeStand(pool, auth.tenantId) }, 200);
    } catch (err) {
      await client.query("ROLLBACK").catch(() => undefined);
      throw err;
    } finally {
      client.release();
    }
  },
);

// PUT /tenants/me/sitze/{plan}/reduzieren — freie Sitze zum Zyklusende abbauen; DELETE widerruft.
sitzeRouter.openapi(
  createRoute({
    method: "put", path: "/tenants/me/sitze/{plan}/reduzieren", tags: [tag],
    summary: "Freie Sitze eines Plans zum Zyklusende reduzieren (vorgemerkt, widerrufbar).",
    request: { params: z.object({ plan: PlanParam }), body: { content: { "application/json": { schema: z.object({ anzahl: z.number().int().min(1).max(500) }) } } } },
    responses: { 200: { content: { "application/json": { schema: Any } }, description: "ok" }, 401: { content: { "application/json": { schema: ErrorShape } }, description: "unauthenticated" } },
  }),
  async (c) => {
    pruefeSchalter();
    const auth = c.get("auth");
    await nurAdmin(auth.tenantId, auth.actorId);
    const { plan } = c.req.valid("param");
    const { anzahl } = c.req.valid("json");
    const pool = getGatewayPool();
    const org = await readBillingAccount(pool, auth.tenantId);
    // Zyklusende: Stripe-Periodenende der Organisation, sonst Monatsersten.
    const zum = org?.periodEnd ?? new Date(Date.UTC(new Date().getUTCFullYear(), new Date().getUTCMonth() + 1, 1));
    const client = await pool.connect();
    try {
      await client.query("BEGIN");
      const n = await wrap(() => sitzeReduzieren(client, { tenantId: auth.tenantId, plan, anzahl, zum, von: auth.actorId }));
      await client.query("COMMIT");
      void sitzeStripeSync(pool, auth.tenantId, { proration: "none" });
      return c.json({ ok: true, vorgemerkt: n, zum: zum.toISOString(), stand: await sitzeStand(pool, auth.tenantId) }, 200);
    } catch (err) {
      await client.query("ROLLBACK").catch(() => undefined);
      throw err;
    } finally {
      client.release();
    }
  },
);
sitzeRouter.openapi(
  createRoute({
    method: "delete", path: "/tenants/me/sitze/{plan}/reduzieren", tags: [tag],
    summary: "Vorgemerkte Reduktion eines Plans widerrufen.",
    request: { params: z.object({ plan: PlanParam }) },
    responses: { 200: { content: { "application/json": { schema: Any } }, description: "ok" }, 401: { content: { "application/json": { schema: ErrorShape } }, description: "unauthenticated" } },
  }),
  async (c) => {
    pruefeSchalter();
    const auth = c.get("auth");
    await nurAdmin(auth.tenantId, auth.actorId);
    const { plan } = c.req.valid("param");
    const pool = getGatewayPool();
    const client = await pool.connect();
    try {
      await client.query("BEGIN");
      const n = await reduktionWiderrufen(client, { tenantId: auth.tenantId, plan, von: auth.actorId });
      await client.query("COMMIT");
      void sitzeStripeSync(pool, auth.tenantId, { proration: "none" });
      return c.json({ ok: true, widerrufen: n, stand: await sitzeStand(pool, auth.tenantId) }, 200);
    } catch (err) {
      await client.query("ROLLBACK").catch(() => undefined);
      throw err;
    } finally {
      client.release();
    }
  },
);

// POST /billing/plan-anfrage — Mitglied bittet um einen (groesseren) Sitz; Meldung an Owner/Admin.
sitzeRouter.openapi(
  createRoute({
    method: "post", path: "/billing/plan-anfrage", tags: [tag],
    summary: "Mitglied fragt bei Owner/Admin einen Plan an (wird als Abrechnungsereignis festgehalten; Meldung folgt).",
    request: { body: { content: { "application/json": { schema: z.object({ plan: PlanParam, grund: z.string().max(500).optional() }) } } } },
    responses: { 200: { content: { "application/json": { schema: Any } }, description: "ok" }, 401: { content: { "application/json": { schema: ErrorShape } }, description: "unauthenticated" } },
  }),
  async (c) => {
    pruefeSchalter();
    const auth = c.get("auth");
    const { plan, grund } = c.req.valid("json");
    const pool = getGatewayPool();
    const aktuell = await sitzVon(pool, auth.actorId);
    await recordBillingEvent(pool, { billingAccountId: auth.tenantId, kind: "plan_anfrage", source: "admin", actorId: auth.actorId, payload: { plan, grund: grund ?? null, aktuell: aktuell?.plan ?? "free" } });
    return c.json({ ok: true }, 200);
  },
);

// PUT /usage/payg — Pay-as-you-go ueber das Kontingent hinaus fuer den laufenden Monat freigeben (nur Ultra, nur Owner/Admin).
sitzeRouter.openapi(
  createRoute({
    method: "put", path: "/usage/payg", tags: [tag],
    summary: "Ultra: Aufnahmen ueber das Kontingent hinaus fuer den laufenden Monat freigeben oder zuruecknehmen, optional mit Deckel in Cent.",
    request: { body: { content: { "application/json": { schema: z.object({ actorId: z.string().min(1).optional(), freigeben: z.boolean(), limitCents: z.number().int().min(0).nullable().optional() }) } } } },
    responses: { 200: { content: { "application/json": { schema: Any } }, description: "ok" }, 401: { content: { "application/json": { schema: ErrorShape } }, description: "unauthenticated" } },
  }),
  async (c) => {
    pruefeSchalter();
    const auth = c.get("auth");
    const { actorId: ziel, freigeben, limitCents } = c.req.valid("json");
    const actorId = ziel ?? auth.actorId;
    const pool = getGatewayPool();
    if (actorId !== auth.actorId || auth.actorId !== auth.tenantId) await nurAdmin(auth.tenantId, auth.actorId);
    const sitz = await sitzVon(pool, actorId);
    if (sitz?.plan !== "ultra") throw new HTTPException(409, { message: "Über das Kontingent hinaus geht nur mit einem Ultra-Sitz." });
    const periode = periodKeyFor("ultra");
    await pool.query(
      `UPDATE "TenantBilling" SET "paygFreigabePeriode" = $2, "paygLimitCents" = COALESCE($3, "paygLimitCents"), "updatedAt" = NOW() WHERE "tenantId" = $1`,
      [actorId, freigeben ? periode : null, limitCents === undefined ? null : limitCents],
    );
    await recordBillingEvent(pool, { billingAccountId: auth.tenantId, kind: freigeben ? "payg_freigegeben" : "payg_zurueckgenommen", source: "admin", actorId: auth.actorId, payload: { memberId: actorId, periode, limitCents: limitCents ?? null } });
    return c.json({ ok: true, kontingent: await kontingentStand(pool, actorId) }, 200);
  },
);

// GET /billing/sitze/vorschau — was kostet es heute, Sitze dazuzunehmen (anteilig bis Zyklusende)?
sitzeRouter.openapi(
  createRoute({
    method: "get", path: "/billing/sitze/vorschau", tags: [tag],
    summary: "Vorschau: heutiger anteiliger Betrag und Monatspreis fuer zusaetzliche Sitze eines Plans.",
    request: { query: z.object({ plan: PlanParam, anzahl: z.coerce.number().int().min(1).max(500).default(1) }) },
    responses: { 200: { content: { "application/json": { schema: Any } }, description: "ok" }, 401: { content: { "application/json": { schema: ErrorShape } }, description: "unauthenticated" } },
  }),
  async (c) => {
    pruefeSchalter();
    const auth = c.get("auth");
    const { plan, anzahl } = c.req.valid("query");
    return c.json(await sitzeVorschau(getGatewayPool(), { tenantId: auth.tenantId, plan, anzahl }), 200);
  },
);

// GET /usage/linkedin — Verbrauch der LinkedIn-Beobachtung im Monat, Limit, Preistabelle.
sitzeRouter.openapi(
  createRoute({
    method: "get", path: "/usage/linkedin", tags: [tag],
    summary: "LinkedIn-Beobachtung nach Verbrauch: Monatsverbrauch je Funktion, Limit, Kundenpreise je 1.000.",
    request: { query: z.object({ actorId: z.string().min(1).optional() }) },
    responses: { 200: { content: { "application/json": { schema: Any } }, description: "ok" }, 401: { content: { "application/json": { schema: ErrorShape } }, description: "unauthenticated" } },
  }),
  async (c) => {
    pruefeSchalter();
    const auth = c.get("auth");
    const { actorId: ziel } = c.req.valid("query");
    const actorId = ziel ?? auth.actorId;
    if (actorId !== auth.actorId) await nurAdmin(auth.tenantId, auth.actorId);
    const stand = await linkedinStand(getGatewayPool(), auth.tenantId, actorId);
    return c.json({ ...stand, preise: kundenPreistabelle().filter((p) => p.beobachtung) }, 200);
  },
);

// PUT /usage/linkedin-limit — Monatslimit (Cent) fuer die LinkedIn-Beobachtung; Owner/Admin fuer sich und Mitglieder.
sitzeRouter.openapi(
  createRoute({
    method: "put", path: "/usage/linkedin-limit", tags: [tag],
    summary: "Monatslimit der LinkedIn-Beobachtung setzen (null = kein Limit, dann laeuft nichts).",
    request: { body: { content: { "application/json": { schema: z.object({ actorId: z.string().min(1).optional(), limitCents: z.number().int().min(0).max(1_000_000).nullable() }) } } } },
    responses: { 200: { content: { "application/json": { schema: Any } }, description: "ok" }, 401: { content: { "application/json": { schema: ErrorShape } }, description: "unauthenticated" } },
  }),
  async (c) => {
    pruefeSchalter();
    const auth = c.get("auth");
    const { actorId: ziel, limitCents } = c.req.valid("json");
    const actorId = ziel ?? auth.actorId;
    const pool = getGatewayPool();
    // Kosten landen auf dem Zahlungsmittel der Organisation: nur Owner/Admin (persoenliches Konto: selbst).
    if (auth.tenantId !== auth.actorId) await nurAdmin(auth.tenantId, auth.actorId);
    const konto = await linkedinKonto(pool, auth.tenantId, actorId);
    if (konto.enterprise) throw new HTTPException(409, { message: "Bei Enterprise setzt AVA das Limit laut Vertrag." });
    await linkedinLimitSetzen(pool, { kontoId: konto.kontoId, limitCents, von: auth.actorId, tenantId: auth.tenantId });
    return c.json({ ok: true, stand: await linkedinStand(pool, auth.tenantId, actorId) }, 200);
  },
);

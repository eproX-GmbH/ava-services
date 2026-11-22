// AVA-Server für Nutzer und Admins (docs/PLAN_CLOUD_SELBSTBEDIENUNG.md Z3).
//   GET  /cloud/mein                              eigener Server (App, Desktop)
//   GET  /tenants/me/cloud                        Admin: Server je Mitglied (Konsole)
//   PUT  /tenants/me/mitglieder/{actorId}/cloud   Admin bzw. Einzelkämpfer: an/aus
//   POST /cloud/kaufen                            Einzelkämpfer ohne Abo: Checkout Pro + Server
// Buchen ist erst offen mit CLOUD_SELBSTBEDIENUNG=1 (Betreiber darf vorher testen).

import { OpenAPIHono, createRoute, z } from "@hono/zod-openapi";
import { HTTPException } from "hono/http-exception";
import { getGatewayPool } from "../../lib/producer-pools";
import { loadEnv } from "../../lib/env";
import { istAdmin } from "../../lib/tenants";
import { istBetreiber, type AuthContext } from "../../middleware/auth";
import { cloudBetrieb } from "../../lib/cloud/betrieb";
import { regelnAusEnv } from "../../lib/cloud/abgleich";
import { CloudAbrechnungFehler, cloudAbbestellen, cloudCheckout, cloudEinschalten } from "../../lib/cloud/abrechnung";
import type { CloudInstanz } from "../../lib/cloud/instanzen";
import { ErrorShape } from "./schemas";

export const cloudRouter = new OpenAPIHono();
const Antwort = z.object({}).passthrough();
const Fehler = { 403: { content: { "application/json": { schema: ErrorShape } }, description: "nicht erlaubt" }, 409: { content: { "application/json": { schema: ErrorShape } }, description: "nicht möglich" } };

const offen = (auth: AuthContext) => process.env.CLOUD_SELBSTBEDIENUNG === "1" || istBetreiber(auth);

/** Was App und Konsole anzeigen: nur nutzerrelevante Felder, keine Fly-Kennungen. */
export function nutzerSicht(i: CloudInstanz) {
  const r = regelnAusEnv();
  const loeschenAb = i.gestopptAt ? new Date(Date.parse(i.gestopptAt) + r.loeschTage * 86_400_000).toISOString() : null;
  return {
    zustand: i.zustand,
    laeuftSoll: i.soll === "laufen",
    grund: i.grund,
    verbunden: !!i.verbundenAt,
    gesundAt: i.gesundAt,
    abbestelltZum: i.abbestelltZum,
    gestopptAt: i.gestopptAt,
    loeschenAb,
    seit: i.createdAt,
  };
}

function fehler(err: unknown): never {
  if (err instanceof CloudAbrechnungFehler) throw new HTTPException(409, { message: err.message, cause: err.code, res: new Response(JSON.stringify({ error: err.code, message: err.message }), { status: 409, headers: { "content-type": "application/json" } }) });
  throw err;
}

async function instanzVon(tenantId: string, actorId: string) {
  const r = await getGatewayPool().query<{ id: string }>(`SELECT id FROM "CloudInstanz" WHERE "tenantId" = $1 AND "actorId" = $2 AND "geloeschtAt" IS NULL`, [tenantId, actorId]);
  return r.rows[0] ? await cloudBetrieb().stand(r.rows[0].id).catch(() => null) : null;
}

cloudRouter.openapi(
  createRoute({ method: "get", path: "/cloud/mein", tags: ["cloud"], summary: "Eigener AVA-Server (oder null)", responses: { 200: { content: { "application/json": { schema: Antwort } }, description: "Stand" } } }),
  async (c) => {
    const auth = c.get("auth");
    const i = await instanzVon(auth.tenantId, auth.actorId);
    return c.json({ server: i ? nutzerSicht(i) : null, buchbar: offen(auth) }, 200);
  },
);

cloudRouter.openapi(
  createRoute({ method: "get", path: "/tenants/me/cloud", tags: ["cloud"], summary: "Admin: AVA-Server je Mitglied", responses: { 200: { content: { "application/json": { schema: Antwort } }, description: "Liste" }, ...Fehler } }),
  async (c) => {
    const auth = c.get("auth");
    if (!(await istAdmin(getGatewayPool(), auth.tenantId, auth.actorId))) throw new HTTPException(403, { message: "nur Owner/Admin" });
    const r = await getGatewayPool().query<{ id: string; actorId: string }>(`SELECT id, "actorId" FROM "CloudInstanz" WHERE "tenantId" = $1 AND "geloeschtAt" IS NULL`, [auth.tenantId]);
    const server = await Promise.all(r.rows.map(async (x) => ({ actorId: x.actorId, ...nutzerSicht((await cloudBetrieb().stand(x.id)) as CloudInstanz) })));
    return c.json({ server, buchbar: offen(auth) }, 200);
  },
);

cloudRouter.openapi(
  createRoute({
    method: "put",
    path: "/tenants/me/mitglieder/{actorId}/cloud",
    tags: ["cloud"],
    summary: "AVA-Server für ein Mitglied buchen (an) oder zum Zyklusende abbestellen (aus)",
    request: { params: z.object({ actorId: z.string().min(1).max(80) }), body: { content: { "application/json": { schema: z.object({ an: z.boolean() }) } } } },
    responses: { 200: { content: { "application/json": { schema: Antwort } }, description: "Stand" }, ...Fehler },
  }),
  async (c) => {
    const auth = c.get("auth");
    const { actorId } = c.req.valid("param");
    const { an } = c.req.valid("json");
    const pool = getGatewayPool();
    if (!(await istAdmin(pool, auth.tenantId, auth.actorId))) throw new HTTPException(403, { message: "Nur Owner oder Admin können den Server buchen." });
    if (an && !offen(auth)) throw new HTTPException(403, { message: "Der AVA-Server ist noch nicht buchbar." });
    try {
      if (an) {
        const i = await cloudEinschalten(pool, cloudBetrieb(), { tenantId: auth.tenantId, actorId, von: auth.actorId });
        return c.json({ server: nutzerSicht(i) }, 200);
      }
      const { bis } = await cloudAbbestellen(pool, { tenantId: auth.tenantId, actorId, von: auth.actorId });
      return c.json({ abbestelltZum: bis }, 200);
    } catch (err) {
      fehler(err);
    }
  },
);

cloudRouter.openapi(
  createRoute({
    method: "post",
    path: "/cloud/kaufen",
    tags: ["cloud"],
    summary: "Einzelkämpfer ohne Abo: Kauf von Pro-Sitz und AVA-Server (Stripe-Checkout)",
    responses: { 200: { content: { "application/json": { schema: z.object({ url: z.string() }) } }, description: "Checkout" }, ...Fehler },
  }),
  async (c) => {
    const auth = c.get("auth");
    if (!offen(auth)) throw new HTTPException(403, { message: "Der AVA-Server ist noch nicht buchbar." });
    const pool = getGatewayPool();
    if (!(await istAdmin(pool, auth.tenantId, auth.actorId))) throw new HTTPException(403, { message: "Bitte frag den Owner deiner Organisation." });
    try {
      const { url } = await cloudCheckout(pool, { tenantId: auth.tenantId, actorId: auth.actorId, email: auth.email ?? null, appUrl: loadEnv().AVA_APP_URL });
      return c.json({ url }, 200);
    } catch (err) {
      fehler(err);
    }
  },
);

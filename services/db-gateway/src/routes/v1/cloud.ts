// AVA-Server für Nutzer und Admins (docs/PLAN_CLOUD_SELBSTBEDIENUNG.md Z3).
//   GET  /cloud/mein                              eigener Server (App, Desktop); wartet er auf die
//                                                 Bestätigung, mit Ein-Klick-Link (Z4)
//   GET  /tenants/me/cloud                        Admin: Server je Mitglied (Konsole)
//   PUT  /tenants/me/mitglieder/{actorId}/cloud   Admin bzw. Einzelkämpfer: an/aus
//   POST /cloud/kaufen                            Einzelkämpfer ohne Abo: Checkout Pro + Server
//   POST /cloud/anfragen                          Mitglied ohne Admin-Rechte: Mail an Owner/Admins (Z5)
// Buchen ist erst offen mit CLOUD_SELBSTBEDIENUNG=1 (Betreiber darf vorher testen).

import { OpenAPIHono, createRoute, z } from "@hono/zod-openapi";
import { HTTPException } from "hono/http-exception";
import { getGatewayPool } from "../../lib/producer-pools";
import { loadEnv } from "../../lib/env";
import { istAdmin } from "../../lib/tenants";
import { istBetreiber, type AuthContext } from "../../middleware/auth";
import { cloudBestaetigung, cloudBetrieb } from "../../lib/cloud/betrieb";
import { loeschDatum, regelnAusEnv } from "../../lib/cloud/abgleich";
import { CloudAbrechnungFehler, cloudAbbestellen, cloudCheckout, cloudEinschalten, cloudPreise, cloudWeg } from "../../lib/cloud/abrechnung";
import type { CloudInstanz } from "../../lib/cloud/instanzen";
import { kopfRelais } from "../../lib/kopf-relais";
import { planEintrag } from "../../lib/billing-plans";
import { mailKonto, mailSenden } from "../../lib/mail/versand";
import { serverAnfrageMail } from "../../lib/mail/vorlagen";
import { recordBillingEvent } from "../../lib/billing-events";
import { logger } from "../../lib/logger";
import { ErrorShape } from "./schemas";

export const cloudRouter = new OpenAPIHono();
const Antwort = z.object({}).passthrough();
const Fehler = { 403: { content: { "application/json": { schema: ErrorShape } }, description: "nicht erlaubt" }, 409: { content: { "application/json": { schema: ErrorShape } }, description: "nicht möglich" } };

const offen = (auth: AuthContext) => process.env.CLOUD_SELBSTBEDIENUNG === "1" || istBetreiber(auth);

const MIN = 60_000;

/** Was App und Konsole anzeigen: nur nutzerrelevante Felder, keine Fly-Kennungen. */
export function nutzerSicht(i: CloudInstanz & { fly?: { state: string } | null }) {
  const loeschenAb = loeschDatum(i, regelnAusEnv());
  // Störung erst nach 10 Minuten (wie Mail M4), solange der Server laufen soll.
  const ungesund = typeof i.schritte.ungesundSeit === "string" ? i.schritte.ungesundSeit : null;
  const m4 = typeof i.schritte.m4Offen === "string" ? i.schritte.m4Offen : null;
  const stoerungSeit = i.soll === "laufen" && (m4 ?? (ungesund && Date.now() - Date.parse(ungesund) >= 10 * MIN ? ungesund : null)) && !i.schritte.wiederSeit ? (m4 ?? ungesund) : null;
  return {
    stoerungSeit,
    wirdAktualisiert: i.fly?.state === "replacing" || i.fly?.state === "updating",
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
    let i = await instanzVon(auth.tenantId, auth.actorId);
    // Wartet sie auf die Bestätigung: aktuellen Ein-Klick-Link holen (oder gleich als verbunden vermerken).
    let bestaetigen: { link: string; bis: string | null } | null = null;
    if (i?.zustand === "wartet_auf_verbindung") {
      const b = await cloudBestaetigung(i).catch(() => ({ angemeldet: false, bestaetigen: null }));
      if (b.angemeldet) i = await instanzVon(auth.tenantId, auth.actorId);
      bestaetigen = b.bestaetigen;
    }
    // Modell gewählt? Meldet die Server-AVA selbst übers Relais (Ollama dient dort nur den Embeddings).
    const kopf = i ? kopfRelais.instanzen(auth.actorId).find((x) => x.verbunden && x.flyApp === i!.flyApp) : null;
    const modell = typeof kopf?.zustand?.modell === "string" ? kopf.zustand.modell : null;
    const pool = getGatewayPool();
    const admin = await istAdmin(pool, auth.tenantId, auth.actorId);
    const buchbar = offen(auth);
    return c.json({
      // kopfId: Relais-Kennung der Server-AVA (für App-Anfragen an genau diese, z. B. „Modell wählen“).
      server: i ? { ...nutzerSicht(i), bestaetigen, modellGewaehlt: kopf ? modell !== null && modell !== "ollama" : null, kopfId: kopf?.id ?? null } : null,
      buchbar,
      admin,
      weg: buchbar ? await cloudWeg(pool, auth.tenantId, admin) : null,
      preis: cloudPreise(planEintrag("pro").preisCents ?? 4900),
    }, 200);
  },
);

cloudRouter.openapi(
  createRoute({ method: "get", path: "/tenants/me/cloud", tags: ["cloud"], summary: "Admin: AVA-Server je Mitglied", responses: { 200: { content: { "application/json": { schema: Antwort } }, description: "Liste" }, ...Fehler } }),
  async (c) => {
    const auth = c.get("auth");
    if (!(await istAdmin(getGatewayPool(), auth.tenantId, auth.actorId))) throw new HTTPException(403, { message: "nur Owner/Admin" });
    const r = await getGatewayPool().query<{ id: string; actorId: string }>(`SELECT id, "actorId" FROM "CloudInstanz" WHERE "tenantId" = $1 AND "geloeschtAt" IS NULL`, [auth.tenantId]);
    const server = await Promise.all(r.rows.map(async (x) => ({ actorId: x.actorId, ...nutzerSicht((await cloudBetrieb().stand(x.id)) as CloudInstanz) })));
    return c.json({ server, buchbar: offen(auth), preis: cloudPreise(planEintrag("pro").preisCents ?? 4900) }, 200);
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

cloudRouter.openapi(
  createRoute({
    method: "post",
    path: "/cloud/anfragen",
    tags: ["cloud"],
    summary: "Mitglied fragt bei Owner/Admins einen AVA-Server an (höchstens einmal am Tag)",
    responses: { 200: { content: { "application/json": { schema: z.object({ gesendet: z.number(), schonAngefragt: z.boolean() }) } }, description: "Anfrage" }, ...Fehler },
  }),
  async (c) => {
    const auth = c.get("auth");
    if (!offen(auth)) throw new HTTPException(403, { message: "Der AVA-Server ist noch nicht buchbar." });
    const pool = getGatewayPool();
    const schon = await pool.query(`SELECT 1 FROM "BillingEvent" WHERE "billingAccountId" = $1 AND kind = 'cloud_angefragt' AND "actorId" = $2 AND ts > now() - interval '24 hours' LIMIT 1`, [auth.tenantId, auth.actorId]);
    if (schon.rowCount) return c.json({ gesendet: 0, schonAngefragt: true }, 200);
    const t = await pool.query<{ name: string | null }>(`SELECT name FROM "Tenant" WHERE id = $1`, [auth.tenantId]);
    const ich = await pool.query<{ name: string | null; email: string | null }>(`SELECT name, email FROM "TenantMember" WHERE "tenantId" = $1 AND "actorId" = $2`, [auth.tenantId, auth.actorId]);
    const admins = await pool.query<{ actorId: string; email: string | null; name: string | null }>(
      `SELECT "actorId", email, name FROM "TenantMember" WHERE "tenantId" = $1 AND status = 'aktiv' AND role IN ('owner', 'admin') AND "actorId" <> $2`, [auth.tenantId, auth.actorId],
    );
    const konsole = (process.env.ADMIN_KONSOLE_URL ?? "https://admin.ava.bi").replace(/\/+$/, "");
    const wer = ich.rows[0]?.name?.trim() || ich.rows[0]?.email || auth.email || "Ein Mitglied";
    let gesendet = 0;
    for (const a of admins.rows.filter((x) => x.email)) {
      const vorname = a.name?.split(/\s+/)[0] ?? null;
      const mail = serverAnfrageMail({ vorname, wer, email: ich.rows[0]?.email ?? auth.email ?? null, organisation: t.rows[0]?.name ?? "eure Organisation", konsoleUrl: `${konsole}/mitglieder` });
      const r = await mailSenden(pool, await mailKonto(pool, { actorId: a.actorId, email: a.email!, vorname }), "server_anfrage", mail).catch((err) => {
        logger.warn({ err: err instanceof Error ? err.message : String(err) }, "[cloud] Anfrage-Mail fehlgeschlagen");
        return { ok: false };
      });
      if (r.ok) gesendet++;
    }
    await recordBillingEvent(pool, { billingAccountId: auth.tenantId, kind: "cloud_angefragt", source: "admin", actorId: auth.actorId, payload: { gesendet } });
    return c.json({ gesendet, schonAngefragt: false }, 200);
  },
);

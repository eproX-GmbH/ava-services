// Betreiber: Kunden-Instanzen von Hand anlegen, stoppen, starten, ruhen lassen, löschen
// (docs/PLAN_CLOUD_SELBSTBEDIENUNG.md Z1). Nur Betreiber (sonst 404). Ab Z2/Z3 steuern
// Abgleicher und Abrechnung dieselben Abläufe; diese Routen bleiben als Werkzeug.

import { OpenAPIHono, createRoute, z } from "@hono/zod-openapi";
import { HTTPException } from "hono/http-exception";
import { getGatewayPool } from "../../lib/producer-pools";
import { logger } from "../../lib/logger";
import { istBetreiber } from "../../middleware/auth";
import { flyKunden, flyKundenEingerichtet } from "../../lib/cloud/fly-maschinen";
import { CloudBetrieb, pgRepo } from "../../lib/cloud/instanzen";
import { ErrorShape } from "./schemas";

export const betreiberCloudRouter = new OpenAPIHono();

let betrieb: CloudBetrieb | null = null;
/** Ein Betrieb je Gateway-Prozess (die Sperre je Instanz lebt darin). */
export function cloudBetrieb(): CloudBetrieb {
  betrieb ??= new CloudBetrieb(pgRepo(getGatewayPool()), flyKunden);
  return betrieb;
}

const Antwort = z.object({}).passthrough();
const fehler404 = { 404: { content: { "application/json": { schema: ErrorShape } }, description: "kein Betreiber / nicht gefunden" } };

function nurBetreiber(c: { get: (k: "auth") => unknown }) {
  if (!istBetreiber(c.get("auth") as Parameters<typeof istBetreiber>[0])) throw new HTTPException(404, { message: "not_found" });
  if (!flyKundenEingerichtet()) throw new HTTPException(503, { message: "Cloud-Betrieb nicht eingerichtet (FLY_KUNDEN_TOKEN fehlt)." });
}

const meldung = (err: unknown) => (err instanceof Error ? err.message : String(err));

betreiberCloudRouter.openapi(
  createRoute({
    method: "get",
    path: "/betreiber/cloud/instanzen",
    tags: ["betreiber"],
    summary: "Betreiber: alle Kunden-Instanzen (Datensatz; mit live=1 zusätzlich Fly-Zustand)",
    request: { query: z.object({ live: z.enum(["0", "1"]).default("0") }) },
    responses: { 200: { content: { "application/json": { schema: Antwort } }, description: "Liste" }, ...fehler404 },
  }),
  async (c) => {
    nurBetreiber(c);
    const b = cloudBetrieb();
    const liste = await pgRepo(getGatewayPool()).liste();
    const instanzen = c.req.valid("query").live === "1"
      ? await Promise.all(liste.map((i) => b.stand(i.id).catch(() => ({ ...i, fly: null }))))
      : liste;
    return c.json({ instanzen }, 200);
  },
);

betreiberCloudRouter.openapi(
  createRoute({
    method: "post",
    path: "/betreiber/cloud/instanzen",
    tags: ["betreiber"],
    summary: "Betreiber: Instanz für ein Mitglied anlegen (läuft im Hintergrund weiter)",
    request: {
      body: { content: { "application/json": { schema: z.object({
        actorId: z.string().min(1).max(80),
        tenantId: z.string().min(1).max(80).optional(),
        groesse: z.enum(["standard", "gross"]).default("standard"),
      }) } } },
    },
    responses: {
      202: { content: { "application/json": { schema: Antwort } }, description: "angelegt bzw. vorhanden" },
      409: { content: { "application/json": { schema: ErrorShape } }, description: "kein eindeutiges Mitglied" },
      ...fehler404,
    },
  }),
  async (c) => {
    nurBetreiber(c);
    const { actorId, groesse } = c.req.valid("json");
    let { tenantId } = c.req.valid("json");
    if (!tenantId) {
      const r = await getGatewayPool().query<{ tenantId: string }>(`SELECT "tenantId" FROM "TenantMember" WHERE "actorId" = $1 AND status = 'aktiv'`, [actorId]);
      if (r.rows.length !== 1) throw new HTTPException(409, { message: `Mitglied in ${r.rows.length} Organisationen; tenantId angeben.` });
      tenantId = r.rows[0]!.tenantId;
    }
    const b = cloudBetrieb();
    const z0 = await b.anlegen({ tenantId, actorId, groesse, quelle: "betreiber" });
    if (z0.zustand === "wird_angelegt" && !b.beschaeftigt(z0.id)) {
      void b.fortsetzen(z0.id, "betreiber").catch((err) => logger.warn({ id: z0.id, err: meldung(err) }, "[cloud] Anlegen abgebrochen"));
    }
    return c.json({ instanz: z0 }, 202);
  },
);

betreiberCloudRouter.openapi(
  createRoute({
    method: "get",
    path: "/betreiber/cloud/instanzen/{id}",
    tags: ["betreiber"],
    summary: "Betreiber: eine Instanz mit Fly-Zustand und letzten Ereignissen",
    request: { params: z.object({ id: z.string().min(1).max(80) }) },
    responses: { 200: { content: { "application/json": { schema: Antwort } }, description: "Instanz" }, ...fehler404 },
  }),
  async (c) => {
    nurBetreiber(c);
    const { id } = c.req.valid("param");
    try {
      const stand = await cloudBetrieb().stand(id);
      const ereignisse = await pgRepo(getGatewayPool()).ereignisse(id, 30);
      return c.json({ instanz: stand, ereignisse }, 200);
    } catch (err) {
      throw new HTTPException(404, { message: meldung(err) });
    }
  },
);

betreiberCloudRouter.openapi(
  createRoute({
    method: "post",
    path: "/betreiber/cloud/instanzen/{id}/aktion",
    tags: ["betreiber"],
    summary: "Betreiber: fortsetzen | stoppen | starten | ruhen | loeschen (loeschen braucht bestaetigen=true)",
    request: {
      params: z.object({ id: z.string().min(1).max(80) }),
      body: { content: { "application/json": { schema: z.object({
        aktion: z.enum(["fortsetzen", "stoppen", "starten", "ruhen", "loeschen"]),
        bestaetigen: z.boolean().optional(),
      }) } } },
    },
    responses: {
      200: { content: { "application/json": { schema: Antwort } }, description: "neuer Stand" },
      409: { content: { "application/json": { schema: ErrorShape } }, description: "nicht möglich" },
      ...fehler404,
    },
  }),
  async (c) => {
    nurBetreiber(c);
    const { id } = c.req.valid("param");
    const { aktion, bestaetigen } = c.req.valid("json");
    const b = cloudBetrieb();
    try {
      let instanz;
      if (aktion === "fortsetzen") instanz = await b.fortsetzen(id, "betreiber");
      else if (aktion === "stoppen") instanz = await b.stoppen(id, "betreiber", "betreiber");
      else if (aktion === "starten") instanz = await b.starten(id, "betreiber");
      else if (aktion === "ruhen") instanz = await b.ruhen(id, "betreiber");
      else {
        if (bestaetigen !== true) throw new Error("Löschen braucht bestaetigen=true.");
        instanz = await b.loeschen(id, "betreiber");
      }
      logger.info({ id, aktion }, "[cloud] Betreiber-Aktion");
      return c.json({ instanz }, 200);
    } catch (err) {
      throw new HTTPException(409, { message: meldung(err) });
    }
  },
);

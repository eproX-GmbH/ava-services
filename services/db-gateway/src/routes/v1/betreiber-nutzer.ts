// Betreiber: aktive Nutzer (Joyce 2026-11-06) — wer hat zuletzt mit AVA
// gearbeitet, auf welchem Geraet, mit welcher Version. Nur Betreiber (sonst 404).

import { OpenAPIHono, createRoute, z } from "@hono/zod-openapi";
import { HTTPException } from "hono/http-exception";
import { getGatewayPool } from "../../lib/producer-pools";
import { aktiveNutzerListe, vermerkeNutzung } from "../../lib/nutzer-aktivitaet";
import { sperrenNeuLaden } from "../../lib/konto-loeschen";
import { kontoInKeycloakSperren } from "../../lib/keycloak-admin";
import { logger } from "../../lib/logger";
import { kopfRelais } from "../../lib/kopf-relais";
import { istBetreiber } from "../../middleware/auth";
import { ErrorShape } from "./schemas";

export const betreiberNutzerRouter = new OpenAPIHono();

betreiberNutzerRouter.openapi(
  createRoute({
    method: "get",
    path: "/betreiber/nutzer/aktiv",
    tags: ["betreiber"],
    summary: "Betreiber: Nutzer nach letzter Nutzung (aktiv = Handlung eines Menschen in den letzten 15 Minuten, online = irgendeine Anfrage)",
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

// Sperre durch das AVA-Team (2026-11-11): aufhebbar, anders als Loeschen/Deaktivieren.
// Gateway weist ab sofort jede Anfrage ab (konto_gesperrt), Keycloak schaltet die
// Anmeldung aus und beendet die Sitzungen → die App meldet sich beim naechsten
// Token-Abgleich selbst ab. Entsperren hebt nur 'gesperrt' auf, nie eine Loeschung.
betreiberNutzerRouter.openapi(
  createRoute({
    method: "put",
    path: "/betreiber/nutzer/{actorId}/sperre",
    tags: ["betreiber"],
    summary: "Betreiber: Nutzer sperren oder entsperren",
    request: {
      params: z.object({ actorId: z.string().min(1).max(80) }),
      body: { content: { "application/json": { schema: z.object({ gesperrt: z.boolean() }) } } },
    },
    responses: {
      200: { content: { "application/json": { schema: z.object({ ok: z.boolean(), gesperrt: z.boolean(), keycloak: z.boolean(), fehler: z.string().nullable() }) } }, description: "Stand" },
      404: { content: { "application/json": { schema: ErrorShape } }, description: "kein Betreiber" },
      409: { content: { "application/json": { schema: ErrorShape } }, description: "nicht moeglich" },
    },
  }),
  async (c) => {
    const auth = c.get("auth");
    if (!istBetreiber(auth)) throw new HTTPException(404, { message: "not_found" });
    const { actorId } = c.req.valid("param");
    const { gesperrt } = c.req.valid("json");
    if (actorId === auth.actorId) throw new HTTPException(409, { message: "Du kannst dich nicht selbst sperren." });
    const pool = getGatewayPool();
    const vorher = await pool.query<{ art: string }>(`SELECT art FROM "KontoStatus" WHERE "actorId" = $1`, [actorId]);
    const art = vorher.rows[0]?.art ?? null;
    if (art && art !== "gesperrt") throw new HTTPException(409, { message: "Dieses Konto ist gelöscht oder deaktiviert; das lässt sich hier nicht ändern." });
    if (gesperrt) {
      await pool.query(`INSERT INTO "KontoStatus" ("actorId", art, von) VALUES ($1, 'gesperrt', $2) ON CONFLICT ("actorId") DO NOTHING`, [actorId, auth.actorId]);
    } else {
      await pool.query(`DELETE FROM "KontoStatus" WHERE "actorId" = $1 AND art = 'gesperrt'`, [actorId]);
    }
    sperrenNeuLaden();
    // Offene Hintergrundverbindung (Relais) sofort schliessen; nur auf dieser Gateway-Maschine,
    // andere trennt spaetestens der naechste Neuaufbau.
    if (gesperrt) kopfRelais.trennenAlle(actorId);
    // Keycloak ist Beiwerk: Scheitert es, greift die Gateway-Sperre trotzdem.
    let keycloak = true;
    let fehler: string | null = null;
    try {
      await kontoInKeycloakSperren(actorId, gesperrt);
    } catch (err) {
      keycloak = false;
      fehler = err instanceof Error ? err.message : String(err);
    }
    logger.info({ actorId, gesperrt, von: auth.actorId, keycloak, fehler }, "[betreiber-nutzer] Sperre geaendert");
    return c.json({ ok: true, gesperrt, keycloak, fehler }, 200);
  },
);

// Die App meldet je Chat-Nachricht eines Menschen den Kanal (Konsole „Aktive Nutzer“).
// Nur Art und Kanal, kein Inhalt. Noetig, weil Chats mit eigenem KI-Schluessel oder
// ChatGPT-Abo sonst nirgends am Gateway sichtbar werden.
const KANAL_TEXT = { desktop: "Chat (Desktop)", telegram: "Chat (Telegram)", app: "Chat (App)", stimme: "Sprachmodus", server: "Chat (Server-AVA)" } as const;
betreiberNutzerRouter.openapi(
  createRoute({
    method: "post",
    path: "/nutzung",
    tags: ["nutzer"],
    summary: "Nutzung melden: eine Chat-Nachricht eines Menschen (nur Kanal, kein Inhalt)",
    request: { body: { content: { "application/json": { schema: z.object({ art: z.literal("chat"), kanal: z.enum(["desktop", "telegram", "app", "stimme", "server"]) }) } } } },
    responses: { 200: { content: { "application/json": { schema: z.object({ ok: z.boolean() }) } }, description: "vermerkt" } },
  }),
  async (c) => {
    const auth = c.get("auth");
    const { kanal } = c.req.valid("json");
    vermerkeNutzung(getGatewayPool(), { actorId: auth.actorId, tenantId: auth.tenantId ?? null, art: KANAL_TEXT[kanal] });
    return c.json({ ok: true }, 200);
  },
);

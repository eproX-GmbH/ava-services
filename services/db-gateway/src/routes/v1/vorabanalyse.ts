// Vorabanalyse (docs/PLAN_VORABANALYSE.md) — Betreiber-Routen. V0: Laeufe anlegen,
// Datei-Zeilen einlesen, Stand, Firmenliste, Ereignisse. Spaetere Phasen haengen
// Abgleich, Zuordnung, Website/Profil/Urteil und Exporte an.

import { OpenAPIHono, createRoute, z } from "@hono/zod-openapi";
import { HTTPException } from "hono/http-exception";
import { getGatewayPool } from "../../lib/producer-pools";
import { istBetreiber } from "../../middleware/auth";
import { ErrorShape } from "./schemas";
import { ereignisse, firmenEinfuegen, firmenLeeren, firmenListe, laufAendern, laufAnlegen, laufKosten, laufLesen, laufListe, laufLoeschen, zaehlerAktualisieren, STANDARD } from "../../lib/vorabanalyse/store";

export const vorabanalyseRouter = new OpenAPIHono();

const Any = z.object({}).passthrough();
const Id = z.object({ id: z.string().min(3).max(40) });
const EinstellungenShape = z.object({
  mindestScore: z.number().int().min(0).max(100).optional(),
  judgeKonfidenz: z.number().min(0).max(1).optional(),
  budgetUsd: z.number().min(0).max(100_000).optional(),
  bestMatchMindestScore: z.number().min(0).max(1).optional(),
  parallelWebsite: z.number().int().min(1).max(20).optional(),
  parallelProfil: z.number().int().min(1).max(30).optional(),
});

function betreiber(c: { get: (k: "auth") => unknown }): { actorId: string } {
  const auth = c.get("auth") as { actorId?: string | null; roles?: string[]; tenantId?: string } | undefined;
  if (!auth || !istBetreiber(auth as never)) throw new HTTPException(404, { message: "not_found" });
  return { actorId: auth.actorId ?? "?" };
}

async function laufOder404(id: string) {
  const lauf = await laufLesen(getGatewayPool(), id);
  if (!lauf) throw new HTTPException(404, { message: "lauf_unbekannt" });
  return lauf;
}

const ok200 = (beschreibung: string) => ({ 200: { content: { "application/json": { schema: Any } }, description: beschreibung }, 404: { content: { "application/json": { schema: ErrorShape } }, description: "kein Betreiber / unbekannt" } });

vorabanalyseRouter.openapi(createRoute({ method: "get", path: "/betreiber/vorabanalyse", tags: ["vorabanalyse"], summary: "Vorabanalyse: Laeufe", responses: ok200("Liste") }), async (c) => {
  betreiber(c);
  return c.json({ laeufe: await laufListe(getGatewayPool()), standard: STANDARD }, 200);
});

vorabanalyseRouter.openapi(createRoute({
  method: "post", path: "/betreiber/vorabanalyse", tags: ["vorabanalyse"], summary: "Vorabanalyse: Lauf anlegen",
  request: { body: { content: { "application/json": { schema: z.object({ kundeName: z.string().min(2).max(200), notiz: z.string().max(2000).optional(), einstellungen: EinstellungenShape.optional() }) } }, required: true } },
  responses: ok200("angelegt"),
}), async (c) => {
  const { actorId } = betreiber(c);
  const b = c.req.valid("json");
  const lauf = await laufAnlegen(getGatewayPool(), { kundeName: b.kundeName.trim(), erstelltVon: actorId, notiz: b.notiz ?? null, einstellungen: b.einstellungen });
  return c.json({ lauf }, 200);
});

vorabanalyseRouter.openapi(createRoute({ method: "get", path: "/betreiber/vorabanalyse/{id}", tags: ["vorabanalyse"], summary: "Vorabanalyse: Stand eines Laufs", request: { params: Id }, responses: ok200("Stand") }), async (c) => {
  betreiber(c);
  const { id } = c.req.valid("param");
  const pool = getGatewayPool();
  const lauf = await laufOder404(id);
  const [zaehler, kosten, letzte] = await Promise.all([zaehlerAktualisieren(pool, id), laufKosten(pool, id), ereignisse(pool, id, 50)]);
  return c.json({ lauf: { ...lauf, zaehler }, kosten, ereignisse: letzte }, 200);
});

vorabanalyseRouter.openapi(createRoute({
  method: "put", path: "/betreiber/vorabanalyse/{id}", tags: ["vorabanalyse"], summary: "Vorabanalyse: Lauf aendern (Name, Notiz, Einstellungen, ICP)",
  request: { params: Id, body: { content: { "application/json": { schema: z.object({ kundeName: z.string().min(2).max(200).optional(), notiz: z.string().max(2000).nullable().optional(), einstellungen: EinstellungenShape.optional(), icp: z.record(z.string(), z.unknown()).nullable().optional() }) } }, required: true } },
  responses: ok200("geaendert"),
}), async (c) => {
  betreiber(c);
  const { id } = c.req.valid("param");
  const b = c.req.valid("json");
  await laufOder404(id);
  const lauf = await laufAendern(getGatewayPool(), id, b);
  if (b.icp !== undefined) await (await import("../../lib/vorabanalyse/store")).ereignis(getGatewayPool(), id, "icp", "info", b.icp ? "ICP gespeichert." : "ICP entfernt.");
  return c.json({ lauf }, 200);
});

vorabanalyseRouter.openapi(createRoute({ method: "delete", path: "/betreiber/vorabanalyse/{id}", tags: ["vorabanalyse"], summary: "Vorabanalyse: Lauf als geloescht markieren", request: { params: Id }, responses: ok200("geloescht") }), async (c) => {
  betreiber(c);
  const { id } = c.req.valid("param");
  if (!(await laufLoeschen(getGatewayPool(), id))) throw new HTTPException(404, { message: "lauf_unbekannt" });
  return c.json({ ok: true }, 200);
});

// Datei-Zeilen: die Konsole liest xlsx/csv im Browser und schickt Zeilen in Paketen.
const ZeileShape = z.object({ name: z.string().min(1).max(300), ort: z.string().max(200).nullable().optional(), plz: z.string().max(20).nullable().optional(), strasse: z.string().max(300).nullable().optional(), land: z.string().max(10).nullable().optional(), eingabe: z.record(z.string(), z.unknown()).nullable().optional() });
vorabanalyseRouter.openapi(createRoute({
  method: "post", path: "/betreiber/vorabanalyse/{id}/firmen", tags: ["vorabanalyse"], summary: "Vorabanalyse: Zeilen einlesen (Paket; neu=true leert vorher)",
  request: { params: Id, body: { content: { "application/json": { schema: z.object({ zeilen: z.array(ZeileShape).max(5000), startZeile: z.number().int().min(1), neu: z.boolean().optional(), dateiName: z.string().max(300).optional(), spalten: z.record(z.string(), z.string()).optional(), fertig: z.boolean().optional() }) } }, required: true } },
  responses: ok200("eingelesen"),
}), async (c) => {
  betreiber(c);
  const { id } = c.req.valid("param");
  const b = c.req.valid("json");
  const pool = getGatewayPool();
  const lauf = await laufOder404(id);
  if (!["neu", "icp", "abgleich", "zuordnung"].includes(lauf.status)) throw new HTTPException(409, { message: "Der Lauf verarbeitet schon; Zeilen lassen sich nur vor dem Start aendern." });
  if (b.neu) await firmenLeeren(pool, id);
  const r = await firmenEinfuegen(pool, id, b.zeilen, b.startZeile);
  if (b.dateiName || b.spalten) await laufAendern(pool, id, { dateiName: b.dateiName ?? lauf.dateiName, spalten: b.spalten ?? lauf.spalten, status: lauf.status === "neu" ? "icp" : lauf.status });
  const zaehler = await zaehlerAktualisieren(pool, id);
  if (b.fertig) await (await import("../../lib/vorabanalyse/store")).ereignis(pool, id, "datei", "info", `${zaehler.gesamt ?? 0} Zeilen eingelesen, ${zaehler.duplikate ?? 0} Duplikate${b.dateiName ? ` (${b.dateiName})` : ""}.`);
  return c.json({ ...r, zaehler }, 200);
});

vorabanalyseRouter.openapi(createRoute({
  method: "get", path: "/betreiber/vorabanalyse/{id}/firmen", tags: ["vorabanalyse"], summary: "Vorabanalyse: Firmen des Laufs (Filter, Suche, Seiten)",
  request: { params: Id, query: z.object({ filter: z.string().max(30).optional(), suche: z.string().max(100).optional(), seite: z.coerce.number().int().min(1).default(1), groesse: z.coerce.number().int().min(1).max(500).default(100) }) },
  responses: ok200("Firmen"),
}), async (c) => {
  betreiber(c);
  const { id } = c.req.valid("param");
  const q = c.req.valid("query");
  await laufOder404(id);
  return c.json(await firmenListe(getGatewayPool(), id, q), 200);
});

vorabanalyseRouter.openapi(createRoute({ method: "get", path: "/betreiber/vorabanalyse/{id}/ereignisse", tags: ["vorabanalyse"], summary: "Vorabanalyse: Ereignisse", request: { params: Id, query: z.object({ limit: z.coerce.number().int().min(1).max(1000).default(200) }) }, responses: ok200("Ereignisse") }), async (c) => {
  betreiber(c);
  const { id } = c.req.valid("param");
  const { limit } = c.req.valid("query");
  await laufOder404(id);
  return c.json({ ereignisse: await ereignisse(getGatewayPool(), id, limit) }, 200);
});

// ---- V1: ICP ---------------------------------------------------------------

vorabanalyseRouter.openapi(createRoute({
  method: "put", path: "/betreiber/vorabanalyse/{id}/icp", tags: ["vorabanalyse"], summary: "Vorabanalyse: ICP speichern",
  request: { params: Id, body: { content: { "application/json": { schema: z.record(z.string(), z.unknown()) } }, required: true } },
  responses: ok200("gespeichert"),
}), async (c) => {
  betreiber(c);
  const { id } = c.req.valid("param");
  const roh = c.req.valid("json");
  const lauf = await laufOder404(id);
  const { IcpSchema } = await import("../../lib/vorabanalyse/icp");
  const parsed = IcpSchema.safeParse({ ...roh, updatedAt: new Date().toISOString() });
  if (!parsed.success) throw new HTTPException(400, { message: `ICP unvollstaendig: ${parsed.error.issues[0]?.path.join(".") ?? "?"}` });
  const icp = parsed.data;
  const neu = await laufAendern(getGatewayPool(), id, { icp, status: lauf.status === "icp" && lauf.firmen > 0 ? "abgleich" : lauf.status });
  await (await import("../../lib/vorabanalyse/store")).ereignis(getGatewayPool(), id, "icp", "info", `ICP gespeichert (${icp.branchen.length} Branchen, ${icp.merkmale.length} Merkmale).`);
  return c.json({ lauf: neu }, 200);
});

vorabanalyseRouter.openapi(createRoute({
  method: "post", path: "/betreiber/vorabanalyse/{id}/icp/assistent", tags: ["vorabanalyse"], summary: "Vorabanalyse: ICP-Vorschlag aus Website oder Text (Betreiber-Modell)",
  request: { params: Id, body: { content: { "application/json": { schema: z.object({ website: z.string().max(300).optional(), text: z.string().max(400_000).optional(), quelle: z.string().max(80).optional() }) } }, required: true } },
  responses: ok200("Vorschlag"),
}), async (c) => {
  betreiber(c);
  const { id } = c.req.valid("param");
  const b = c.req.valid("json");
  await laufOder404(id);
  const { icpAusText, icpAusWebsite } = await import("../../lib/vorabanalyse/icp");
  const q = `vorab:${id}`;
  const r = b.text && b.text.trim().length >= 80 ? await icpAusText(b.text, q) : b.website ? await icpAusWebsite(b.website.trim(), q) : { error: "Website oder Text angeben." };
  if ("error" in r) throw new HTTPException(422, { message: r.error });
  await (await import("../../lib/vorabanalyse/store")).ereignis(getGatewayPool(), id, "icp", "info", `ICP-Vorschlag aus ${b.text ? b.quelle ?? "Text" : b.website}.`);
  return c.json(r, 200);
});

// ---- V2: Abgleich und Zuordnung -------------------------------------------

vorabanalyseRouter.openapi(createRoute({ method: "post", path: "/betreiber/vorabanalyse/{id}/abgleich", tags: ["vorabanalyse"], summary: "Vorabanalyse: Stammdaten-Abgleich starten (neu=true setzt zurueck)", request: { params: Id, body: { content: { "application/json": { schema: z.object({ neu: z.boolean().optional() }) } }, required: false } }, responses: ok200("gestartet") }), async (c) => {
  betreiber(c);
  const { id } = c.req.valid("param");
  const body = (await c.req.json().catch(() => ({}))) as { neu?: boolean };
  const lauf = await laufOder404(id);
  const { abgleichStarten, abgleichLaeuft, abgleichZuruecksetzen } = await import("../../lib/vorabanalyse/abgleich");
  if (abgleichLaeuft(id)) return c.json({ ok: true, laeuft: true }, 200);
  if (!["icp", "abgleich", "zuordnung", "fehler", "neu"].includes(lauf.status)) throw new HTTPException(409, { message: "Der Lauf ist schon weiter; Abgleich nur vor dem Start der Website-Suche." });
  if (lauf.firmen === 0) throw new HTTPException(409, { message: "Erst eine Datei einlesen." });
  if (body.neu) await abgleichZuruecksetzen(getGatewayPool(), id);
  abgleichStarten(getGatewayPool(), id);
  return c.json({ ok: true, laeuft: true }, 200);
});

vorabanalyseRouter.openapi(createRoute({
  method: "put", path: "/betreiber/vorabanalyse/{id}/firmen/{firmaId}/zuordnung", tags: ["vorabanalyse"], summary: "Vorabanalyse: Zuordnung einer Zeile (Kandidat, ohne Registerfirma, ausschliessen)",
  request: { params: Id.extend({ firmaId: z.coerce.number().int().min(1) }), body: { content: { "application/json": { schema: z.object({ companyId: z.string().max(120).nullable(), ausschliessen: z.boolean().optional() }) } }, required: true } },
  responses: ok200("zugeordnet"),
}), async (c) => {
  betreiber(c);
  const { id, firmaId } = c.req.valid("param");
  const b = c.req.valid("json");
  await laufOder404(id);
  const { zuordnen } = await import("../../lib/vorabanalyse/abgleich");
  if (!(await zuordnen(getGatewayPool(), id, firmaId, b))) throw new HTTPException(404, { message: "firma_unbekannt" });
  return c.json({ ok: true }, 200);
});

vorabanalyseRouter.openapi(createRoute({ method: "post", path: "/betreiber/vorabanalyse/{id}/bestmatch", tags: ["vorabanalyse"], summary: "Vorabanalyse: Best Match fuer alle offenen unsicheren Zeilen", request: { params: Id }, responses: ok200("zugeordnet") }), async (c) => {
  betreiber(c);
  const { id } = c.req.valid("param");
  const lauf = await laufOder404(id);
  const { bestMatch } = await import("../../lib/vorabanalyse/abgleich");
  return c.json(await bestMatch(getGatewayPool(), id, lauf.einstellungen.bestMatchMindestScore), 200);
});

vorabanalyseRouter.openapi(createRoute({ method: "get", path: "/betreiber/vorabanalyse/{id}/abgleich.xlsx", tags: ["vorabanalyse"], summary: "Vorabanalyse: Abgleichsbericht als Excel", request: { params: Id }, responses: { 200: { content: { "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet": { schema: z.string() } }, description: "xlsx" }, 404: { content: { "application/json": { schema: ErrorShape } }, description: "unbekannt" } } }), async (c) => {
  betreiber(c);
  const { id } = c.req.valid("param");
  await laufOder404(id);
  const { abgleichBericht } = await import("../../lib/vorabanalyse/bericht");
  const b = await abgleichBericht(getGatewayPool(), id);
  if (!b) throw new HTTPException(404, { message: "lauf_unbekannt" });
  return new Response(new Uint8Array(b.buffer), { status: 200, headers: { "content-type": "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet", "content-disposition": `attachment; filename="${b.datei}"` } }) as never;
});

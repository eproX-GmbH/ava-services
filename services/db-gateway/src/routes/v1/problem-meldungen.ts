// docs/PLAN_PROBLEM_MELDEN.md M1 — Problemmeldungen.
// Nutzer: anlegen (multipart mit Snapshot + Dateien), eigene lesen, antworten,
// Dateien nachreichen, gelesen. Betreiber (Keycloak-Rolle admin): Liste mit
// Zaehlern, Detail mit internen Kommentaren, Anhang-Download, Nachricht an den
// Nutzer oder intern, Status/Prioritaet/Zuweisung.
import { OpenAPIHono, createRoute, z } from "@hono/zod-openapi";
import { HTTPException } from "hono/http-exception";
import { getGatewayPool } from "../../lib/producer-pools";
import { istBetreiber } from "../../middleware/auth";
import {
  KATEGORIEN, STATUS, PRIORITAETEN, QUELLEN,
  meldungAnlegen, meineMeldungen, meldungLesen, anhangLaden, anhaengeNachreichen, nutzerAntwort, nutzerGelesen,
  betreiberListe, betreiberNachricht, betreiberAendern, betreiberGelesen,
  type NeueDatei,
} from "../../lib/problem-meldungen";
import { ErrorShape } from "./schemas";

export const problemMeldungenRouter = new OpenAPIHono();
const tag = "problem-meldungen";
const Passthrough = z.object({}).passthrough();

function auth(c: { get: (k: "auth") => { tenantId: string; actorId: string; name?: string | null; email?: string | null; roles: string[] } }) {
  const a = c.get("auth");
  if (!a?.actorId) throw new HTTPException(401, { message: "auth_context_missing" });
  return a;
}

/** Multipart lesen: Felder als Strings, Dateien unter `snapshot` (eine) und `datei` (mehrere). */
async function multipartLesen(c: { req: { parseBody: (o?: { all?: boolean }) => Promise<Record<string, unknown>> } }): Promise<{ felder: Record<string, string>; dateien: NeueDatei[] }> {
  const form = await c.req.parseBody({ all: true }).catch(() => null);
  if (!form) throw new HTTPException(400, { message: "multipart/form-data erwartet" });
  const felder: Record<string, string> = {};
  const dateien: NeueDatei[] = [];
  for (const [k, v] of Object.entries(form)) {
    const werte = Array.isArray(v) ? v : [v];
    for (const w of werte) {
      if (w instanceof File) {
        const feld = k === "snapshot" ? "snapshot" : "datei";
        dateien.push({ feld, name: w.name || (feld === "snapshot" ? "protokolle.zip" : "datei"), mime: w.type || (feld === "snapshot" ? "application/zip" : "application/octet-stream"), bytes: new Uint8Array(await w.arrayBuffer()) });
      } else if (typeof w === "string") felder[k] = w;
    }
  }
  return { felder, dateien };
}

function fehlerWerfen(err: unknown): never {
  const e = err as { status?: number; message?: string };
  if (e.status === 413) throw new HTTPException(413, { message: e.message ?? "zu gross" });
  throw err;
}

// ---- Nutzer ----------------------------------------------------------------

const anlegenRoute = createRoute({
  method: "post",
  path: "/meldungen",
  tags: [tag],
  summary: "Problem melden (multipart: kategorie, titel, beschreibung, quelle, appVersion, plattform, conversationId, companyId; Dateien snapshot und datei)",
  request: { body: { content: { "multipart/form-data": { schema: Passthrough } }, required: true } },
  responses: {
    201: { content: { "application/json": { schema: Passthrough } }, description: "Meldung angelegt" },
    400: { content: { "application/json": { schema: ErrorShape } }, description: "Eingabe unvollstaendig" },
    413: { content: { "application/json": { schema: ErrorShape } }, description: "Datei zu gross" },
  },
});
problemMeldungenRouter.openapi(anlegenRoute, async (c) => {
  const a = auth(c);
  const { felder, dateien } = await multipartLesen(c);
  const kategorie = (KATEGORIEN as readonly string[]).includes(felder.kategorie ?? "") ? felder.kategorie : "sonstiges";
  const titel = (felder.titel ?? "").trim();
  const beschreibung = (felder.beschreibung ?? "").trim();
  if (!titel || !beschreibung) throw new HTTPException(400, { message: "Titel und Beschreibung sind Pflicht." });
  const quelle = (QUELLEN as readonly string[]).includes(felder.quelle ?? "") ? felder.quelle : "dialog";
  try {
    const m = await meldungAnlegen(getGatewayPool(), {
      tenantId: a.tenantId, actorId: a.actorId, kategorie, titel, beschreibung, quelle,
      appVersion: felder.appVersion?.slice(0, 40) ?? null, plattform: felder.plattform?.slice(0, 120) ?? null,
      conversationId: felder.conversationId?.slice(0, 80) ?? null, companyId: felder.companyId?.slice(0, 80) ?? null,
      dateien,
    });
    return c.json({ id: m.id, kennung: m.kennung, status: m.status, anhaenge: dateien.length }, 201);
  } catch (err) {
    fehlerWerfen(err);
  }
});

const meineRoute = createRoute({
  method: "get",
  path: "/meldungen/meine",
  tags: [tag],
  summary: "Eigene Problemmeldungen mit Status und letzter Nachricht",
  responses: { 200: { content: { "application/json": { schema: Passthrough } }, description: "ok" } },
});
problemMeldungenRouter.openapi(meineRoute, async (c) => {
  const a = auth(c);
  const liste = await meineMeldungen(getGatewayPool(), a.actorId);
  return c.json({ meldungen: liste, ungelesen: liste.filter((m) => m.ungelesenNutzer).length }, 200);
});

const IdParam = z.object({ id: z.string().min(1).max(80) });
const lesenRoute = createRoute({
  method: "get",
  path: "/meldungen/{id}",
  tags: [tag],
  summary: "Eigene Meldung mit Verlauf (ohne interne Kommentare)",
  request: { params: IdParam },
  responses: {
    200: { content: { "application/json": { schema: Passthrough } }, description: "ok" },
    404: { content: { "application/json": { schema: ErrorShape } }, description: "unbekannt" },
  },
});
problemMeldungenRouter.openapi(lesenRoute, async (c) => {
  const a = auth(c);
  const r = await meldungLesen(getGatewayPool(), c.req.valid("param").id, { actorId: a.actorId });
  if (!r) throw new HTTPException(404, { message: "not_found" });
  return c.json(r, 200);
});

const antwortRoute = createRoute({
  method: "post",
  path: "/meldungen/{id}/nachrichten",
  tags: [tag],
  summary: "Antwort des Nutzers",
  request: { params: IdParam, body: { content: { "application/json": { schema: z.object({ text: z.string().trim().min(1).max(8000) }) } }, required: true } },
  responses: {
    200: { content: { "application/json": { schema: Passthrough } }, description: "ok" },
    404: { content: { "application/json": { schema: ErrorShape } }, description: "unbekannt" },
  },
});
problemMeldungenRouter.openapi(antwortRoute, async (c) => {
  const a = auth(c);
  const pool = getGatewayPool();
  const r = await meldungLesen(pool, c.req.valid("param").id, { actorId: a.actorId });
  if (!r) throw new HTTPException(404, { message: "not_found" });
  const n = await nutzerAntwort(pool, r.meldung, c.req.valid("json").text);
  return c.json({ nachricht: n }, 200);
});

const nachreichenRoute = createRoute({
  method: "post",
  path: "/meldungen/{id}/anhaenge",
  tags: [tag],
  summary: "Dateien zu einer eigenen Meldung nachreichen",
  request: { params: IdParam, body: { content: { "multipart/form-data": { schema: Passthrough } }, required: true } },
  responses: {
    200: { content: { "application/json": { schema: Passthrough } }, description: "ok" },
    404: { content: { "application/json": { schema: ErrorShape } }, description: "unbekannt" },
    413: { content: { "application/json": { schema: ErrorShape } }, description: "zu gross" },
  },
});
problemMeldungenRouter.openapi(nachreichenRoute, async (c) => {
  const a = auth(c);
  const pool = getGatewayPool();
  const r = await meldungLesen(pool, c.req.valid("param").id, { actorId: a.actorId });
  if (!r) throw new HTTPException(404, { message: "not_found" });
  const { dateien } = await multipartLesen(c);
  try {
    const n = await anhaengeNachreichen(pool, r.meldung.id, dateien);
    return c.json({ anhaenge: n }, 200);
  } catch (err) {
    fehlerWerfen(err);
  }
});

const gelesenRoute = createRoute({
  method: "put",
  path: "/meldungen/{id}/gelesen",
  tags: [tag],
  summary: "Antworten des Betreibers als gelesen markieren",
  request: { params: IdParam },
  responses: { 200: { content: { "application/json": { schema: z.object({ ok: z.literal(true) }) } }, description: "ok" }, 404: { content: { "application/json": { schema: ErrorShape } }, description: "unbekannt" } },
});
problemMeldungenRouter.openapi(gelesenRoute, async (c) => {
  const a = auth(c);
  const pool = getGatewayPool();
  const r = await meldungLesen(pool, c.req.valid("param").id, { actorId: a.actorId });
  if (!r) throw new HTTPException(404, { message: "not_found" });
  await nutzerGelesen(pool, r.meldung.id);
  return c.json({ ok: true as const }, 200);
});

// ---- Betreiber -------------------------------------------------------------

function nurBetreiber(c: Parameters<typeof auth>[0]) {
  const a = auth(c);
  if (!istBetreiber(a as never)) throw new HTTPException(404, { message: "not_found" });
  return a;
}

const bListeRoute = createRoute({
  method: "get",
  path: "/betreiber/meldungen",
  tags: [tag],
  summary: "Betreiber: alle Problemmeldungen mit Filtern und Zaehlern",
  request: { query: z.object({ status: z.enum(STATUS).optional(), prioritaet: z.enum(PRIORITAETEN).optional(), kategorie: z.enum(KATEGORIEN).optional(), zugewiesenAn: z.string().max(120).optional(), tenantId: z.string().max(120).optional(), suche: z.string().max(200).optional(), offen: z.enum(["0", "1"]).optional() }) },
  responses: { 200: { content: { "application/json": { schema: Passthrough } }, description: "ok" }, 404: { content: { "application/json": { schema: ErrorShape } }, description: "kein Betreiber" } },
});
problemMeldungenRouter.openapi(bListeRoute, async (c) => {
  nurBetreiber(c);
  const q = c.req.valid("query");
  const r = await betreiberListe(getGatewayPool(), { ...q, offen: q.offen === "1" });
  return c.json(r, 200);
});

const bDetailRoute = createRoute({
  method: "get",
  path: "/betreiber/meldungen/{id}",
  tags: [tag],
  summary: "Betreiber: Meldung komplett (interne Kommentare, Anhaenge, Kunde)",
  request: { params: IdParam },
  responses: { 200: { content: { "application/json": { schema: Passthrough } }, description: "ok" }, 404: { content: { "application/json": { schema: ErrorShape } }, description: "unbekannt" } },
});
problemMeldungenRouter.openapi(bDetailRoute, async (c) => {
  nurBetreiber(c);
  const pool = getGatewayPool();
  const r = await meldungLesen(pool, c.req.valid("param").id, { betreiber: true });
  if (!r) throw new HTTPException(404, { message: "not_found" });
  await betreiberGelesen(pool, r.meldung.id);
  const org = await pool.query<{ name: string | null; kind: string }>(`SELECT name, kind FROM "Tenant" WHERE id = $1`, [r.meldung.tenantId]).catch(() => ({ rows: [] as Array<{ name: string | null; kind: string }> }));
  const billing = await pool.query<{ mode: string; tier: string }>(`SELECT mode, tier FROM "TenantBilling" WHERE "tenantId" = $1`, [r.meldung.tenantId]).catch(() => ({ rows: [] as Array<{ mode: string; tier: string }> }));
  const weitere = await pool.query<{ n: string }>(`SELECT COUNT(*)::text AS n FROM "ProblemMeldung" WHERE "actorId" = $1 AND id <> $2`, [r.meldung.actorId, r.meldung.id]);
  return c.json({ ...r, kunde: { orgName: org.rows[0]?.name ?? null, orgKind: org.rows[0]?.kind ?? null, mode: billing.rows[0]?.mode ?? null, tier: billing.rows[0]?.tier ?? null, weitereMeldungen: Number(weitere.rows[0]?.n ?? 0) } }, 200);
});

const bAnhangRoute = createRoute({
  method: "get",
  path: "/betreiber/meldungen/{id}/anhaenge/{anhangId}",
  tags: [tag],
  summary: "Betreiber: Anhang herunterladen",
  request: { params: z.object({ id: z.string().min(1).max(80), anhangId: z.string().min(1).max(80) }) },
  responses: { 200: { description: "Datei" }, 404: { content: { "application/json": { schema: ErrorShape } }, description: "unbekannt oder geloescht" } },
});
problemMeldungenRouter.openapi(bAnhangRoute, async (c) => {
  nurBetreiber(c);
  const pool = getGatewayPool();
  const { id, anhangId } = c.req.valid("param");
  const m = await meldungLesen(pool, id, { betreiber: true });
  if (!m) throw new HTTPException(404, { message: "not_found" });
  const a = await anhangLaden(pool, m.meldung.id, anhangId);
  if (!a) throw new HTTPException(404, { message: "Anhang nicht mehr vorhanden (Aufbewahrung abgelaufen)." });
  return new Response(new Uint8Array(a.inhalt), {
    status: 200,
    headers: { "content-type": a.mime, "content-length": String(a.inhalt.byteLength), "content-disposition": `${a.mime.startsWith("image/") ? "inline" : "attachment"}; filename*=UTF-8''${encodeURIComponent(a.dateiname)}` },
  });
});

const bNachrichtRoute = createRoute({
  method: "post",
  path: "/betreiber/meldungen/{id}/nachrichten",
  tags: [tag],
  summary: "Betreiber: Nachricht an den Nutzer (intern=false) oder interner Kommentar",
  request: { params: IdParam, body: { content: { "application/json": { schema: z.object({ text: z.string().trim().min(1).max(8000), intern: z.boolean().default(false) }) } }, required: true } },
  responses: { 200: { content: { "application/json": { schema: Passthrough } }, description: "ok" }, 404: { content: { "application/json": { schema: ErrorShape } }, description: "unbekannt" } },
});
problemMeldungenRouter.openapi(bNachrichtRoute, async (c) => {
  const a = nurBetreiber(c);
  const pool = getGatewayPool();
  const r = await meldungLesen(pool, c.req.valid("param").id, { betreiber: true });
  if (!r) throw new HTTPException(404, { message: "not_found" });
  const b = c.req.valid("json");
  const n = await betreiberNachricht(pool, r.meldung, { actorId: a.actorId, name: a.name ?? a.email ?? null }, b.text, b.intern);
  return c.json({ nachricht: n }, 200);
});

const bAendernRoute = createRoute({
  method: "put",
  path: "/betreiber/meldungen/{id}",
  tags: [tag],
  summary: "Betreiber: Status, Prioritaet, Zuweisung, Kategorie aendern",
  request: { params: IdParam, body: { content: { "application/json": { schema: z.object({ status: z.enum(STATUS).optional(), prioritaet: z.enum(PRIORITAETEN).optional(), zugewiesenAn: z.string().max(120).nullable().optional(), kategorie: z.enum(KATEGORIEN).optional() }) } }, required: true } },
  responses: { 200: { content: { "application/json": { schema: Passthrough } }, description: "ok" }, 404: { content: { "application/json": { schema: ErrorShape } }, description: "unbekannt" } },
});
problemMeldungenRouter.openapi(bAendernRoute, async (c) => {
  const a = nurBetreiber(c);
  const pool = getGatewayPool();
  const r = await meldungLesen(pool, c.req.valid("param").id, { betreiber: true });
  if (!r) throw new HTTPException(404, { message: "not_found" });
  const m = await betreiberAendern(pool, r.meldung, { actorId: a.actorId, name: a.name ?? a.email ?? null }, c.req.valid("json"));
  return c.json({ meldung: m }, 200);
});

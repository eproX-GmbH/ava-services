// Betreiber: Stammdatenpflege (Register-Delta) — Uebersicht, Server-Worker, Desktop-Helfer,
// Aenderungsprotokoll, fehlgeschlagene Jobs. Nur Betreiber (sonst 404).
// Dazu zwei Nutzer-Routen (Burggraben-Punkt 4): eigener Beitrag und Meldung der
// Mithelfen-Einstellung des Geraets.

import { OpenAPIHono, createRoute, z } from "@hono/zod-openapi";
import { HTTPException } from "hono/http-exception";
import { getGatewayPool } from "../../lib/producer-pools";
import { istBetreiber } from "../../middleware/auth";
import { ErrorShape } from "./schemas";
import { meinBeitrag, mithelfenStandMelden } from "../../lib/mithelfen-beitrag";

export const stammdatenRouter = new OpenAPIHono();

const Seite = z.object({ seite: z.coerce.number().int().min(1).default(1), groesse: z.coerce.number().int().min(1).max(200).default(50) });
const ok200 = (d: string) => ({ 200: { content: { "application/json": { schema: z.object({}).passthrough() } }, description: d }, 404: { content: { "application/json": { schema: ErrorShape } }, description: "kein Betreiber" } });

stammdatenRouter.openapi(createRoute({ method: "get", path: "/betreiber/stammdaten", tags: ["stammdaten"], summary: "Betreiber: Stand der Stammdatenpflege", request: { query: z.object({ tage: z.coerce.number().int().min(1).max(90).default(30) }) }, responses: ok200("Stand") }), async (c) => {
  if (!istBetreiber(c.get("auth"))) throw new HTTPException(404, { message: "not_found" });
  const { tage } = c.req.valid("query");
  const { pflegeUebersicht } = await import("../../lib/stammdaten-pflege");
  return c.json(await pflegeUebersicht(getGatewayPool(), tage), 200);
});

stammdatenRouter.openapi(createRoute({ method: "get", path: "/betreiber/stammdaten/helfer", tags: ["stammdaten"], summary: "Betreiber: Desktop-Helfer der Stammdatenpflege", request: { query: Seite.extend({ nurAktiv: z.enum(["0", "1"]).default("0") }) }, responses: ok200("Helfer") }), async (c) => {
  if (!istBetreiber(c.get("auth"))) throw new HTTPException(404, { message: "not_found" });
  const q = c.req.valid("query");
  const { helferListe } = await import("../../lib/stammdaten-pflege");
  return c.json(await helferListe(getGatewayPool(), { seite: q.seite, groesse: q.groesse, nurAktiv: q.nurAktiv === "1" }), 200);
});

stammdatenRouter.openapi(createRoute({ method: "get", path: "/betreiber/stammdaten/ereignisse", tags: ["stammdaten"], summary: "Betreiber: Aenderungsprotokoll der Stammdaten (neu, geaendert, geschlossen)", request: { query: Seite.extend({ art: z.string().max(30).optional(), land: z.string().regex(/^(DE|AT|UK|CH|NO|FI)(,(DE|AT|UK|CH|NO|FI))*$/).max(20).optional(), suche: z.string().max(100).optional(), companyId: z.string().max(120).optional() }) }, responses: ok200("Protokoll") }), async (c) => {
  if (!istBetreiber(c.get("auth"))) throw new HTTPException(404, { message: "not_found" });
  const q = c.req.valid("query");
  const { masterData } = await import("../../lib/register-jobs");
  const liste = await masterData<{ gesamt: number; seite: number; groesse: number; items: Array<Record<string, string | number | boolean | null | string[] | Record<string, string | null>>> }>("POST", "/internal/register-ereignisse/liste", { seite: q.seite, groesse: q.groesse, art: q.art, country: q.land, suche: q.suche, companyId: q.companyId });
  return c.json(liste as unknown as Record<string, never>, 200);
});

stammdatenRouter.openapi(createRoute({ method: "get", path: "/betreiber/stammdaten/fehler", tags: ["stammdaten"], summary: "Betreiber: endgueltig fehlgeschlagene Register-Jobs", request: { query: Seite }, responses: ok200("Fehler") }), async (c) => {
  if (!istBetreiber(c.get("auth"))) throw new HTTPException(404, { message: "not_found" });
  const q = c.req.valid("query");
  const { fehlgeschlageneJobs } = await import("../../lib/stammdaten-pflege");
  return c.json(await fehlgeschlageneJobs(getGatewayPool(), q), 200);
});

stammdatenRouter.openapi(createRoute({ method: "post", path: "/betreiber/stammdaten/fehler/{id}/wiederholen", tags: ["stammdaten"], summary: "Betreiber: fehlgeschlagenen Register-Job erneut einreihen", request: { params: z.object({ id: z.coerce.number().int().min(1) }) }, responses: ok200("eingereiht") }), async (c) => {
  if (!istBetreiber(c.get("auth"))) throw new HTTPException(404, { message: "not_found" });
  const { id } = c.req.valid("param");
  const { jobWiederholen } = await import("../../lib/stammdaten-pflege");
  if (!(await jobWiederholen(getGatewayPool(), id))) throw new HTTPException(404, { message: "Job nicht gefunden oder nicht fehlgeschlagen." });
  return c.json({ ok: true }, 200);
});


// ---- Nutzer: eigener Beitrag und Einstellung (Burggraben-Punkt 4) ---------------

const BeitragMonat = z.object({ monat: z.string(), jobs: z.number(), abfragen: z.number(), treffer: z.number(), neu: z.number(), geaendert: z.number() });
const MeinBeitragShape = z.object({ geraete: z.number(), monat: BeitragMonat, vormonat: BeitragMonat, gesamt: z.object({ jobs: z.number(), abfragen: z.number() }) });

stammdatenRouter.openapi(
  createRoute({
    method: "get", path: "/stammdaten/mein-beitrag", tags: ["stammdaten"], summary: "Was die eigenen Rechner beim Mithelfen beigetragen haben (laufender und voriger Monat)",
    responses: { 200: { content: { "application/json": { schema: MeinBeitragShape } }, description: "Beitrag" }, 401: { content: { "application/json": { schema: ErrorShape } }, description: "nicht angemeldet" } },
  }),
  async (c) => {
    const a = c.get("auth") as { actorId?: string | null } | undefined;
    if (!a?.actorId) throw new HTTPException(401, { message: "unauthorized" });
    return c.json(await meinBeitrag(getGatewayPool(), a.actorId), 200);
  },
);

const StandBody = z.object({
  workerId: z.string().trim().min(1).max(120).regex(/^desktop-[A-Za-z0-9.-]+$/),
  aktiv: z.boolean(),
  quelle: z.enum(["standard", "nutzer"]),
});

stammdatenRouter.openapi(
  createRoute({
    method: "post", path: "/stammdaten/mithelfen-stand", tags: ["stammdaten"], summary: "Desktop meldet seine Mithelfen-Einstellung (an/aus, Standard oder Nutzerentscheidung)",
    request: { body: { content: { "application/json": { schema: StandBody } }, required: true } },
    responses: { 200: { content: { "application/json": { schema: z.object({ ok: z.literal(true) }) } }, description: "gemerkt" }, 400: { content: { "application/json": { schema: ErrorShape } }, description: "ungueltig" }, 401: { content: { "application/json": { schema: ErrorShape } }, description: "nicht angemeldet" } },
  }),
  async (c) => {
    const a = c.get("auth") as { actorId?: string | null; tenantId?: string | null } | undefined;
    if (!a?.actorId) throw new HTTPException(401, { message: "unauthorized" });
    const p = StandBody.safeParse(await c.req.json().catch(() => null));
    if (!p.success) return c.json({ error: "invalid_input", message: "workerId, aktiv, quelle erwartet." }, 400);
    await mithelfenStandMelden(getGatewayPool(), { workerId: p.data.workerId, tenantId: a.tenantId ?? null, actorId: a.actorId, aktiv: p.data.aktiv, quelle: p.data.quelle });
    return c.json({ ok: true as const }, 200);
  },
);

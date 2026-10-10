// Doppelte Personen zusammenführen (lib/contact-extraction/personen-abgleich.ts).
//
//   POST /companies/:id/contacts/abgleich        Stufe 1 ausführen, Stufe-2-Kandidaten liefern
//   POST /companies/:id/contacts/zusammenfuehren Stufe 2 nach KI-Urteil der AVA (Bedingungen erneut geprüft)
//   GET  /companies/:id/contacts/zusammenfuehrungen
//   POST /contacts/zusammenfuehrungen/:id/rueckgaengig

import { OpenAPIHono, createRoute, z } from "@hono/zod-openapi";
import { HTTPException } from "hono/http-exception";
import { getProducerPool } from "../../lib/producer-pools";
import { requireScope } from "../../middleware/auth";
import { logger } from "../../lib/logger";
import {
  ensureZusammenfuehrungSchema,
  personenDerFirma,
  sicherePaare,
  urteilsKandidaten,
  zuruecknehmen,
  zusammenfuehren,
  type PersonKurz,
} from "../../lib/contact-extraction/personen-abgleich";
import { ErrorShape } from "./schemas";

export const kontakteAbgleichRouter = new OpenAPIHono();
kontakteAbgleichRouter.use("*", requireScope("company:read"));
const tag = "contacts";
const errorResponses = {
  400: { content: { "application/json": { schema: ErrorShape } }, description: "bad request" },
  404: { content: { "application/json": { schema: ErrorShape } }, description: "not found" },
  409: { content: { "application/json": { schema: ErrorShape } }, description: "conflict" },
};
const auth = (c: { get: (k: string) => unknown }) => c.get("auth") as { tenantId?: string; actorId?: string } | undefined;

/** Was die AVA fürs Urteil braucht (keine Inhalte jenseits der Kontaktkarte). */
const kurz = (p: PersonKurz) => ({
  personId: p.id,
  fullName: p.fullName,
  titel: p.titel,
  abteilung: p.abteilung,
  beschreibung: p.beschreibung,
  linkedin: p.profile[0] ?? null,
  quellen: p.quellen,
});

const abgleichRoute = createRoute({
  method: "post",
  path: "/companies/{companyId}/contacts/abgleich",
  tags: [tag],
  summary: "Doppelte Personen einer Firma: sichere Paare zusammenführen (Stufe 1), Kandidaten fürs KI-Urteil liefern (Stufe 2)",
  request: { params: z.object({ companyId: z.string().min(1) }) },
  responses: { 200: { content: { "application/json": { schema: z.object({}).passthrough() } }, description: "ok" }, ...errorResponses },
});
kontakteAbgleichRouter.openapi(abgleichRoute, async (c) => {
  const { companyId } = c.req.valid("param");
  const pool = getProducerPool("company-contact");
  await ensureZusammenfuehrungSchema(pool);
  let personen = await personenDerFirma(pool, companyId);
  const zusammengefuehrt: Array<{ id: string; behalten: string; aufgeloest: string; regel: string; grund: string }> = [];
  // Mehrere Runden, falls eine Zusammenführung ein weiteres Paar ergibt (höchstens 5).
  for (let runde = 0; runde < 5; runde++) {
    const paare = sicherePaare(personen);
    if (paare.length === 0) break;
    for (const p of paare) {
      const r = await zusammenfuehren(pool, { companyId, behaltenId: p.behalten.id, aufloesenId: p.aufloesen.id, regel: p.regel, grund: p.grund, actorId: auth(c)?.actorId });
      zusammengefuehrt.push({ id: r.id, behalten: r.behaltenName, aufgeloest: r.aufgeloestName, regel: p.regel, grund: p.grund });
      logger.info({ companyId, behalten: p.behalten.id, aufgeloest: p.aufloesen.id, regel: p.regel }, "[kontakte] Personen zusammengeführt");
    }
    personen = await personenDerFirma(pool, companyId);
  }
  const kandidaten = urteilsKandidaten(personen).map((k) => ({ vorname: kurz(k.vorname), voll: kurz(k.voll) }));
  const firma = await pool.query<{ name: string | null }>(`SELECT "name" FROM "Company" WHERE "id" = $1`, [companyId]);
  return c.json({ companyId, firma: firma.rows[0]?.name ?? null, personen: personen.length, zusammengefuehrt, kandidaten }, 200);
});

const urteilRoute = createRoute({
  method: "post",
  path: "/companies/{companyId}/contacts/zusammenfuehren",
  tags: [tag],
  summary: "Stufe 2: Person mit nur Vornamen mit ihrem eindeutigen Gegenstück zusammenführen (nach KI-Urteil der AVA)",
  request: {
    params: z.object({ companyId: z.string().min(1) }),
    body: { content: { "application/json": { schema: z.object({ vornameId: z.string().min(1), vollId: z.string().min(1), grund: z.string().min(1).max(500) }) } } },
  },
  responses: { 200: { content: { "application/json": { schema: z.object({}).passthrough() } }, description: "ok" }, ...errorResponses },
});
kontakteAbgleichRouter.openapi(urteilRoute, async (c) => {
  const { companyId } = c.req.valid("param");
  const b = c.req.valid("json");
  const pool = getProducerPool("company-contact");
  // Bedingungen hier erneut prüfen: nur ein Vorname, genau ein Gegenstück, kein Profilwiderspruch.
  const k = urteilsKandidaten(await personenDerFirma(pool, companyId)).find((x) => x.vorname.id === b.vornameId && x.voll.id === b.vollId);
  if (!k) throw new HTTPException(409, { message: "kein_kandidat" });
  const r = await zusammenfuehren(pool, { companyId, behaltenId: k.voll.id, aufloesenId: k.vorname.id, regel: "urteil", grund: b.grund, actorId: auth(c)?.actorId });
  logger.info({ companyId, behalten: k.voll.id, aufgeloest: k.vorname.id }, "[kontakte] Personen nach KI-Urteil zusammengeführt");
  return c.json({ id: r.id, behalten: r.behaltenName, aufgeloest: r.aufgeloestName }, 200);
});

const listeRoute = createRoute({
  method: "get",
  path: "/companies/{companyId}/contacts/zusammenfuehrungen",
  tags: [tag],
  summary: "Zusammenführungen von Personen einer Firma (mit Rücknahme)",
  request: { params: z.object({ companyId: z.string().min(1) }) },
  responses: { 200: { content: { "application/json": { schema: z.object({}).passthrough() } }, description: "ok" } },
});
kontakteAbgleichRouter.openapi(listeRoute, async (c) => {
  const { companyId } = c.req.valid("param");
  const pool = getProducerPool("company-contact");
  await ensureZusammenfuehrungSchema(pool);
  const r = await pool.query(
    `SELECT "id", "behaltenId", "aufgeloestId", "behaltenName", "aufgeloestName", "regel", "grund", "createdAt", "rueckgaengigAt"
       FROM "PersonZusammenfuehrung" WHERE "companyId" = $1 ORDER BY "createdAt" DESC LIMIT 100`,
    [companyId],
  );
  return c.json({ items: r.rows }, 200);
});

const rueckRoute = createRoute({
  method: "post",
  path: "/contacts/zusammenfuehrungen/{id}/rueckgaengig",
  tags: [tag],
  summary: "Zusammenführung zweier Personen zurücknehmen",
  request: { params: z.object({ id: z.string().min(1) }) },
  responses: { 200: { content: { "application/json": { schema: z.object({}).passthrough() } }, description: "ok" }, ...errorResponses },
});
kontakteAbgleichRouter.openapi(rueckRoute, async (c) => {
  const { id } = c.req.valid("param");
  const r = await zuruecknehmen(getProducerPool("company-contact"), id);
  if (!r) throw new HTTPException(404, { message: "nicht_gefunden_oder_schon_zurueckgenommen" });
  logger.info({ id, actorId: auth(c)?.actorId }, "[kontakte] Zusammenführung zurückgenommen");
  return c.json({ ok: true, ...r }, 200);
});

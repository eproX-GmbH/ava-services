// Manueller Recherche-Lauf je Firma (2026-09-24): Stellenanzeigen oder
// Ausschreibungen/Expansion gezielt anstossen — Standard oder Deep Research —
// unabhaengig von der globalen Stufe in den Einstellungen des Nutzers.
//
// Der Lauf ist ein Republish des structured-content-Ereignisses NUR an den
// Website-Producer (services: ["website"]) mit der Stufe im `source`-Suffix
// (#research:jobs=deep). Der Producer fuehrt dann nur diese Recherche aus,
// ohne Crawl und ohne Frische-Sperre (website/…/manueller-lauf.ts). Den
// Schluessel hat der Producer aus seiner Umgebung; fehlt er fuer die Stufe,
// endet der Lauf als "failed" mit der Meldung des Producers.

import { OpenAPIHono, createRoute, z } from "@hono/zod-openapi";
import { HTTPException } from "hono/http-exception";
import { requireScope, type AuthContext } from "../../middleware/auth";
import { getGatewayPool } from "../../lib/producer-pools";
import { ErrorShape } from "./schemas";
import { publishStructuredContentRetry } from "../../lib/retry-publish";
import { isHeld } from "../../lib/company-holds";
import { transactionProgressBus } from "../../lib/event-bus";
import { logger } from "../../lib/logger";
import { LAUF_STALE_MS } from "../../lib/research-lauf";

export const companiesResearchRouter = new OpenAPIHono();
companiesResearchRouter.use("*", requireScope("company:read"));

const tag = "companies";

/** Gleiche Form wie Prisma-cuid, ohne Prisma-Client: Zeit + Zufall. */
function cuid(): string {
  return `c${Date.now().toString(36)}${Math.random().toString(36).slice(2, 12)}`;
}
const err = {
  400: { content: { "application/json": { schema: ErrorShape } }, description: "ungueltig" },
  404: { content: { "application/json": { schema: ErrorShape } }, description: "nicht gefunden" },
  409: { content: { "application/json": { schema: ErrorShape } }, description: "laeuft bereits" },
};
const Param = z.object({ companyId: z.string().min(1).max(200) });
const Feature = z.enum(["jobs", "expansion"]);
const Stufe = z.enum(["standard", "deep"]);

/** Stand des Website-Producers zur Firma: juengste Zeile in EntityProgress. */
async function websiteStand(companyId: string): Promise<{ transactionId: string; state: string; updatedAt: string; errorMessage: string | null } | null> {
  const r = await getGatewayPool().query<{ transactionId: string; state: string; updatedAt: Date; errorMessage: string | null }>(
    `SELECT "transactionId", state, "updatedAt", "errorMessage" FROM "EntityProgress"
      WHERE "companyId" = $1 AND producer = 'website' ORDER BY "updatedAt" DESC LIMIT 1`,
    [companyId],
  );
  const z0 = r.rows[0];
  return z0 ? { transactionId: z0.transactionId, state: z0.state, updatedAt: new Date(z0.updatedAt).toISOString(), errorMessage: z0.errorMessage ?? null } : null;
}

const startRoute = createRoute({
  method: "post", path: "/companies/{companyId}/research", tags: [tag],
  summary: "Manuelle Recherche je Firma anstossen (Stellenanzeigen oder Ausschreibungen/Expansion; Standard oder Deep Research)",
  request: { params: Param, body: { content: { "application/json": { schema: z.object({ feature: Feature, stufe: Stufe }) } } } },
  responses: { 200: { content: { "application/json": { schema: z.object({ angestossen: z.boolean(), grund: z.string().optional(), transactionId: z.string().nullable() }) } }, description: "ok" }, ...err },
});
companiesResearchRouter.openapi(startRoute, async (c) => {
  const auth = c.get("auth") as AuthContext;
  const { companyId } = c.req.valid("param");
  const { feature, stufe } = c.req.valid("json");
  const pool = getGatewayPool();

  // Der Lauf haengt an einer Transaktion; die juengste der Firma reicht.
  const tx = await pool.query<{ transactionId: string }>(
    `SELECT "transactionId" FROM "EntityProgress" WHERE "companyId" = $1 ORDER BY "updatedAt" DESC LIMIT 1`,
    [companyId],
  );
  const transactionId = tx.rows[0]?.transactionId ?? null;
  const offen = await pool.query(
    `SELECT 1 FROM "CompanyResearchLauf" WHERE "companyId" = $1 AND feature = $2 AND state = 'laufend' AND "gestartetAt" > NOW() - INTERVAL '45 minutes' LIMIT 1`,
    [companyId, feature],
  );
  let grund: string | undefined;
  if (!transactionId) grund = "Die Firma wurde noch nie verarbeitet — erst importieren und verarbeiten lassen.";
  else if (offen.rowCount) grund = "Diese Recherche läuft für die Firma gerade schon.";
  else if (await isHeld(pool, companyId)) grund = "Die Verarbeitung dieser Firma ist pausiert.";
  if (grund || !transactionId) return c.json({ angestossen: false, grund, transactionId }, 200);

  try {
    await publishStructuredContentRetry({
      stage: "website", transactionId, companyId, userId: auth.actorId,
      source: `${c.req.url}#research:${feature}=${stufe}`,
      services: ["website"],
    });
  } catch (e) {
    if (e instanceof HTTPException) return c.json({ angestossen: false, grund: "Zur Firma fehlen die Registerdaten (Anschrift) — ohne Ort keine Recherche.", transactionId }, 200);
    throw e;
  }
  transactionProgressBus.publishLocal({
    transactionId, tenantId: auth.tenantId, service: "website", companyId,
    state: "in_progress" as never, updatedAt: new Date().toISOString(),
  });
  await pool.query(
    `INSERT INTO "EntityProgress" ("transactionId","companyId",producer,state,"errorMessage","updatedAt","createdAt")
     VALUES ($1,$2,'website','in_progress',NULL,NOW(),NOW())
     ON CONFLICT ("transactionId","companyId",producer) DO UPDATE
       SET state = 'in_progress', "errorMessage" = NULL, "updatedAt" = NOW()`,
    [transactionId, companyId],
  );
  await pool.query(
    `INSERT INTO "CompanyResearchLauf" ("id","tenantId","actorId","companyId","transactionId","feature","stufe") VALUES ($1,$2,$3,$4,$5,$6,$7)`,
    [cuid(), auth.tenantId, auth.actorId, companyId, transactionId, feature, stufe],
  );
  logger.info({ companyId, feature, stufe, actorId: auth.actorId }, "manueller Recherche-Lauf angestossen");
  return c.json({ angestossen: true, transactionId }, 200);
});

const LaufShape = z.object({
  id: z.string(), feature: Feature, stufe: Stufe,
  state: z.enum(["laufend", "fertig", "fehler", "unbekannt"]),
  ergebnisse: z.number().nullable(), fehler: z.string().nullable(),
  gestartetAt: z.string(), beendetAt: z.string().nullable(), eigener: z.boolean(),
});
const verlaufRoute = createRoute({
  method: "get", path: "/companies/{companyId}/research/verlauf", tags: [tag],
  summary: "Protokoll der manuellen Recherche-Laeufe zur Firma (Organisation), juengster zuerst",
  request: { params: Param },
  responses: { 200: { content: { "application/json": { schema: z.object({ items: z.array(LaufShape) }) } }, description: "ok" }, ...err },
});
companiesResearchRouter.openapi(verlaufRoute, async (c) => {
  const auth = c.get("auth") as AuthContext;
  const { companyId } = c.req.valid("param");
  const r = await getGatewayPool().query<{ id: string; actorId: string; feature: "jobs" | "expansion"; stufe: "standard" | "deep"; state: string; ergebnisse: number | null; fehler: string | null; gestartetAt: Date; beendetAt: Date | null }>(
    `SELECT id, "actorId", feature, stufe, state, ergebnisse, fehler, "gestartetAt", "beendetAt"
       FROM "CompanyResearchLauf" WHERE "tenantId" = $1 AND "companyId" = $2 ORDER BY "gestartetAt" DESC LIMIT 30`,
    [auth.tenantId, companyId],
  );
  const jetzt = Date.now();
  const items = r.rows.map((z0) => {
    const alt = z0.state === "laufend" && jetzt - new Date(z0.gestartetAt).getTime() > LAUF_STALE_MS;
    return {
      id: z0.id, feature: z0.feature, stufe: z0.stufe,
      state: (alt ? "unbekannt" : z0.state) as "laufend" | "fertig" | "fehler" | "unbekannt",
      ergebnisse: z0.ergebnisse, fehler: z0.fehler,
      gestartetAt: new Date(z0.gestartetAt).toISOString(), beendetAt: z0.beendetAt ? new Date(z0.beendetAt).toISOString() : null,
      eigener: z0.actorId === auth.actorId,
    };
  });
  return c.json({ items }, 200);
});

const standRoute = createRoute({
  method: "get", path: "/companies/{companyId}/research/stand", tags: [tag],
  summary: "Stand des Website-Producers zur Firma (fuer den Indikator des manuellen Recherche-Laufs)",
  request: { params: Param },
  responses: { 200: { content: { "application/json": { schema: z.object({ state: z.string().nullable(), updatedAt: z.string().nullable(), errorMessage: z.string().nullable() }) } }, description: "ok" }, ...err },
});
companiesResearchRouter.openapi(standRoute, async (c) => {
  const s = await websiteStand(c.req.valid("param").companyId);
  return c.json({ state: s?.state ?? null, updatedAt: s?.updatedAt ?? null, errorMessage: s?.errorMessage ?? null }, 200);
});

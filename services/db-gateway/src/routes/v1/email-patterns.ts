// M3 (docs/PLAN_EMAIL_MUSTER.md) — Server speichert nur, verarbeitet nicht:
//   GET/PUT /email-patterns/:domain        Adressmuster je Domain (geteilt)
//   POST /companies/:id/contacts/derived-email  abgeleitete Adresse (art: smtp = verifiziert,
//                                               catchall = Muster sicher, Adresse unbestaetigt)
//   POST /email-patterns/feedback          Bounce (deaktivieren) / Antwort (bestaetigen)
// Die Ableitung und die SMTP-Pruefung laufen lokal auf dem Geraet des Nutzers.

import { OpenAPIHono, createRoute, z } from "@hono/zod-openapi";
import { HTTPException } from "hono/http-exception";
import { requireScope } from "../../middleware/auth";
import { getGatewayPool, getProducerPool } from "../../lib/producer-pools";
import { getContactPrismaClient } from "../../lib/contact-prisma";
import { applyObservation, createObservationIdempotent } from "../../lib/contact-extraction/observation";
import { stampObservations } from "../../lib/person-compliance";
import { logger } from "../../lib/logger";
import { ErrorShape } from "./schemas";

export const emailPatternsRouter = new OpenAPIHono();
emailPatternsRouter.use("*", requireScope("company:read"));

const tag = "email-patterns";
const errorResponses = {
  400: { content: { "application/json": { schema: ErrorShape } }, description: "bad request" },
  401: { content: { "application/json": { schema: ErrorShape } }, description: "unauthenticated" },
  404: { content: { "application/json": { schema: ErrorShape } }, description: "not found" },
  409: { content: { "application/json": { schema: ErrorShape } }, description: "conflict" },
};

let schemaReady = false;
async function ensureSchema(): Promise<void> {
  if (schemaReady) return;
  await getGatewayPool().query(`CREATE TABLE IF NOT EXISTS "EmailPattern" (
    "domain" TEXT PRIMARY KEY,
    "muster" TEXT,
    "konfidenz" DOUBLE PRECISION NOT NULL DEFAULT 0,
    "belege" JSONB NOT NULL DEFAULT '[]'::jsonb,
    "catchAllAt" TIMESTAMPTZ,
    "checkedAt" TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    "checkedBy" TEXT,
    "tenantId" TEXT,
    "vorher" JSONB,
    "stats" JSONB NOT NULL DEFAULT '{}'::jsonb,
    "updatedAt" TIMESTAMPTZ NOT NULL DEFAULT NOW()
  )`);
  schemaReady = true;
}

const PatternShape = z
  .object({
    domain: z.string(),
    muster: z.string().nullable(),
    konfidenz: z.number(),
    belege: z.array(z.object({ fullName: z.string(), email: z.string() })),
    catchAllAt: z.string().nullable(),
    checkedAt: z.string(),
    checkedBy: z.string().nullable(),
    vorher: z.object({ muster: z.string().nullable(), bis: z.string() }).nullable(),
    stats: z.record(z.string(), z.unknown()),
  })
  .openapi("EmailPattern");

const domainParam = z.object({ domain: z.string().min(3).max(253).regex(/^[a-z0-9.-]+$/i) });

function rowToShape(r: Record<string, unknown>): z.infer<typeof PatternShape> {
  return {
    domain: String(r.domain),
    muster: (r.muster as string | null) ?? null,
    konfidenz: Number(r.konfidenz ?? 0),
    belege: (r.belege as Array<{ fullName: string; email: string }>) ?? [],
    catchAllAt: r.catchAllAt ? new Date(r.catchAllAt as string).toISOString() : null,
    checkedAt: new Date(r.checkedAt as string).toISOString(),
    checkedBy: (r.checkedBy as string | null) ?? null,
    vorher: (r.vorher as { muster: string | null; bis: string } | null) ?? null,
    stats: (r.stats as Record<string, unknown>) ?? {},
  };
}

const getRoute = createRoute({
  method: "get",
  path: "/email-patterns/{domain}",
  tags: [tag],
  summary: "Adressmuster einer Domain (geteilt)",
  request: { params: domainParam },
  responses: { 200: { content: { "application/json": { schema: PatternShape } }, description: "pattern" }, ...errorResponses },
});
emailPatternsRouter.openapi(getRoute, async (c) => {
  await ensureSchema();
  const { domain } = c.req.valid("param");
  const r = await getGatewayPool().query(`SELECT * FROM "EmailPattern" WHERE "domain" = $1`, [domain.toLowerCase()]);
  if (!r.rows[0]) throw new HTTPException(404, { message: "not_found" });
  return c.json(rowToShape(r.rows[0] as Record<string, unknown>), 200);
});

const putRoute = createRoute({
  method: "put",
  path: "/email-patterns/{domain}",
  tags: [tag],
  summary: "Adressmuster einer Domain speichern (lokal abgeleitet)",
  request: {
    params: domainParam,
    body: {
      content: {
        "application/json": {
          schema: z.object({
            muster: z.string().max(40).nullable(),
            konfidenz: z.number().min(0).max(1),
            belege: z.array(z.object({ fullName: z.string().max(200), email: z.string().max(200) })).max(20),
            catchAll: z.boolean().optional(),
            stats: z.record(z.string(), z.unknown()).optional(),
          }),
        },
      },
    },
  },
  responses: { 200: { content: { "application/json": { schema: PatternShape } }, description: "saved" }, ...errorResponses },
});
emailPatternsRouter.openapi(putRoute, async (c) => {
  await ensureSchema();
  const auth = c.get("auth") as { tenantId?: string; actorId?: string } | undefined;
  const { domain } = c.req.valid("param");
  const b = c.req.valid("json");
  const pool = getGatewayPool();
  const d = domain.toLowerCase();
  const alt = await pool.query(`SELECT "muster", "checkedAt" FROM "EmailPattern" WHERE "domain" = $1`, [d]);
  // Formatwechsel der Firma: altes Muster als "vorher" behalten (Operator 2026-09-10).
  const vorher = alt.rows[0] && alt.rows[0].muster && b.muster && alt.rows[0].muster !== b.muster ? { muster: alt.rows[0].muster as string, bis: new Date().toISOString() } : null;
  await pool.query(
    `INSERT INTO "EmailPattern" ("domain", "muster", "konfidenz", "belege", "catchAllAt", "checkedAt", "checkedBy", "tenantId", "vorher", "stats", "updatedAt")
     VALUES ($1, $2, $3, $4::jsonb, CASE WHEN $5 THEN NOW() ELSE NULL END, NOW(), $6, $7, $8::jsonb, $9::jsonb, NOW())
     ON CONFLICT ("domain") DO UPDATE SET "muster" = EXCLUDED."muster", "konfidenz" = EXCLUDED."konfidenz", "belege" = EXCLUDED."belege",
       "catchAllAt" = CASE WHEN $5 THEN NOW() ELSE NULL END, "checkedAt" = NOW(), "checkedBy" = EXCLUDED."checkedBy", "tenantId" = EXCLUDED."tenantId",
       "vorher" = COALESCE(EXCLUDED."vorher", "EmailPattern"."vorher"), "stats" = EXCLUDED."stats", "updatedAt" = NOW()`,
    [d, b.muster, b.konfidenz, JSON.stringify(b.belege), b.catchAll === true, auth?.actorId ?? null, auth?.tenantId ?? null, vorher ? JSON.stringify(vorher) : null, JSON.stringify(b.stats ?? {})],
  );
  const r = await pool.query(`SELECT * FROM "EmailPattern" WHERE "domain" = $1`, [d]);
  return c.json(rowToShape(r.rows[0] as Record<string, unknown>), 200);
});

const derivedRoute = createRoute({
  method: "post",
  path: "/companies/{companyId}/contacts/derived-email",
  tags: [tag],
  summary: "Abgeleitete E-Mail-Adresse einer Person speichern (smtp = verifiziert, catchall = unbestaetigt)",
  request: {
    params: z.object({ companyId: z.string().min(1) }),
    body: {
      content: {
        "application/json": {
          schema: z.object({
            personId: z.string().min(1),
            email: z.string().email().max(200),
            muster: z.string().max(40),
            beleg: z.string().email().max(200),
            mx: z.string().max(253).nullable().optional(),
            checkedAt: z.string().datetime().optional(),
            smtpCode: z.number().int().optional(),
            /** smtp (Standard): Existenz per RCPT TO belegt. catchall: Domain nimmt alles an,
             *  Adresse nur nach Muster gebildet — wird als "unbestaetigt" gespeichert. */
            art: z.enum(["smtp", "catchall"]).optional(),
            /** Anzahl personengebundener Belege fuer das Muster (Konfidenz bei catchall). */
            belegAnzahl: z.number().int().min(0).optional(),
          }),
        },
      },
    },
  },
  responses: {
    200: { content: { "application/json": { schema: z.object({ factId: z.string(), createdFact: z.boolean(), observationId: z.string() }) } }, description: "saved" },
    ...errorResponses,
  },
});
emailPatternsRouter.openapi(derivedRoute, async (c) => {
  const auth = c.get("auth") as { tenantId?: string; actorId?: string } | undefined;
  const { companyId } = c.req.valid("param");
  const b = c.req.valid("json");
  const email = b.email.toLowerCase().trim();
  const domain = email.split("@")[1] ?? "";
  if (domain !== (b.beleg.split("@")[1] ?? "").toLowerCase()) throw new HTTPException(400, { message: "domain_mismatch" });
  const pool = getProducerPool("company-contact");
  // Plausibilitaet: Person gehoert zur Firma, hat noch keine aktive E-Mail.
  const emp = await pool.query(`SELECT 1 FROM "Employment" WHERE "personId" = $1 AND "companyId" = $2 LIMIT 1`, [b.personId, companyId]);
  if (!emp.rows[0]) throw new HTTPException(404, { message: "person_not_in_company" });
  const vorhanden = await pool.query(`SELECT "value" FROM "Fact" WHERE "personId" = $1 AND "field" = 'email' AND "status" = 'ACTIVE' LIMIT 1`, [b.personId]);
  if (vorhanden.rows[0]) throw new HTTPException(409, { message: "email_exists", cause: vorhanden.rows[0].value });
  const prisma = getContactPrismaClient();
  const runId = `derived:${companyId}:${b.personId}:${Date.now()}`;
  const geprueft = b.checkedAt ?? new Date().toISOString();
  const art = b.art ?? "smtp";
  const source = art === "catchall" ? "pattern:catchall" : "pattern:smtp";
  const evidence =
    art === "catchall"
      ? `Abgeleitet nach Adressmuster ${b.muster} (${b.belegAnzahl ?? "?"} Belege, z. B. ${b.beleg}); geprueft am ${geprueft.slice(0, 10)}: Domain nimmt alle Adressen an (Catch-all${b.mx ? `, ${b.mx}` : ""}), Existenz daher nicht einzeln belegbar. Unbestaetigt; wird bei Antwort bestaetigt, bei Unzustellbarkeit entfernt.`
      : `Abgeleitet nach Adressmuster ${b.muster} (Beleg: ${b.beleg}); Existenz per SMTP geprueft am ${geprueft.slice(0, 10)}${b.mx ? ` (${b.mx}` : ""}${b.smtpCode ? `, Antwort ${b.smtpCode}` : ""}${b.mx ? ")" : ""}. Keine E-Mail zugestellt.`;
  // Konfidenz: SMTP-Beleg 0,9; Catch-all nach Beleglage 0,6 (2 Belege) / 0,75 (3+).
  const konfidenz = art === "catchall" ? ((b.belegAnzahl ?? 0) >= 3 ? 0.75 : 0.6) : 0.9;
  const obs = await createObservationIdempotent(prisma, {
    entityType: "PERSON",
    entityId: b.personId,
    companyId,
    personId: b.personId,
    field: "email",
    value: email,
    source,
    evidenceUrl: null,
    evidence,
    runId,
  });
  const applied = await applyObservation(prisma, {
    observationId: obs.id,
    entityType: "PERSON",
    entityId: b.personId,
    companyId,
    personId: b.personId,
    field: "email",
    value: email,
    normalized: obs.normalized,
    source,
    evidenceUrl: null,
    runId,
    policy: { multiValueFields: new Set(["email", "phone"]) },
  });
  await prisma.fact.update({ where: { id: applied.factId }, data: { confidence: konfidenz } }).catch(() => undefined);
  await stampObservations(pool, [obs.id], auth?.tenantId ?? null, auth?.actorId ?? null).catch(() => undefined);
  logger.info({ companyId, personId: b.personId, muster: b.muster, art, actorId: auth?.actorId }, "derived-email gespeichert");
  return c.json({ factId: applied.factId, createdFact: applied.createdFact, observationId: obs.id }, 200);
});

// ---- Rueckmeldung aus dem Postfach: Bounce entfernt, Antwort bestaetigt -------------
const feedbackRoute = createRoute({
  method: "post",
  path: "/email-patterns/feedback",
  tags: [tag],
  summary: "Rueckmeldung zu einer abgeleiteten Adresse: bounce = deaktivieren, antwort = bestaetigen",
  request: {
    body: {
      content: {
        "application/json": {
          schema: z.object({
            email: z.string().email().max(200),
            ergebnis: z.enum(["bounce", "antwort"]),
            /** Kurzer Kontext fuer den Herkunftstext (z. B. Betreff, Datum). */
            hinweis: z.string().max(300).optional(),
          }),
        },
      },
    },
  },
  responses: {
    200: {
      content: { "application/json": { schema: z.object({ gefunden: z.boolean(), aktion: z.enum(["deaktiviert", "bestaetigt", "keine"]), factId: z.string().nullable() }) } },
      description: "ok",
    },
    ...errorResponses,
  },
});
emailPatternsRouter.openapi(feedbackRoute, async (c) => {
  const auth = c.get("auth") as { tenantId?: string; actorId?: string } | undefined;
  const b = c.req.valid("json");
  const email = b.email.toLowerCase().trim();
  const pool = getProducerPool("company-contact");
  // Nur abgeleitete Adressen (Quelle pattern:*) — gefundene Adressen bleiben unangetastet.
  const r = await pool.query(
    `SELECT f."id", f."personId", f."companyId", o."source"
       FROM "Fact" f JOIN "Observation" o ON o."id" = f."lastObsId"
      WHERE f."field" = 'email' AND f."status" = 'ACTIVE' AND lower(f."value") = $1 AND o."source" LIKE 'pattern:%'
      LIMIT 1`,
    [email],
  );
  const row = r.rows[0] as { id: string; personId: string | null; companyId: string | null; source: string } | undefined;
  if (!row) return c.json({ gefunden: false, aktion: "keine" as const, factId: null }, 200);
  const prisma = getContactPrismaClient();
  if (b.ergebnis === "bounce") {
    await prisma.fact.update({ where: { id: row.id }, data: { status: "INACTIVE" } });
    logger.info({ factId: row.id, email, actorId: auth?.actorId }, "derived-email nach Bounce deaktiviert");
    return c.json({ gefunden: true, aktion: "deaktiviert" as const, factId: row.id }, 200);
  }
  if (row.source === "pattern:reply") return c.json({ gefunden: true, aktion: "keine" as const, factId: row.id }, 200);
  if (!row.personId) return c.json({ gefunden: true, aktion: "keine" as const, factId: row.id }, 200);
  const runId = `derived-reply:${row.personId}:${Date.now()}`;
  const obs = await createObservationIdempotent(prisma, {
    entityType: "PERSON",
    entityId: row.personId,
    companyId: row.companyId,
    personId: row.personId,
    field: "email",
    value: email,
    source: "pattern:reply",
    evidenceUrl: null,
    evidence: `Abgeleitete Adresse bestaetigt: Antwort von dieser Adresse eingegangen am ${new Date().toISOString().slice(0, 10)}${b.hinweis ? ` (${b.hinweis})` : ""}.`,
    runId,
  });
  const applied = await applyObservation(prisma, {
    observationId: obs.id,
    entityType: "PERSON",
    entityId: row.personId,
    companyId: row.companyId,
    personId: row.personId,
    field: "email",
    value: email,
    normalized: obs.normalized,
    source: "pattern:reply",
    evidenceUrl: null,
    runId,
    policy: { multiValueFields: new Set(["email", "phone"]) },
  });
  await prisma.fact.update({ where: { id: applied.factId }, data: { confidence: 0.95 } }).catch(() => undefined);
  await stampObservations(pool, [obs.id], auth?.tenantId ?? null, auth?.actorId ?? null).catch(() => undefined);
  logger.info({ factId: applied.factId, email, actorId: auth?.actorId }, "derived-email durch Antwort bestaetigt");
  return c.json({ gefunden: true, aktion: "bestaetigt" as const, factId: applied.factId }, 200);
});

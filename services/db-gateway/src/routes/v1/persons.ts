// C1 (docs/PLAN_COMPLIANCE_ENTERPRISE.md §1) — Personen: Herkunft, Loeschung, Art. 14.
//
//   GET    /v1/persons/{id}/herkunft?format=json|markdown   Herkunftsnachweis (Art. 15)
//   GET    /v1/persons/{id}/hinweis                          Art.-14-Hinweistext
//   POST   /v1/persons/{id}/informed {channel?}              „Informiert am" (je Tenant)
//   DELETE /v1/persons/{id} {reason?}                        globale Loeschung + Tombstone + Audit
//   POST   /v1/persons/suche {name, firma?, ort?, bereich?}  Kontaktsuche nach Name (PM-2026-0009)
//
// Loeschung: jeder angemeldete Tenant, der die Person erhoben hat; Altbestand
// ohne Zuordnung darf jeder angemeldete Tenant loeschen (Entscheidung
// 2026-09-03: Loeschung global).

import { OpenAPIHono, createRoute, z } from "@hono/zod-openapi";
import { HTTPException } from "hono/http-exception";
import { getGatewayPool, getProducerPool } from "../../lib/producer-pools";
import { getQuota } from "../../lib/quota";
import { DEFAULT_POLICY } from "../../lib/tenants";
import {
  personHerkunft,
  herkunftAlsMarkdown,
  art14Hinweis,
  deletePerson,
  setInformed,
  buyingCenterEinschaetzungen,
  DEFAULT_PERSON_RETENTION_DAYS,
} from "../../lib/person-compliance";
import { logger } from "../../lib/logger";
import { getContactPrismaClient } from "../../lib/contact-prisma";
import { applyObservation, createObservationIdempotent } from "../../lib/contact-extraction/observation";
import { stampObservations } from "../../lib/person-compliance";
import { firmenWebsite, passtZurFirma } from "../../lib/firmen-domain";
import { resolveCompanyNames } from "../../lib/company-names";
import { requireScope } from "../../middleware/auth";
import { bestandIds, orteAufloesen } from "./bestandssuche";

export const personsRouter = new OpenAPIHono();
const Id = z.object({ id: z.string().min(1).max(64) });

async function tenantName(tenantId: string): Promise<string | null> {
  const r = await getGatewayPool().query<{ name: string | null }>(`SELECT "name" FROM "Tenant" WHERE "id" = $1`, [tenantId]);
  return r.rows[0]?.name ?? null;
}
async function retentionDays(tenantId: string): Promise<number> {
  const r = await getGatewayPool().query<{ d: number | null }>(`SELECT "personRetentionDays" AS d FROM "TenantPolicy" WHERE "tenantId" = $1`, [tenantId]);
  return r.rows[0]?.d ?? DEFAULT_PERSON_RETENTION_DAYS;
}

personsRouter.openapi(
  createRoute({
    method: "get",
    path: "/persons/{id}/herkunft",
    tags: ["persons"],
    summary: "Herkunftsnachweis einer Person (Art. 15): Fakten, Beobachtungen mit Quelle/Beleg/Zeitpunkt/erhebendem Tenant.",
    request: { params: Id, query: z.object({ format: z.enum(["json", "markdown"]).default("json") }) },
    responses: { 200: { content: { "application/json": { schema: z.object({}).passthrough() } }, description: "ok" } },
  }),
  async (c) => {
    const { id } = c.req.valid("param");
    const { format } = c.req.valid("query");
    const b = await personHerkunft(getProducerPool("company-contact"), id);
    if (!b) throw new HTTPException(404, { message: "person_not_found" });
    // BC6 — die Einschaetzungen der anfragenden Organisation gehoeren in die Auskunft.
    b.einschaetzungen = await buyingCenterEinschaetzungen(getGatewayPool(), getProducerPool("company-contact"), { personId: id, tenantId: c.get("auth").tenantId });
    if (format === "markdown") {
      return c.text(herkunftAlsMarkdown(b, { tenantName: await tenantName(c.get("auth").tenantId) }), 200, { "content-type": "text/markdown; charset=utf-8" }) as never;
    }
    return c.json(b as unknown as Record<string, unknown>);
  },
);

personsRouter.openapi(
  createRoute({
    method: "get",
    path: "/persons/{id}/hinweis",
    tags: ["persons"],
    summary: "Vorformulierter Hinweistext nach Art. 14 DSGVO fuer diese Person.",
    request: { params: Id, query: z.object({ kontaktEmail: z.string().max(200).optional() }) },
    responses: { 200: { content: { "application/json": { schema: z.object({ text: z.string() }) } }, description: "ok" } },
  }),
  async (c) => {
    const { id } = c.req.valid("param");
    const { kontaktEmail } = c.req.valid("query");
    const auth = c.get("auth");
    const b = await personHerkunft(getProducerPool("company-contact"), id);
    if (!b) throw new HTTPException(404, { message: "person_not_found" });
    b.einschaetzungen = await buyingCenterEinschaetzungen(getGatewayPool(), getProducerPool("company-contact"), { personId: id, tenantId: auth.tenantId });
    const org = (await tenantName(auth.tenantId)) ?? auth.email ?? "die verantwortliche Organisation";
    return c.json({ text: art14Hinweis(b, { organisation: org, kontaktEmail: kontaktEmail ?? auth.email ?? null, retentionDays: await retentionDays(auth.tenantId) }) });
  },
);

personsRouter.openapi(
  createRoute({
    method: "post",
    path: "/persons/{id}/informed",
    tags: ["persons"],
    summary: "Informiert-am setzen (Art. 14) — je Tenant und Person.",
    request: { params: Id, body: { content: { "application/json": { schema: z.object({ channel: z.string().max(60).optional() }) } }, required: false } },
    responses: { 200: { content: { "application/json": { schema: z.object({ ok: z.literal(true) }) } }, description: "gesetzt" } },
  }),
  async (c) => {
    const { id } = c.req.valid("param");
    const body = (await c.req.json().catch(() => ({}))) as { channel?: string };
    const auth = c.get("auth");
    await setInformed(getProducerPool("company-contact"), { personId: id, tenantId: auth.tenantId, actorId: auth.actorId, channel: body?.channel ?? null });
    return c.json({ ok: true as const });
  },
);

// 2026-10-21 — Nutzer kennt die richtige Adresse (Befund eproX: jrafflenbeul statt
// joyce.rafflenbeul). Die Angabe wird Fakt mit Quelle user:angabe (0,95) und ersetzt
// abgeleitete/zugeordnete Adressen dieser Person in dieser Firma; als Beleg lernt die
// naechste Ableitung daraus das Muster der Domain fuer die uebrigen Personen.
personsRouter.openapi(
  createRoute({
    method: "post",
    path: "/persons/{id}/email",
    tags: ["persons"],
    summary: "E-Mail-Adresse einer Person vom Nutzer setzen (ersetzt abgeleitete Adressen, wird Beleg fuer das Muster)",
    request: {
      params: Id,
      body: { content: { "application/json": { schema: z.object({ companyId: z.string().min(1).max(120), email: z.string().email().max(200), hinweis: z.string().max(300).optional() }) } } },
    },
    responses: {
      200: { content: { "application/json": { schema: z.object({ factId: z.string(), ersetzt: z.array(z.string()), domainPasst: z.boolean().nullable() }) } }, description: "gesetzt" },
      404: { content: { "application/json": { schema: z.object({}).passthrough() } }, description: "Person nicht in der Firma" },
    },
  }),
  async (c) => {
    const { id } = c.req.valid("param");
    const b = c.req.valid("json");
    const auth = c.get("auth");
    const email = b.email.toLowerCase().trim();
    const pool = getProducerPool("company-contact");
    const emp = await pool.query(`SELECT 1 FROM "Employment" WHERE "personId" = $1 AND "companyId" = $2 LIMIT 1`, [id, b.companyId]);
    if (!emp.rows[0]) throw new HTTPException(404, { message: "person_not_in_company" });
    const firma = await pool.query<{ websiteUrl: string | null }>(`SELECT "websiteUrl" FROM "Company" WHERE id = $1 LIMIT 1`, [b.companyId]);
    const domainPasst = passtZurFirma(email, await firmenWebsite(b.companyId, firma.rows[0]?.websiteUrl));
    // Abgeleitete und zugeordnete Adressen dieser Person in dieser Firma weichen der Angabe.
    const ersetzt = await pool.query<{ id: string; value: string }>(
      `UPDATE "Fact" f SET "status" = 'INACTIVE', "deactivatedAt" = now(), "deactivatedReason" = 'nutzer-angabe'
         FROM "Observation" o
        WHERE o."id" = f."lastObsId" AND f."personId" = $1 AND f."field" = 'email' AND f."status" = 'ACTIVE'
          AND f."scopeCompanyId" = $2 AND lower(f."value") <> $3 AND o."source" ~ '^(pattern|zuordnung):'
        RETURNING f."id", f."value"`,
      [id, b.companyId, email],
    );
    const prisma = getContactPrismaClient();
    const runId = `user-email:${b.companyId}:${id}:${Date.now()}`;
    const source = "user:angabe";
    const evidence = `Vom Nutzer angegeben am ${new Date().toISOString().slice(0, 10)}${b.hinweis ? ` (${b.hinweis})` : ""}. Ersetzt ${ersetzt.rowCount ?? 0} abgeleitete Adresse(n).`;
    const obs = await createObservationIdempotent(prisma, { entityType: "PERSON", entityId: id, companyId: b.companyId, personId: id, field: "email", value: email, source, evidenceUrl: null, evidence, runId });
    const applied = await applyObservation(prisma, { observationId: obs.id, entityType: "PERSON", entityId: id, companyId: b.companyId, personId: id, field: "email", value: email, normalized: obs.normalized, source, evidenceUrl: null, runId, policy: { multiValueFields: new Set(["email", "phone"]) } });
    await prisma.fact.update({ where: { id: applied.factId }, data: { confidence: 0.95, status: "ACTIVE", deactivatedAt: null, deactivatedReason: null } }).catch(() => undefined);
    await stampObservations(pool, [obs.id], auth.tenantId ?? null, auth.actorId ?? null).catch(() => undefined);
    logger.info({ personId: id, companyId: b.companyId, ersetzt: ersetzt.rowCount, domainPasst, actorId: auth.actorId }, "person email vom Nutzer gesetzt");
    return c.json({ factId: applied.factId, ersetzt: ersetzt.rows.map((r) => r.value), domainPasst }, 200);
  },
);

personsRouter.openapi(
  createRoute({
    method: "delete",
    path: "/persons/{id}",
    tags: ["persons"],
    summary: "Person global loeschen (Tombstone sperrt Wiedererfassung), Audit-Eintrag.",
    request: { params: Id, body: { content: { "application/json": { schema: z.object({ reason: z.string().max(500).optional() }) } }, required: false } },
    responses: { 200: { content: { "application/json": { schema: z.object({}).passthrough() } }, description: "geloescht" } },
  }),
  async (c) => {
    const { id } = c.req.valid("param");
    const body = (await c.req.json().catch(() => ({}))) as { reason?: string };
    const auth = c.get("auth");
    const pool = getProducerPool("company-contact");
    const b = await personHerkunft(pool, id);
    if (!b) throw new HTTPException(404, { message: "person_not_found" });
    if (b.erhebendeTenants.length > 0 && !b.erhebendeTenants.includes(auth.tenantId)) {
      throw new HTTPException(403, { message: "Nur eine Organisation, die diese Person erhoben hat, darf sie loeschen." });
    }
    const r = await deletePerson(pool, { personId: id, tenantId: auth.tenantId, actorId: auth.actorId, reason: body?.reason ?? null });
    // BC6 — die Loeschung ist global, also auch hier: Ein Buying-Center-
    // Mitglied traegt Name und Einschaetzungen der Person. Kanten haengen
    // nicht per Fremdschluessel am Mitglied, deshalb zuerst sie.
    try {
      const g = getGatewayPool();
      const mids = (await g.query<{ id: string }>(`SELECT "id" FROM "BuyingCenterMitglied" WHERE "personId" = $1`, [id])).rows.map((x) => x.id);
      if (mids.length > 0) {
        await g.query(`DELETE FROM "BuyingCenterKante" WHERE "vonMitgliedId" = ANY($1::text[]) OR "nachMitgliedId" = ANY($1::text[])`, [mids]);
        await g.query(`DELETE FROM "BuyingCenterMitglied" WHERE "id" = ANY($1::text[])`, [mids]);
      }
    } catch (err) {
      logger.warn({ err: err instanceof Error ? err.message : String(err), personId: id }, "buying-center cleanup after person delete failed");
    }
    try {
      await getGatewayPool().query(
        `INSERT INTO "AuditLog" ("tenantId", "actorId", "method", "path", "statusCode", "requestId", "durationMs", "errorMessage")
         VALUES ($1, $2, 'DELETE', $3, 200, $4, 0, $5)`,
        [auth.tenantId, auth.actorId, `/v1/persons/${id}`, c.get("requestId") ?? "person-delete", `person.delete name=${r.fullName ?? "?"} tombstones=${r.tombstones}${body?.reason ? ` reason=${body.reason.slice(0, 200)}` : ""}`],
      );
    } catch (err) {
      logger.warn({ err: err instanceof Error ? err.message : String(err) }, "audit insert for person delete failed");
    }
    void getQuota; void DEFAULT_POLICY;
    return c.json({ ok: true, ...r });
  },
);

// ---- Kontaktsuche nach Name (PM-2026-0009) ---------------------------------------
// "E-Mail von Fabian Toelle bei Brinkmann in Lemgo": bisher brauchte jeder Kontaktweg
// zuerst eine Firma. Bestand = eigene Firmen mit Rolle und E-Mail samt Herkunft.
// Pool = Firmen ausserhalb des Bestands, bewusst arm wie die Pool-Bestandssuche
// (Name, Firma, Ort; Rolle und Adresse erst nach Aufnahme der Firma).

const POOL_MAX = 5;

/** Schreibweisen je Namensteil: Tölle ~ Toelle ~ Tolle. */
function namensVarianten(teil: string): string[] {
  const t = teil.toLowerCase();
  const aus = t.replace(/ä/g, "ae").replace(/ö/g, "oe").replace(/ü/g, "ue").replace(/ß/g, "ss");
  const ohne = t.normalize("NFD").replace(/[̀-ͯ]/g, "").replace(/ß/g, "ss");
  const ein = t.replace(/ae/g, "ä").replace(/oe/g, "ö").replace(/ue/g, "ü");
  return [...new Set([t, aus, ohne, ein])].map((v) => `%${v.replace(/[%_\\]/g, (m) => `\\${m}`)}%`);
}

personsRouter.use("/persons/suche", requireScope("company:read"));
personsRouter.openapi(
  createRoute({
    method: "post",
    path: "/persons/suche",
    tags: ["persons"],
    summary: "Ansprechpartner nach Name suchen, firmenuebergreifend (Bestand mit E-Mail und Herkunft; Pool nur Name/Firma/Ort).",
    request: {
      body: {
        content: {
          "application/json": {
            schema: z.object({
              name: z.string().trim().min(2).max(120),
              firma: z.string().trim().max(120).optional(),
              ort: z.string().trim().max(80).optional(),
              bereich: z.enum(["bestand", "pool"]).default("bestand"),
              limit: z.number().int().min(1).max(10).default(5),
            }),
          },
        },
      },
    },
    responses: { 200: { content: { "application/json": { schema: z.object({}).passthrough() } }, description: "ok" } },
  }),
  async (c) => {
    const auth = c.get("auth") as { tenantId?: string | null; actorId?: string | null } | undefined;
    if (!auth?.actorId) throw new HTTPException(401, { message: "auth_context_missing" });
    const body = c.req.valid("json");
    const pool = body.bereich === "pool";
    const limit = pool ? Math.min(body.limit, POOL_MAX) : body.limit;
    const teile = body.name.split(/\s+/).map((t) => t.replace(/[.,;()"']/g, "")).filter((t) => t.length >= 2).slice(0, 4);
    if (teile.length === 0) throw new HTTPException(400, { message: "name_zu_kurz" });
    const ids = await bestandIds(auth.actorId);
    if (!pool && ids.length === 0) return c.json({ bereich: body.bereich, anzahl: 0, bestand: 0, treffer: [] }, 200);

    const params: unknown[] = [];
    const p = (v: unknown) => {
      params.push(v);
      return `$${params.length}`;
    };
    const bedingungen = teile.map((t) => `p."fullName" ILIKE ANY(${p(namensVarianten(t))}::text[])`);
    bedingungen.push(pool ? `NOT (e."companyId" = ANY(${p(ids)}::text[]))` : `e."companyId" = ANY(${p(ids)}::text[])`);
    if (body.firma) bedingungen.push(`c."name" ILIKE ANY(${p(namensVarianten(body.firma))}::text[])`);
    const contact = getProducerPool("company-contact");
    const roh = await contact.query<{ personId: string; fullName: string; companyId: string; title: string | null; firma: string | null }>(
      `SELECT p.id AS "personId", p."fullName", e."companyId", e."title", c."name" AS firma
         FROM "Person" p
         JOIN "Employment" e ON e."personId" = p.id AND e."isCurrent"
         LEFT JOIN "Company" c ON c.id = e."companyId"
        WHERE ${bedingungen.join(" AND ")}
        ORDER BY (lower(p."fullName") = lower(${p(body.name)})) DESC, p."fullName"
        LIMIT 100`,
      params,
    );
    // Je Person+Firma einmal (mehrere Rollen-Zeilen)
    const gesehen = new Set<string>();
    let zeilen = roh.rows.filter((r) => {
      const k = `${r.personId}|${r.companyId}`;
      if (gesehen.has(k)) return false;
      gesehen.add(k);
      return true;
    });
    const firmenIds = [...new Set(zeilen.map((r) => r.companyId))];
    const [orte, namen] = await Promise.all([orteAufloesen(firmenIds), resolveCompanyNames(getGatewayPool(), firmenIds)]);
    if (body.ort) {
      const o = body.ort.toLowerCase();
      zeilen = zeilen.filter((r) => (orte.get(r.companyId) ?? "").toLowerCase().includes(o));
    }
    const gesamt = zeilen.length;
    zeilen = zeilen.slice(0, limit);

    if (pool) {
      return c.json({
        bereich: "pool",
        anzahl: zeilen.length,
        gesamt,
        hinweis: "Firmen ausserhalb des Bestands: Rolle und E-Mail erst nach Aufnahme der Firma (import_companies mit companyId).",
        treffer: zeilen.map((r) => ({ name: r.fullName, companyId: r.companyId, firma: namen.get(r.companyId) ?? r.firma, ort: orte.get(r.companyId) ?? null })),
      }, 200);
    }

    // E-Mail je Person und Firma: nur Adressen dieser Firma, keine abgelehnten Ableitungen.
    const mails = zeilen.length
      ? await contact.query<{ personId: string; value: string; confidence: number | null; scopeCompanyId: string; source: string | null }>(
          `SELECT f."personId", f."value", f."confidence", f."scopeCompanyId", o."source"
             FROM "Fact" f LEFT JOIN "Observation" o ON o.id = f."lastObsId"
            WHERE f."personId" = ANY($1::text[]) AND f."field" = 'email' AND f."status" = 'ACTIVE' AND f."entityType" = 'PERSON'`,
          [zeilen.map((r) => r.personId)],
        )
      : { rows: [] };
    return c.json({
      bereich: "bestand",
      anzahl: zeilen.length,
      gesamt,
      bestand: ids.length,
      treffer: zeilen.map((r) => {
        const kandidaten = mails.rows
          .filter((m) => m.personId === r.personId && (m.scopeCompanyId === r.companyId || m.scopeCompanyId === ""))
          .filter((m) => !/^(pattern|zuordnung):abgelehnt$/.test(m.source ?? ""))
          .sort((a, b) => (b.confidence ?? 0) - (a.confidence ?? 0));
        const m = kandidaten[0];
        return {
          personId: r.personId,
          name: r.fullName,
          rolle: r.title,
          companyId: r.companyId,
          firma: namen.get(r.companyId) ?? r.firma,
          ort: orte.get(r.companyId) ?? null,
          email: m?.value ?? null,
          emailQuelle: m?.source ?? null,
          emailKonfidenz: m?.confidence ?? null,
          emailAbgeleitet: !!m && /^(pattern|zuordnung):/.test(m.source ?? ""),
        };
      }),
    }, 200);
  },
);

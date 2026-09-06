// C1 (docs/PLAN_COMPLIANCE_ENTERPRISE.md §1) — Personen: Herkunft, Loeschung, Art. 14.
//
//   GET    /v1/persons/{id}/herkunft?format=json|markdown   Herkunftsnachweis (Art. 15)
//   GET    /v1/persons/{id}/hinweis                          Art.-14-Hinweistext
//   POST   /v1/persons/{id}/informed {channel?}              „Informiert am" (je Tenant)
//   DELETE /v1/persons/{id} {reason?}                        globale Loeschung + Tombstone + Audit
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
  DEFAULT_PERSON_RETENTION_DAYS,
} from "../../lib/person-compliance";
import { logger } from "../../lib/logger";

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

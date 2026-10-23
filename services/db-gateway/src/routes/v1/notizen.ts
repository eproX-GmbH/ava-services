// C1 (docs/PLAN_COPILOT_MCP.md): Gespraechsprotokolle und Hinweise je Firma,
// abgelegt von externen Agenten (Copilot, Claude) oder Mitgliedern. Sichtbar fuer
// die Organisation; loeschen darf der Verfasser oder ein Admin.
//
//   GET    /v1/companies/{companyId}/notizen
//   POST   /v1/companies/{companyId}/notizen   { text, personId?, datum?, quelle? }
//   DELETE /v1/notizen/{id}

import { OpenAPIHono, createRoute, z } from "@hono/zod-openapi";
import { HTTPException } from "hono/http-exception";
import { getGatewayPool } from "../../lib/producer-pools";
import { ErrorShape } from "./schemas";

export const notizenRouter = new OpenAPIHono();

const NotizShape = z.object({
  id: z.string(),
  companyId: z.string(),
  personId: z.string().nullable(),
  text: z.string(),
  quelle: z.string(),
  datum: z.string().nullable(),
  createdAt: z.string(),
  actorId: z.string(),
  verfasser: z.string().nullable(),
});

const QUELLEN = ["copilot", "claude", "chatgpt", "mcp", "app"] as const;

function zeile(r: { id: string; companyId: string; personId: string | null; text: string; quelle: string; datum: Date | null; createdAt: Date; actorId: string; verfasser: string | null }) {
  return { id: r.id, companyId: r.companyId, personId: r.personId, text: r.text, quelle: r.quelle, datum: r.datum ? r.datum.toISOString() : null, createdAt: r.createdAt.toISOString(), actorId: r.actorId, verfasser: r.verfasser };
}

notizenRouter.openapi(
  createRoute({
    method: "get",
    path: "/companies/{companyId}/notizen",
    tags: ["notizen"],
    summary: "Notizen und Gespraechsprotokolle der Organisation zu einer Firma (neueste zuerst).",
    request: { params: z.object({ companyId: z.string().min(1) }), query: z.object({ limit: z.coerce.number().int().min(1).max(200).default(50) }) },
    responses: { 200: { content: { "application/json": { schema: z.object({ items: z.array(NotizShape) }) } }, description: "ok" } },
  }),
  async (c) => {
    const auth = c.get("auth");
    const { companyId } = c.req.valid("param");
    const { limit } = c.req.valid("query");
    const r = await getGatewayPool().query(
      `SELECT n.*, m."name" AS "verfasser" FROM "CompanyNotiz" n
         LEFT JOIN "TenantMember" m ON m."actorId" = n."actorId"
        WHERE n."tenantId" = $1 AND n."companyId" = $2
        ORDER BY COALESCE(n."datum", n."createdAt") DESC LIMIT $3`,
      [auth.tenantId, companyId, limit],
    );
    return c.json({ items: r.rows.map(zeile) }, 200);
  },
);

notizenRouter.openapi(
  createRoute({
    method: "post",
    path: "/companies/{companyId}/notizen",
    tags: ["notizen"],
    summary: "Notiz oder Gespraechsprotokoll zu einer Firma ablegen (optional zu einer Person).",
    request: {
      params: z.object({ companyId: z.string().min(1) }),
      body: {
        content: {
          "application/json": {
            schema: z.object({
              text: z.string().trim().min(3).max(20_000),
              personId: z.string().trim().min(1).optional(),
              datum: z.string().datetime({ offset: true }).optional(),
              quelle: z.enum(QUELLEN).default("app"),
            }),
          },
        },
      },
    },
    responses: { 200: { content: { "application/json": { schema: NotizShape } }, description: "abgelegt" }, 400: { content: { "application/json": { schema: ErrorShape } }, description: "ungueltig" } },
  }),
  async (c) => {
    const auth = c.get("auth");
    const { companyId } = c.req.valid("param");
    const b = c.req.valid("json");
    const r = await getGatewayPool().query(
      `INSERT INTO "CompanyNotiz" ("id", "tenantId", "actorId", "companyId", "personId", "text", "quelle", "datum")
       VALUES ('n_' || substr(md5(random()::text || clock_timestamp()::text), 1, 22), $1, $2, $3, $4, $5, $6, $7)
       RETURNING *, (SELECT "name" FROM "TenantMember" WHERE "actorId" = $2) AS "verfasser"`,
      [auth.tenantId, auth.actorId, companyId, b.personId ?? null, b.text, b.quelle, b.datum ? new Date(b.datum) : null],
    );
    return c.json(zeile(r.rows[0]), 200);
  },
);

notizenRouter.openapi(
  createRoute({
    method: "delete",
    path: "/notizen/{id}",
    tags: ["notizen"],
    summary: "Notiz loeschen (Verfasser oder Admin).",
    request: { params: z.object({ id: z.string().min(1) }) },
    responses: { 200: { content: { "application/json": { schema: z.object({ ok: z.literal(true) }) } }, description: "geloescht" } },
  }),
  async (c) => {
    const auth = c.get("auth");
    const { id } = c.req.valid("param");
    const pool = getGatewayPool();
    const rolle = await pool.query<{ role: string }>(`SELECT "role" FROM "TenantMember" WHERE "tenantId" = $1 AND "actorId" = $2`, [auth.tenantId, auth.actorId]);
    const admin = rolle.rows[0]?.role === "owner" || rolle.rows[0]?.role === "admin";
    const r = await pool.query(`DELETE FROM "CompanyNotiz" WHERE "id" = $1 AND "tenantId" = $2 AND ($3 OR "actorId" = $4)`, [id, auth.tenantId, admin, auth.actorId]);
    if ((r.rowCount ?? 0) === 0) throw new HTTPException(404, { message: "Notiz nicht gefunden oder keine Berechtigung." });
    return c.json({ ok: true as const }, 200);
  },
);

// O1 (docs/PLAN_ORGANISATIONEN.md) — Organisationen.
//
//   POST   /v1/tenants                       Organisation anlegen (Aufrufer = Owner)
//   POST   /v1/tenants/join                  Beitritt per Einladungslink anfragen
//   GET    /v1/tenants/me                    Zustand (Mitglieder, Anfragen, Vorgaben)
//   POST   /v1/tenants/me/requests/{id}      Anfrage annehmen/ablehnen (Admin)
//   DELETE /v1/tenants/me/members/{actorId}  Mitglied entfernen (Admin) / austreten
//   PATCH  /v1/tenants/me/members/{actorId}  Rolle setzen (Owner)
//   PUT    /v1/tenants/me/policy             Vorgaben (Admin)
//   POST   /v1/tenants/me/invite             Einladungslink erneuern (Admin)
//
// Rollen sind Gateway-Wahrheit (TenantMember.role); Keycloak-Gruppen
// werden nach dem Commit best-effort nachgezogen (Claim tenant_id).

import { OpenAPIHono, createRoute, z } from "@hono/zod-openapi";
import { HTTPException } from "hono/http-exception";
import { getGatewayPool } from "../../lib/producer-pools";
import { createShare, listShares, revokeShare, markShare } from "../../lib/org-shares";
import { callUpstream } from "../../lib/upstream";
import {
  createOrganisation,
  requestJoin,
  getOrgState,
  decideJoinRequest,
  removeMember,
  setMemberRole,
  setPolicy,
  rotateInvite,
  TenantError,
} from "../../lib/tenants";

export const tenantsRouter = new OpenAPIHono();

const Err = z.object({ error: z.string(), message: z.string().optional() });
const Ok = z.object({ ok: z.literal(true) }).passthrough();

function wrap<T>(fn: () => Promise<T>): Promise<T> {
  return fn().catch((err: unknown) => {
    if (err instanceof TenantError) throw new HTTPException(err.status, { message: err.message });
    throw err;
  });
}

const PolicyShape = z.object({
  features: z.record(z.string(), z.boolean()).optional(),
  providerLock: z.boolean().optional(),
  chatModel: z.string().max(120).nullable().optional(),
  producerModel: z.string().max(120).nullable().optional(),
  promptAudit: z.boolean().optional(),
});

tenantsRouter.openapi(
  createRoute({
    method: "post",
    path: "/tenants",
    tags: ["tenants"],
    summary: "Organisation anlegen; der Aufrufer wird Owner.",
    request: { body: { content: { "application/json": { schema: z.object({ name: z.string().min(2).max(120) }) } } } },
    responses: {
      201: { content: { "application/json": { schema: Ok } }, description: "angelegt" },
      409: { content: { "application/json": { schema: Err } }, description: "bereits in einer Organisation" },
    },
  }),
  async (c) => {
    const auth = c.get("auth");
    const { name } = c.req.valid("json");
    const r = await wrap(() => createOrganisation(getGatewayPool(), auth, name.trim()));
    return c.json({ ok: true as const, ...r }, 201);
  },
);

tenantsRouter.openapi(
  createRoute({
    method: "post",
    path: "/tenants/join",
    tags: ["tenants"],
    summary: "Beitritt per Einladungslink anfragen (wirkt erst nach Admin-Freigabe).",
    request: { body: { content: { "application/json": { schema: z.object({ inviteToken: z.string().min(8).max(64) }) } } } },
    responses: {
      201: { content: { "application/json": { schema: Ok } }, description: "Anfrage offen" },
      404: { content: { "application/json": { schema: Err } }, description: "Link ungueltig" },
    },
  }),
  async (c) => {
    const auth = c.get("auth");
    const { inviteToken } = c.req.valid("json");
    const r = await wrap(() => requestJoin(getGatewayPool(), auth, inviteToken));
    return c.json({ ok: true as const, ...r }, 201);
  },
);

tenantsRouter.openapi(
  createRoute({
    method: "get",
    path: "/tenants/me",
    tags: ["tenants"],
    summary: "Zustand der eigenen Organisation (Mitglieder, offene Anfragen, Vorgaben).",
    responses: { 200: { content: { "application/json": { schema: z.object({}).passthrough() } }, description: "ok" } },
  }),
  async (c) => c.json(await wrap(() => getOrgState(getGatewayPool(), c.get("auth")))),
);

tenantsRouter.openapi(
  createRoute({
    method: "post",
    path: "/tenants/me/requests/{id}",
    tags: ["tenants"],
    summary: "Beitrittsanfrage annehmen oder ablehnen (Admin).",
    request: {
      params: z.object({ id: z.string().min(4).max(64) }),
      body: { content: { "application/json": { schema: z.object({ entscheidung: z.enum(["approve", "reject"]) }) } } },
    },
    responses: { 200: { content: { "application/json": { schema: Ok } }, description: "entschieden" } },
  }),
  async (c) => {
    const { id } = c.req.valid("param");
    const { entscheidung } = c.req.valid("json");
    const r = await wrap(() => decideJoinRequest(getGatewayPool(), c.get("auth"), id, entscheidung));
    return c.json({ ok: true as const, ...r });
  },
);

tenantsRouter.openapi(
  createRoute({
    method: "delete",
    path: "/tenants/me/members/{actorId}",
    tags: ["tenants"],
    summary: "Mitglied entfernen (Admin) oder selbst austreten → persoenlicher Tenant.",
    request: { params: z.object({ actorId: z.string().min(4).max(128) }) },
    responses: { 200: { content: { "application/json": { schema: Ok } }, description: "entfernt" } },
  }),
  async (c) => {
    const { actorId } = c.req.valid("param");
    await wrap(() => removeMember(getGatewayPool(), c.get("auth"), actorId));
    return c.json({ ok: true as const });
  },
);

tenantsRouter.openapi(
  createRoute({
    method: "patch",
    path: "/tenants/me/members/{actorId}",
    tags: ["tenants"],
    summary: "Rolle eines Mitglieds setzen (Owner).",
    request: {
      params: z.object({ actorId: z.string().min(4).max(128) }),
      body: { content: { "application/json": { schema: z.object({ role: z.enum(["owner", "admin", "member"]) }) } } },
    },
    responses: { 200: { content: { "application/json": { schema: Ok } }, description: "gesetzt" } },
  }),
  async (c) => {
    const { actorId } = c.req.valid("param");
    const { role } = c.req.valid("json");
    await wrap(() => setMemberRole(getGatewayPool(), c.get("auth"), actorId, role));
    return c.json({ ok: true as const });
  },
);

tenantsRouter.openapi(
  createRoute({
    method: "put",
    path: "/tenants/me/policy",
    tags: ["tenants"],
    summary: "Vorgaben der Organisation setzen (Admin): Funktionen, Anbieter-Sperre, Modelle, Prompt-Audit.",
    request: { body: { content: { "application/json": { schema: PolicyShape } } } },
    responses: { 200: { content: { "application/json": { schema: z.object({}).passthrough() } }, description: "gesetzt" } },
  }),
  async (c) => c.json(await wrap(() => setPolicy(getGatewayPool(), c.get("auth"), c.req.valid("json")))),
);

tenantsRouter.openapi(
  createRoute({
    method: "post",
    path: "/tenants/me/invite",
    tags: ["tenants"],
    summary: "Einladungslink erneuern (Admin); alte Links werden ungueltig.",
    responses: { 200: { content: { "application/json": { schema: Ok } }, description: "erneuert" } },
  }),
  async (c) => {
    const inviteToken = await wrap(() => rotateInvite(getGatewayPool(), c.get("auth")));
    return c.json({ ok: true as const, inviteToken });
  },
);


// ---- O8 — Freigaben (Transaktionen, Radar-Firmen) ---------------------------

const ShareKind = z.enum(["transaction", "radar_company"]);

tenantsRouter.openapi(
  createRoute({
    method: "post",
    path: "/tenants/me/shares",
    tags: ["tenants"],
    summary: "Mit der Organisation teilen (Transaktion: nur der Eigentuemer).",
    request: {
      body: { content: { "application/json": { schema: z.object({ kind: ShareKind, refId: z.string().min(1).max(200), note: z.string().max(500).optional() }) } } },
    },
    responses: { 201: { content: { "application/json": { schema: z.object({}).passthrough() } }, description: "geteilt" } },
  }),
  async (c) => {
    const auth = c.get("auth");
    const { kind, refId, note } = c.req.valid("json");
    if (kind === "transaction") {
      const t = await callUpstream<{ userId?: string }>(c, "masterData", `/api/v1/transactions/${encodeURIComponent(refId)}`).catch(() => null);
      if (!t) throw new HTTPException(404, { message: "transaction_not_found" });
      if (t.userId && t.userId !== auth.actorId) throw new HTTPException(403, { message: "Nur der Eigentuemer kann eine Transaktion teilen." });
    }
    const row = await wrap(() => createShare(getGatewayPool(), auth, kind, refId, note ?? null));
    return c.json({ ok: true as const, share: row }, 201);
  },
);

tenantsRouter.openapi(
  createRoute({
    method: "get",
    path: "/tenants/me/shares",
    tags: ["tenants"],
    summary: "Freigaben der Organisation (optional nur ungesehene).",
    request: { query: z.object({ kind: ShareKind.optional(), unseen: z.coerce.number().int().min(0).max(1).default(0), includeDismissed: z.coerce.number().int().min(0).max(1).default(0) }) },
    responses: { 200: { content: { "application/json": { schema: z.object({}).passthrough() } }, description: "ok" } },
  }),
  async (c) => {
    const { kind, unseen, includeDismissed } = c.req.valid("query");
    const items = await listShares(getGatewayPool(), c.get("auth"), { kind, unseenOnly: unseen === 1, includeDismissed: includeDismissed === 1 });
    return c.json({ items });
  },
);

tenantsRouter.openapi(
  createRoute({
    method: "delete",
    path: "/tenants/me/shares/{id}",
    tags: ["tenants"],
    summary: "Freigabe zuruecknehmen (Teilender oder Admin); bereits uebernommene Kopien bleiben.",
    request: { params: z.object({ id: z.string().min(1).max(64) }) },
    responses: { 200: { content: { "application/json": { schema: Ok } }, description: "zurueckgenommen" } },
  }),
  async (c) => {
    const { id } = c.req.valid("param");
    await wrap(() => revokeShare(getGatewayPool(), c.get("auth"), id));
    return c.json({ ok: true as const });
  },
);

tenantsRouter.openapi(
  createRoute({
    method: "post",
    path: "/tenants/me/shares/{id}/{was}",
    tags: ["tenants"],
    summary: "Freigabe als gesehen markieren oder ausblenden (nur fuer mich).",
    request: { params: z.object({ id: z.string().min(1).max(64), was: z.enum(["seen", "dismiss"]) }) },
    responses: { 200: { content: { "application/json": { schema: Ok } }, description: "markiert" } },
  }),
  async (c) => {
    const { id, was } = c.req.valid("param");
    await wrap(() => markShare(getGatewayPool(), c.get("auth"), id, was));
    return c.json({ ok: true as const });
  },
);

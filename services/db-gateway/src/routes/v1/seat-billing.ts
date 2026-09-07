// B2 (docs/PLAN_ABRECHNUNG_SEATS.md) — Sammelabrechnung einer Organisation.
//
//   GET    /v1/tenants/me/billing                        Zustand, laufender Monat, Datensaetze, Events (Admin)
//   POST   /v1/tenants/me/billing/seats/activate         {tier}   Sammelabrechnung an (Owner, sofort)
//   POST   /v1/tenants/me/billing/seats/deactivate       {revoke?} zum naechsten 1. beenden / zuruecknehmen (Owner)
//   PUT    /v1/tenants/me/billing/seats/tier             {tier}   Upgrade sofort, Downgrade zum naechsten 1. (Owner)
//   PATCH  /v1/tenants/me/billing/seats                  {maxSeats} Seat-Deckel (Owner)
//   GET    /v1/tenants/me/billing/invoices               Datensaetze (Admin)
//   GET    /v1/tenants/me/billing/invoices/{periodKey}   Datensatz mit Personen-Nachweis (Admin)
//   GET    /v1/tenants/me/billing/invoices/{periodKey}/csv
//   POST   /v1/tenants/me/billing/close                  {periodKey} abgeschlossene Periode jetzt verbuchen (Owner)
//
// A-2 (2026-09-06): nur Datensatz, keine Stripe-Rechnung.

import { OpenAPIHono, createRoute, z } from "@hono/zod-openapi";
import { HTTPException } from "hono/http-exception";
import { getGatewayPool } from "../../lib/producer-pools";
import { TenantError } from "../../lib/tenant-error";
import {
  getSeatBillingState,
  activateSeats,
  deactivateSeats,
  setSeatTier,
  setSeatSettings,
  listSeatInvoices,
  getSeatInvoice,
  seatInvoiceCsv,
  closePeriod,
} from "../../lib/seat-billing";

export const seatBillingRouter = new OpenAPIHono();

const Ok = z.object({ ok: z.literal(true) }).passthrough();
const Any = z.object({}).passthrough();
const SeatTierShape = z.enum(["starter", "pro"]);
const PeriodKey = z.string().regex(/^\d{4}-\d{2}$/);

function wrap<T>(fn: () => Promise<T>): Promise<T> {
  return fn().catch((err: unknown) => {
    if (err instanceof TenantError) throw new HTTPException(err.status, { message: err.message });
    throw err;
  });
}

async function istAdmin(tenantId: string, actorId: string): Promise<boolean> {
  const r = await getGatewayPool().query<{ role: string }>(`SELECT "role" FROM "TenantMember" WHERE "tenantId" = $1 AND "actorId" = $2`, [tenantId, actorId]);
  return r.rows[0]?.role === "owner" || r.rows[0]?.role === "admin";
}

seatBillingRouter.openapi(
  createRoute({
    method: "get",
    path: "/tenants/me/billing",
    tags: ["billing"],
    summary: "Sammelabrechnung der Organisation: Zustand, laufender Monat, Datensaetze (Admin).",
    responses: { 200: { content: { "application/json": { schema: Any } }, description: "ok" } },
  }),
  async (c) => c.json(await wrap(() => getSeatBillingState(getGatewayPool(), c.get("auth")))),
);

seatBillingRouter.openapi(
  createRoute({
    method: "post",
    path: "/tenants/me/billing/seats/activate",
    tags: ["billing"],
    summary: "Sammelabrechnung aktivieren (Owner). Wirkt sofort fuer alle Mitglieder; persoenliche Abos werden zum Periodenende gekuendigt.",
    request: { body: { content: { "application/json": { schema: z.object({ tier: SeatTierShape }) } } } },
    responses: { 200: { content: { "application/json": { schema: Ok } }, description: "aktiv" } },
  }),
  async (c) => {
    const { tier } = c.req.valid("json");
    const r = await wrap(() => activateSeats(getGatewayPool(), c.get("auth"), tier));
    return c.json({ ok: true as const, ...r });
  },
);

seatBillingRouter.openapi(
  createRoute({
    method: "post",
    path: "/tenants/me/billing/seats/deactivate",
    tags: ["billing"],
    summary: "Sammelabrechnung zum naechsten Monatsersten beenden (Owner) oder die Vormerkung zuruecknehmen (revoke=true).",
    request: { body: { content: { "application/json": { schema: z.object({ revoke: z.boolean().optional() }) } } } },
    responses: { 200: { content: { "application/json": { schema: Ok } }, description: "vorgemerkt" } },
  }),
  async (c) => {
    const { revoke } = c.req.valid("json");
    const r = await wrap(() => deactivateSeats(getGatewayPool(), c.get("auth"), revoke === true));
    return c.json({ ok: true as const, ...r });
  },
);

seatBillingRouter.openapi(
  createRoute({
    method: "put",
    path: "/tenants/me/billing/seats/tier",
    tags: ["billing"],
    summary: "Organisations-Tier setzen (Owner): Upgrade sofort, Downgrade zum naechsten Monatsersten.",
    request: { body: { content: { "application/json": { schema: z.object({ tier: SeatTierShape }) } } } },
    responses: { 200: { content: { "application/json": { schema: Ok } }, description: "gesetzt" } },
  }),
  async (c) => {
    const { tier } = c.req.valid("json");
    const r = await wrap(() => setSeatTier(getGatewayPool(), c.get("auth"), tier));
    return c.json({ ok: true as const, ...r });
  },
);

seatBillingRouter.openapi(
  createRoute({
    method: "patch",
    path: "/tenants/me/billing/seats",
    tags: ["billing"],
    summary: "Seat-Deckel setzen (Owner); null = kein Deckel. Gilt nur fuer neue Aufnahmen.",
    request: { body: { content: { "application/json": { schema: z.object({ maxSeats: z.number().int().min(1).max(10_000).nullable().optional() }) } } } },
    responses: { 200: { content: { "application/json": { schema: Ok } }, description: "gesetzt" } },
  }),
  async (c) => {
    const patch = c.req.valid("json");
    await wrap(() => setSeatSettings(getGatewayPool(), c.get("auth"), patch));
    return c.json({ ok: true as const });
  },
);

seatBillingRouter.openapi(
  createRoute({
    method: "get",
    path: "/tenants/me/billing/invoices",
    tags: ["billing"],
    summary: "Abrechnungsdatensaetze der Organisation (Admin).",
    responses: { 200: { content: { "application/json": { schema: Any } }, description: "ok" } },
  }),
  async (c) => {
    const auth = c.get("auth");
    if (!(await istAdmin(auth.tenantId, auth.actorId))) throw new HTTPException(403, { message: "Nur Admins sehen die Abrechnung." });
    return c.json({ items: await listSeatInvoices(getGatewayPool(), auth.tenantId) });
  },
);

seatBillingRouter.openapi(
  createRoute({
    method: "get",
    path: "/tenants/me/billing/invoices/{periodKey}",
    tags: ["billing"],
    summary: "Abrechnungsdatensatz einer Periode mit Personen-Nachweis (Admin).",
    request: { params: z.object({ periodKey: PeriodKey }) },
    responses: { 200: { content: { "application/json": { schema: Any } }, description: "ok" } },
  }),
  async (c) => {
    const auth = c.get("auth");
    const { periodKey } = c.req.valid("param");
    if (!(await istAdmin(auth.tenantId, auth.actorId))) throw new HTTPException(403, { message: "Nur Admins sehen die Abrechnung." });
    const inv = await getSeatInvoice(getGatewayPool(), auth.tenantId, periodKey);
    if (!inv) throw new HTTPException(404, { message: "Kein Datensatz fuer diese Periode." });
    return c.json(inv);
  },
);

seatBillingRouter.get("/tenants/me/billing/invoices/:periodKey/csv", async (c) => {
  const auth = c.get("auth");
  const periodKey = c.req.param("periodKey");
  if (!/^\d{4}-\d{2}$/.test(periodKey)) throw new HTTPException(400, { message: "Ungueltige Periode." });
  if (!(await istAdmin(auth.tenantId, auth.actorId))) throw new HTTPException(403, { message: "Nur Admins sehen die Abrechnung." });
  const inv = await getSeatInvoice(getGatewayPool(), auth.tenantId, periodKey);
  if (!inv) throw new HTTPException(404, { message: "Kein Datensatz fuer diese Periode." });
  const t = await getGatewayPool().query<{ name: string | null }>(`SELECT "name" FROM "Tenant" WHERE "id" = $1`, [auth.tenantId]);
  const csv = seatInvoiceCsv(inv, t.rows[0]?.name ?? null);
  return c.body(`﻿${csv}`, 200, {
    "content-type": "text/csv; charset=utf-8",
    "content-disposition": `attachment; filename="ava-seats-${periodKey}.csv"`,
  });
});

seatBillingRouter.openapi(
  createRoute({
    method: "post",
    path: "/tenants/me/billing/close",
    tags: ["billing"],
    summary: "Abgeschlossene Periode jetzt verbuchen (Owner); der Cron holt das sonst am Monatsersten nach.",
    request: { body: { content: { "application/json": { schema: z.object({ periodKey: PeriodKey }) } } } },
    responses: { 200: { content: { "application/json": { schema: Ok } }, description: "verbucht" } },
  }),
  async (c) => {
    const auth = c.get("auth");
    const { periodKey } = c.req.valid("json");
    const me = await getGatewayPool().query<{ role: string }>(`SELECT "role" FROM "TenantMember" WHERE "tenantId" = $1 AND "actorId" = $2`, [auth.tenantId, auth.actorId]);
    if (me.rows[0]?.role !== "owner") throw new HTTPException(403, { message: "Nur der Owner darf verbuchen." });
    const r = await wrap(() => closePeriod(getGatewayPool(), auth.tenantId, periodKey, "admin", auth.actorId));
    return c.json({ ok: true as const, ...r });
  },
);

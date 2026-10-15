// M1 of monetization plan — read-only usage snapshot for the
// authenticated tenant.
//
// Surface:
//   GET /v1/usage → { tier, used, limit, remaining, periodEnd, periodKey }
//
// Backed by `lib/billing.ts → getUsageSnapshot`. The desktop polls
// this for the Settings "Plan & Verbrauch" card and the topbar pill;
// the agent calls it before committing a non-dryRun import to surface
// "this would put you over your quota" warnings.
//
// No write-side endpoints in M1 — quota changes happen via:
//   - lazy create on first persist (defaults to free / 25)
//   - operator hand-edit (psql) for support cases
//   - M3's Stripe webhook for paid-tier flips
//
// All under the same auth + rate-limit + audit chain as the rest of
// /v1 (mounted from routes/v1.ts).

import { OpenAPIHono, createRoute, z } from "@hono/zod-openapi";
import { HTTPException } from "hono/http-exception";
import { getGatewayPool } from "../../lib/producer-pools";
import { getUsageSnapshot } from "../../lib/billing";
import { istBetreiber } from "../../middleware/auth";
import { ErrorShape } from "./schemas";

export const usageRouter = new OpenAPIHono();

const UsageResponseShape = z
  .object({
    tier: z.enum(["free", "starter", "pro", "enterprise"]),
    used: z.number().int().nonnegative(),
    /** -1 sentinel = no enforcement (enterprise tier). Otherwise the
     *  per-period quota. Clients render -1 as "∞". */
    limit: z.number().int(),
    /** Same -1 sentinel pattern; otherwise max(0, limit-used). */
    remaining: z.number().int(),
    /** ISO-8601. null for free + enterprise (no rolling reset). */
    periodEnd: z.string().nullable(),
    /** "lifetime" for free; "YYYY-MM" for paid tiers; "unlimited" for
     *  enterprise. The desktop picks a German label based on this. */
    periodKey: z.string(),
    /** v0.1.103 — true when the user has scheduled cancellation but
     *  the period hasn't ended yet. Desktop shows
     *  "Kündigung zum X vorgemerkt" while this is true. */
    cancelAtPeriodEnd: z.boolean(),
    parkedCount: z.number().int().nonnegative(),
    /** B1 — active | past_due | suspended | canceled */
    status: z.string(),
    /** B1 — Berechtigungsquelle (personal | seat | enterprise) und Details. */
    entitlement: z.object({}).passthrough(),
  })
  .openapi("UsageSnapshot");

const usageRoute = createRoute({
  method: "get",
  path: "/usage",
  tags: ["billing"],
  summary: "Read the calling tenant's quota usage snapshot",
  responses: {
    200: {
      content: { "application/json": { schema: UsageResponseShape } },
      description:
        "current period usage. `remaining` is clamped to >=0 even when used > limit (manual quota cuts).",
    },
    401: {
      content: { "application/json": { schema: ErrorShape } },
      description: "unauthenticated",
    },
  },
});

// Z5 — Stufe je Firma fuer eine Liste (Vorgangsansicht).
const stufenRoute = createRoute({
  method: "post",
  path: "/usage/stufen",
  tags: ["billing"],
  summary: "Stufe (klein | mittel | gross) und Preis der juengsten Aufnahme je Firma",
  request: { body: { content: { "application/json": { schema: z.object({ companyIds: z.array(z.string().min(1)).min(1).max(500) }) } } } },
  responses: {
    200: { content: { "application/json": { schema: z.object({ stufen: z.record(z.string(), z.object({ stufe: z.string(), preisCents: z.number().int(), grund: z.string().nullable() })) }) } }, description: "ok" },
    401: { content: { "application/json": { schema: ErrorShape } }, description: "unauthenticated" },
  },
});
usageRouter.openapi(stufenRoute, async (c) => {
  const auth = c.get("auth");
  if (!auth?.tenantId) throw new HTTPException(401, { message: "auth_context_missing" });
  const { companyIds } = c.req.valid("json");
  const r = await getGatewayPool().query<{ companyId: string; stufe: string; preisCents: number | null; grund: string | null }>(
    `SELECT DISTINCT ON ("companyId") "companyId", "stufe", "preisCents", "grund" FROM "UsageEntry"
      WHERE "companyId" = ANY($1::text[]) AND "stufe" IS NOT NULL ORDER BY "companyId", "zugeordnetAm" DESC NULLS LAST`,
    [companyIds],
  );
  const stufen: Record<string, { stufe: string; preisCents: number; grund: string | null }> = {};
  for (const row of r.rows) stufen[row.companyId] = { stufe: row.stufe, preisCents: row.preisCents ?? 0, grund: row.grund };
  return c.json({ stufen }, 200);
});

// Z7 — Ausgabenlimit je Monat (Cent), setzt der Kunde selbst. Bei Seats nur
// Owner/Admin der Organisation (das Limit gilt fuer das Abrechnungskonto).
const ausgabenlimitRoute = createRoute({
  method: "put",
  path: "/usage/ausgabenlimit",
  tags: ["billing"],
  summary: "Monatliches Ausgabenlimit fuer Aufnahmen setzen (null = keins)",
  request: { body: { content: { "application/json": { schema: z.object({ ausgabenLimitCents: z.number().int().min(0).max(100_000_000).nullable() }) } }, required: true } },
  responses: {
    200: { content: { "application/json": { schema: z.object({ ausgabenLimitCents: z.number().int().nullable() }) } }, description: "gesetzt" },
    401: { content: { "application/json": { schema: ErrorShape } }, description: "unauthenticated" },
    403: { content: { "application/json": { schema: ErrorShape } }, description: "kein Admin des Abrechnungskontos" },
  },
});
usageRouter.openapi(ausgabenlimitRoute, async (c) => {
  const auth = c.get("auth");
  if (!auth?.tenantId) throw new HTTPException(401, { message: "auth_context_missing" });
  const { ausgabenLimitCents } = c.req.valid("json");
  const pool = getGatewayPool();
  const { resolveBillingAccountId } = await import("../../lib/billing");
  const billingAccountId = await resolveBillingAccountId(pool, { tenantId: auth.tenantId, actorId: auth.actorId });
  if (billingAccountId !== auth.tenantId) {
    const me = await pool.query<{ role: string }>(`SELECT "role" FROM "TenantMember" WHERE "tenantId" = $1 AND "actorId" = $2`, [billingAccountId, auth.actorId]);
    if (me.rows[0]?.role !== "owner" && me.rows[0]?.role !== "admin") throw new HTTPException(403, { message: "Nur Owner oder Admin der Organisation setzen das Ausgabenlimit." });
  }
  await pool.query(`UPDATE "TenantBilling" SET "ausgabenLimitCents" = $2, "updatedAt" = NOW() WHERE "tenantId" = $1`, [billingAccountId, ausgabenLimitCents]);
  const { invalidateBillingResolution } = await import("../../lib/billing");
  invalidateBillingResolution(billingAccountId);
  const { recordBillingEvent } = await import("../../lib/billing-events");
  await recordBillingEvent(pool, { billingAccountId, kind: "ausgabenlimit_gesetzt", source: "admin", actorId: auth.actorId, payload: { ausgabenLimitCents } });
  return c.json({ ausgabenLimitCents }, 200);
});

// Z11 — Kalkulation fuer die Betreiber-Seite "Verarbeitungskosten" in der Konsole:
// Kostenposten je Stufe, Fixkosten, Preise (Env), Tarif (Seat, Instanz). Nur Betreiber.
const betreiberKalkulationRoute = createRoute({
  method: "get",
  path: "/betreiber/kalkulation",
  tags: ["billing"],
  summary: "Betreiber: Kalkulation der Verarbeitungskosten (Kostenposten je Stufe, Fixkosten, Preise, Tarif)",
  responses: {
    200: { content: { "application/json": { schema: z.object({}).passthrough() } }, description: "ok" },
    404: { content: { "application/json": { schema: ErrorShape } }, description: "kein Betreiber" },
  },
});
usageRouter.openapi(betreiberKalkulationRoute, async (c) => {
  const auth = c.get("auth");
  if (!istBetreiber(auth)) throw new HTTPException(404, { message: "not_found" });
  const { KOSTENPOSTEN, FIXKOSTEN, tarif, direktJeStufe } = await import("../../lib/kalkulation");
  const { stufenPreise, grossAb } = await import("../../lib/stufen");
  const preise = stufenPreise();
  return c.json(
    {
      stand: "2026-10-13",
      grossAb: grossAb(),
      preise: (["klein", "mittel", "gross"] as const).map((stufe) => ({ stufe, preisEur: preise[stufe].preisCents / 100, direktkostenEurMonat: preise[stufe].direktkostenCents / 100 })),
      direktJeStufe: direktJeStufe(),
      tarif: tarif(),
      kostenposten: KOSTENPOSTEN,
      fixkosten: FIXKOSTEN,
    },
    200,
  );
});

// Z5 — Betreiber-Uebersicht: Direktkosten der Betreiber-Spur und Stufenverteilung je
// Monat. Nur fuer den Betreiber-Tenant (OPERATOR_TENANT_ID), sonst 404.
const betreiberKostenRoute = createRoute({
  method: "get",
  path: "/betreiber/kosten",
  tags: ["billing"],
  summary: "Betreiber: Modellkosten der Pool-Spur je Stufe/Monat, valueserp-Aufrufe, Stufenverteilung der Aufnahmen",
  request: { query: z.object({ monate: z.coerce.number().int().min(1).max(12).default(3) }) },
  responses: {
    200: { content: { "application/json": { schema: z.object({}).passthrough() } }, description: "ok" },
    404: { content: { "application/json": { schema: ErrorShape } }, description: "kein Betreiber" },
  },
});
usageRouter.openapi(betreiberKostenRoute, async (c) => {
  const auth = c.get("auth");
  if (!istBetreiber(auth)) throw new HTTPException(404, { message: "not_found" });
  const { monate } = c.req.valid("query");
  const pool = getGatewayPool();
  const [modell, serp, stufen, aufnahmen, messung] = await Promise.all([
    pool.query(
      `SELECT to_char(date_trunc('month', "createdAt"), 'YYYY-MM') AS monat, COALESCE(quelle, '?') AS stufe, COUNT(*)::int AS aufrufe,
              COALESCE(SUM("costMicroUsd"), 0)::bigint AS "microUsd", COALESCE(SUM("inputTokens"), 0)::bigint AS "inputTokens", COALESCE(SUM("outputTokens"), 0)::bigint AS "outputTokens"
         FROM "LlmUsage" WHERE kind = 'betreiber' AND "createdAt" > NOW() - ($1 || ' months')::interval GROUP BY 1, 2 ORDER BY 1 DESC, 3 DESC`,
      [String(monate)],
    ),
    pool.query(
      `SELECT to_char(date_trunc('month', "createdAt"), 'YYYY-MM') AS monat, COUNT(*)::int AS aufrufe, COUNT(*) FILTER (WHERE "cacheHit")::int AS cache
         FROM "ProxyAudit" WHERE proxy = 'valueserp' AND "createdAt" > NOW() - ($1 || ' months')::interval GROUP BY 1 ORDER BY 1 DESC`,
      [String(monate)],
    ),
    // 2026-10-15: je Stufe UND Plan-Gruppe. Enterprise zahlt pauschal, Free
    // nichts — nur Starter/Pro bringen Erloes je Firma. Erloes zu HEUTIGEN
    // Stufenpreisen (gespeicherte preisCents tragen alte Saetze aus Aug/Sep).
    pool.query(
      `SELECT COALESCE(u."stufe", 'offen') AS stufe,
              CASE WHEN b.tier IN ('starter', 'pro') THEN 'zahlend' WHEN b.tier = 'enterprise' THEN 'enterprise' ELSE 'free' END AS gruppe,
              COUNT(*)::int AS n
         FROM "UsageEntry" u LEFT JOIN "TenantBilling" b ON b."tenantId" = u."billingAccountId"
         WHERE u."createdAt" > NOW() - ($1 || ' months')::interval GROUP BY 1, 2 ORDER BY 1, 2`,
      [String(monate)],
    ),
    pool.query(
      `SELECT to_char(date_trunc('month', "createdAt"), 'YYYY-MM') AS monat, COUNT(*)::int AS n FROM "UsageEntry"
         WHERE "createdAt" > NOW() - ($1 || ' months')::interval GROUP BY 1 ORDER BY 1 DESC`,
      [String(monate)],
    ),
    // Seit wann die Betreiber-Spur ueberhaupt gemessen wird (vorher 404, Fix 2026-10-14).
    pool.query(`SELECT MIN("createdAt") AS seit FROM "LlmUsage" WHERE kind = 'betreiber'`),
  ]);
  const num = (v: unknown) => Number(v ?? 0);
  const { stufenPreise } = await import("../../lib/stufen");
  const preise = stufenPreise();
  const satz = (stufe: string) => (preise as Record<string, { preisCents: number; direktkostenCents: number }>)[stufe] ?? { preisCents: 0, direktkostenCents: 0 };
  // Je Stufe summieren; Erloes nur fuer zahlende Konten, Direktkosten fuer alle.
  const jeStufe = new Map<string, { aufnahmen: number; zahlend: number; enterprise: number; free: number; preisEur: number; direktkostenEur: number }>();
  for (const r of stufen.rows as Array<{ stufe: string; gruppe: string; n: number }>) {
    const z = jeStufe.get(r.stufe) ?? { aufnahmen: 0, zahlend: 0, enterprise: 0, free: 0, preisEur: 0, direktkostenEur: 0 };
    z.aufnahmen += r.n;
    if (r.gruppe === "zahlend") { z.zahlend += r.n; z.preisEur += (r.n * satz(r.stufe).preisCents) / 100; }
    else if (r.gruppe === "enterprise") z.enterprise += r.n;
    else z.free += r.n;
    z.direktkostenEur += (r.n * satz(r.stufe).direktkostenCents) / 100;
    jeStufe.set(r.stufe, z);
  }
  const seit = (messung.rows[0] as { seit?: Date | null } | undefined)?.seit ?? null;
  return c.json({
    monate,
    modell: modell.rows.map((r) => ({ monat: r.monat, stufe: r.stufe, aufrufe: r.aufrufe, usd: Math.round(num(r.microUsd) / 1e4) / 100, inputTokens: num(r.inputTokens), outputTokens: num(r.outputTokens) })),
    modellMessungSeit: seit ? new Date(seit).toISOString() : null,
    valueserp: serp.rows,
    stufen: [...jeStufe.entries()].sort(([a], [b]) => a.localeCompare(b)).map(([stufe, z]) => ({ stufe, ...z, preisEur: Math.round(z.preisEur * 100) / 100, direktkostenEur: Math.round(z.direktkostenEur * 100) / 100 })),
    aufnahmenJeMonat: aufnahmen.rows,
  }, 200);
});

// 2026-10-15 — Betreiber: Kunden (Abrechnungskonten) mit Detail je Monat, Enterprise-
// Preisempfehlung, Betreiber-Monatslimit und CSV-Export. Nur Betreiber (sonst 404).
const betreiberKundenRoute = createRoute({
  method: "get",
  path: "/betreiber/kunden",
  tags: ["billing"],
  summary: "Betreiber: alle Kunden (Abrechnungskonten) mit Plan, Mitgliedern, Bestand und Limits",
  responses: {
    200: { content: { "application/json": { schema: z.object({}).passthrough() } }, description: "ok" },
    404: { content: { "application/json": { schema: ErrorShape } }, description: "kein Betreiber" },
  },
});
usageRouter.openapi(betreiberKundenRoute, async (c) => {
  const auth = c.get("auth");
  if (!istBetreiber(auth)) throw new HTTPException(404, { message: "not_found" });
  const { kundenListe } = await import("../../lib/betreiber-kunden");
  return c.json({ kunden: await kundenListe(getGatewayPool()) }, 200);
});

const KundeParam = z.object({ tenantId: z.string().min(1).max(120) });
const betreiberKundeRoute = createRoute({
  method: "get",
  path: "/betreiber/kunden/{tenantId}",
  tags: ["billing"],
  summary: "Betreiber: Kunde im Detail (Bestand, Erloes, Spurkosten je Monat, Enterprise-Empfehlung)",
  request: { params: KundeParam, query: z.object({ monate: z.coerce.number().int().min(1).max(24).default(12), instanzen: z.coerce.number().int().min(0).max(50).default(0) }) },
  responses: {
    200: { content: { "application/json": { schema: z.object({}).passthrough() } }, description: "ok" },
    404: { content: { "application/json": { schema: ErrorShape } }, description: "kein Betreiber oder Kunde unbekannt" },
  },
});
usageRouter.openapi(betreiberKundeRoute, async (c) => {
  const auth = c.get("auth");
  if (!istBetreiber(auth)) throw new HTTPException(404, { message: "not_found" });
  const { tenantId } = c.req.valid("param");
  const { monate, instanzen } = c.req.valid("query");
  const { kundeDetail } = await import("../../lib/betreiber-kunden");
  const d = await kundeDetail(getGatewayPool(), tenantId, monate, instanzen);
  if (!d) throw new HTTPException(404, { message: "kunde_unbekannt" });
  return c.json(d, 200);
});

const betreiberKundeExportRoute = createRoute({
  method: "get",
  path: "/betreiber/kunden/{tenantId}/export.csv",
  tags: ["billing"],
  summary: "Betreiber: Kostenexport je Monat als CSV",
  request: { params: KundeParam, query: z.object({ monate: z.coerce.number().int().min(1).max(24).default(12) }) },
  responses: {
    200: { content: { "text/csv": { schema: z.string() } }, description: "CSV" },
    404: { content: { "application/json": { schema: ErrorShape } }, description: "kein Betreiber oder Kunde unbekannt" },
  },
});
usageRouter.openapi(betreiberKundeExportRoute, async (c) => {
  const auth = c.get("auth");
  if (!istBetreiber(auth)) throw new HTTPException(404, { message: "not_found" });
  const { tenantId } = c.req.valid("param");
  const { monate } = c.req.valid("query");
  const { kundeDetail, kundeCsv } = await import("../../lib/betreiber-kunden");
  const d = await kundeDetail(getGatewayPool(), tenantId, monate, 0);
  if (!d) throw new HTTPException(404, { message: "kunde_unbekannt" });
  const datei = `ava-kosten-${d.kunde.name.replace(/[^a-z0-9]+/gi, "-").replace(/^-|-$/g, "").toLowerCase() || tenantId}-${monate}m.csv`;
  return new Response(kundeCsv(d), { status: 200, headers: { "content-type": "text/csv; charset=utf-8", "content-disposition": `attachment; filename="${datei}"` } }) as never;
});

const betreiberKundeLimitRoute = createRoute({
  method: "put",
  path: "/betreiber/kunden/{tenantId}/limit",
  tags: ["billing"],
  summary: "Betreiber: Enterprise-Vertrag setzen — Monatslimit der Hintergrundverarbeitung (Cent zu Stufenpreisen) und ausgehandelter Fixpreis (Cent), null = keins",
  request: { params: KundeParam, body: { content: { "application/json": { schema: z.object({ betreiberLimitCents: z.number().int().min(0).max(1_000_000_000).nullable().optional(), enterprisePreisCents: z.number().int().min(0).max(1_000_000_000).nullable().optional() }) } }, required: true } },
  responses: {
    200: { content: { "application/json": { schema: z.object({ betreiberLimitCents: z.number().int().nullable(), enterprisePreisCents: z.number().int().nullable() }) } }, description: "gesetzt" },
    404: { content: { "application/json": { schema: ErrorShape } }, description: "kein Betreiber oder Kunde unbekannt" },
  },
});
usageRouter.openapi(betreiberKundeLimitRoute, async (c) => {
  const auth = c.get("auth");
  if (!istBetreiber(auth)) throw new HTTPException(404, { message: "not_found" });
  const { tenantId } = c.req.valid("param");
  const body = c.req.valid("json");
  const pool = getGatewayPool();
  const { ensureBillingAccount } = await import("../../lib/billing");
  const vorher = await ensureBillingAccount(pool, tenantId, "organisation");
  const betreiberLimitCents = body.betreiberLimitCents === undefined ? vorher.betreiberLimitCents : body.betreiberLimitCents;
  const enterprisePreisCents = body.enterprisePreisCents === undefined ? vorher.enterprisePreisCents : body.enterprisePreisCents;
  const r = await pool.query(`UPDATE "TenantBilling" SET "betreiberLimitCents" = $2, "enterprisePreisCents" = $3, "updatedAt" = NOW() WHERE "tenantId" = $1`, [tenantId, betreiberLimitCents, enterprisePreisCents]);
  if (r.rowCount === 0) throw new HTTPException(404, { message: "kunde_unbekannt" });
  const { invalidateBillingResolution } = await import("../../lib/billing");
  invalidateBillingResolution(tenantId);
  const { recordBillingEvent } = await import("../../lib/billing-events");
  await recordBillingEvent(pool, { billingAccountId: tenantId, kind: "vertrag_gesetzt", source: "admin", actorId: auth.actorId, payload: { betreiberLimitCents, enterprisePreisCents } });
  return c.json({ betreiberLimitCents, enterprisePreisCents }, 200);
});

// 2026-10-15 — Kundensicht: Owner/Admin der eigenen Organisation sehen Vertrag,
// Kontingentverbrauch und Rechnungsbetraege je Monat; CSV-Export.
async function eigenesKontoAlsAdmin(c: { get: (k: "auth") => { tenantId?: string; actorId?: string | null } }): Promise<string> {
  const auth = c.get("auth");
  if (!auth?.tenantId) throw new HTTPException(401, { message: "auth_context_missing" });
  const pool = getGatewayPool();
  const { resolveBillingAccountId } = await import("../../lib/billing");
  const konto = await resolveBillingAccountId(pool, { tenantId: auth.tenantId, actorId: auth.actorId });
  if (konto !== auth.actorId) {
    const me = await pool.query<{ role: string }>(`SELECT "role" FROM "TenantMember" WHERE "tenantId" = $1 AND "actorId" = $2`, [konto, auth.actorId]);
    if (me.rows[0]?.role !== "owner" && me.rows[0]?.role !== "admin") throw new HTTPException(403, { message: "Nur Owner oder Admin der Organisation sehen die Kosten." });
  }
  return konto;
}

const meineKostenRoute = createRoute({
  method: "get",
  path: "/tenants/me/kosten",
  tags: ["billing"],
  summary: "Eigene Organisation: Vertrag, Kontingentverbrauch und Rechnungsbetraege je Monat (Owner/Admin)",
  request: { query: z.object({ monate: z.coerce.number().int().min(1).max(24).default(12) }) },
  responses: {
    200: { content: { "application/json": { schema: z.object({}).passthrough() } }, description: "ok" },
    403: { content: { "application/json": { schema: ErrorShape } }, description: "kein Owner/Admin" },
  },
});
usageRouter.openapi(meineKostenRoute, async (c) => {
  const konto = await eigenesKontoAlsAdmin(c);
  const { monate } = c.req.valid("query");
  const { kundeDetail, kundenSicht } = await import("../../lib/betreiber-kunden");
  const d = await kundeDetail(getGatewayPool(), konto, monate, 0);
  if (!d) throw new HTTPException(404, { message: "konto_unbekannt" });
  return c.json(kundenSicht(d), 200);
});

const meineKostenExportRoute = createRoute({
  method: "get",
  path: "/tenants/me/kosten/export.csv",
  tags: ["billing"],
  summary: "Eigene Organisation: Kosten je Monat als CSV (Owner/Admin)",
  request: { query: z.object({ monate: z.coerce.number().int().min(1).max(24).default(12) }) },
  responses: {
    200: { content: { "text/csv": { schema: z.string() } }, description: "CSV" },
    403: { content: { "application/json": { schema: ErrorShape } }, description: "kein Owner/Admin" },
  },
});
usageRouter.openapi(meineKostenExportRoute, async (c) => {
  const konto = await eigenesKontoAlsAdmin(c);
  const { monate } = c.req.valid("query");
  const { kundeDetail, kundenSicht, kundenCsv } = await import("../../lib/betreiber-kunden");
  const d = await kundeDetail(getGatewayPool(), konto, monate, 0);
  if (!d) throw new HTTPException(404, { message: "konto_unbekannt" });
  const datei = `ava-kosten-${monate}m.csv`;
  return new Response(kundenCsv(kundenSicht(d)), { status: 200, headers: { "content-type": "text/csv; charset=utf-8", "content-disposition": `attachment; filename="${datei}"` } }) as never;
});

usageRouter.openapi(usageRoute, async (c) => {
  const auth = c.get("auth");
  if (!auth?.tenantId) {
    throw new HTTPException(401, { message: "auth_context_missing" });
  }
  // B1 — Konto aus (Daten-Tenant, Akteur) aufloesen: Mitglieder einer
  // Organisation ohne Sammelabrechnung zaehlen auf ihr eigenes Konto.
  const snapshot = await getUsageSnapshot(getGatewayPool(), { tenantId: auth.tenantId, actorId: auth.actorId });
  return c.json(snapshot, 200);
});

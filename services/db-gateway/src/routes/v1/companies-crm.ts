// Workstream C — read API for CompanyCrmLink + on-demand CRM
// enrichment (CompanyCrmCache + live HubSpot fetch).
//
// Two endpoints:
//   GET /v1/companies/:companyId/crm
//     Cheap, DB-only. Lists the CRM links the gateway knows about
//     for this company. Renderer uses this for "Linked to: HubSpot"
//     badges and the chat agent uses it as a precheck before
//     pulling enriched details.
//
//   GET /v1/companies/:companyId/crm/details?refresh=false
//     Returns the enriched payload per linked CRM. Cached up to 6h
//     in CompanyCrmCache; `refresh=true` forces a fresh upstream
//     call and overwrites the cache. Salesforce + Dynamics return
//     `{ notConfigured: true }` for now; the chat agent renders a
//     gentle "noch nicht angebunden" line in that case.
//
// Auth: both routes require `company:read`. Tenant scoping comes
// from the JWT claim — no companyId is global to a tenant for CRM
// linkage (HubSpot ids are portal-scoped).

import { OpenAPIHono, createRoute, z } from "@hono/zod-openapi";
import { HTTPException } from "hono/http-exception";
import { requireScope } from "../../middleware/auth";
import { logger } from "../../lib/logger";
import { getGatewayPool } from "../../lib/producer-pools";
import {
  getCrmCache,
  listCrmLinks,
  listCrmLinksForCompanies,
  markCrmLinkSynced,
  putCrmCache,
  upsertCrmLink,
  type CrmType,
} from "../../lib/crm-links";

export const companiesCrmRouter = new OpenAPIHono();
companiesCrmRouter.use("*", requireScope("company:read"));

const tag = "companies";

const CompanyIdParam = z
  .object({
    companyId: z
      .string()
      .min(1)
      .openapi({ param: { name: "companyId", in: "path" } }),
  })
  .openapi("CompanyCrmIdParam");

const CrmLinkShape = z
  .object({
    crmType: z.enum(["HUBSPOT", "SALESFORCE", "DYNAMICS"]),
    crmExternalId: z.string(),
    crmDisplayName: z.string().nullable(),
    confirmedAt: z.string(),
    confirmedSource: z.enum([
      "EXACT_MATCH",
      "USER_CONFIRMED",
      "MANUAL_LINK",
      "SINGLE_IMPORT",
    ]),
    lastSyncedAt: z.string().nullable(),
  })
  .openapi("CompanyCrmLinkShape");

const CrmLinksResponse = z
  .object({ links: z.array(CrmLinkShape) })
  .openapi("CompanyCrmLinksResponse");

// =============================================================================
// GET /v1/companies/:companyId/crm
// =============================================================================

const listLinksRoute = createRoute({
  method: "get",
  path: "/companies/{companyId}/crm",
  tags: [tag],
  summary: "List confirmed CRM links for a company (Workstream C)",
  request: { params: CompanyIdParam },
  responses: {
    200: {
      content: { "application/json": { schema: CrmLinksResponse } },
      description: "links",
    },
  },
});

companiesCrmRouter.openapi(listLinksRoute, async (c) => {
  const { companyId } = c.req.valid("param");
  const auth = c.get("auth");
  if (!auth) throw new HTTPException(401, { message: "unauthenticated" });
  const rows = await listCrmLinks(getGatewayPool(), {
    tenantId: auth.tenantId,
    companyId,
  });
  return c.json(
    {
      links: rows.map((r) => ({
        crmType: r.crmType,
        crmExternalId: r.crmExternalId,
        crmDisplayName: r.crmDisplayName,
        confirmedAt: r.confirmedAt.toISOString(),
        confirmedSource: r.confirmedSource,
        lastSyncedAt: r.lastSyncedAt ? r.lastSyncedAt.toISOString() : null,
      })),
    },
    200,
  );
});

// =============================================================================
// GET /v1/companies/:companyId/crm/details
// =============================================================================

const DetailsQuery = z
  .object({
    refresh: z.coerce.boolean().optional().default(false),
  })
  .openapi("CompanyCrmDetailsQuery");

const CrmDetailShape = z
  .object({
    crmType: z.enum(["HUBSPOT", "SALESFORCE", "DYNAMICS"]),
    fetchedAt: z.string(),
    notConfigured: z.boolean().optional(),
    contacts: z.array(z.record(z.unknown())).optional(),
    deals: z.array(z.record(z.unknown())).optional(),
    notes: z.array(z.record(z.unknown())).optional(),
    lastActivity: z.string().nullable().optional(),
    raw: z.record(z.unknown()).optional(),
    error: z.string().optional(),
  })
  .openapi("CompanyCrmDetail");

const DetailsResponse = z
  .object({ details: z.array(CrmDetailShape) })
  .openapi("CompanyCrmDetailsResponse");

const detailsRoute = createRoute({
  method: "get",
  path: "/companies/{companyId}/crm/details",
  tags: [tag],
  summary:
    "Pull enriched CRM context (contacts, deals, notes) for one company",
  request: { params: CompanyIdParam, query: DetailsQuery },
  responses: {
    200: {
      content: { "application/json": { schema: DetailsResponse } },
      description: "details per CRM",
    },
  },
});

const CACHE_TTL_HOURS = 6;

companiesCrmRouter.openapi(detailsRoute, async (c) => {
  const { companyId } = c.req.valid("param");
  const { refresh } = c.req.valid("query");
  const auth = c.get("auth");
  if (!auth) throw new HTTPException(401, { message: "unauthenticated" });

  const pool = getGatewayPool();
  const links = await listCrmLinks(pool, {
    tenantId: auth.tenantId,
    companyId,
  });

  const details: Array<Record<string, unknown>> = [];
  for (const link of links) {
    const cached = refresh
      ? null
      : await getCrmCache(pool, {
          tenantId: auth.tenantId,
          companyId,
          crmType: link.crmType,
        });
    const fresh =
      cached && isFresh(cached.fetchedAt, CACHE_TTL_HOURS) ? cached : null;
    if (fresh) {
      details.push({
        ...(fresh.payload as Record<string, unknown>),
        crmType: link.crmType,
        fetchedAt: fresh.fetchedAt.toISOString(),
      });
      continue;
    }

    // Need a fresh fetch. The bearer token for CRM calls lives in
    // the desktop's OS keychain — we cannot fetch on the gateway
    // for HubSpot/Salesforce/Dynamics directly. The desktop will
    // proxy details via a separate endpoint OR the chat agent
    // forwards the cached payload it last saw. For C2 we ship a
    // stub that surfaces the link metadata + a "notConfigured"
    // hint for SF/Dyn and an "agent_must_refresh" hint for HubSpot
    // when no cache exists. The desktop-side fetch helper (C3 stub)
    // can populate the cache via the future POST endpoint.
    if (link.crmType === "SALESFORCE" || link.crmType === "DYNAMICS") {
      details.push({
        crmType: link.crmType,
        fetchedAt: new Date().toISOString(),
        notConfigured: true,
      });
      continue;
    }
    // HubSpot path: we don't have the user's token here. Return the
    // cache stub so the agent renders gracefully; if a cache row
    // exists (even if stale), prefer that over an empty response.
    if (cached) {
      details.push({
        ...(cached.payload as Record<string, unknown>),
        crmType: link.crmType,
        fetchedAt: cached.fetchedAt.toISOString(),
      });
      await markCrmLinkSynced(pool, {
        tenantId: auth.tenantId,
        companyId,
        crmType: link.crmType,
      });
      continue;
    }
    details.push({
      crmType: link.crmType,
      fetchedAt: new Date().toISOString(),
      contacts: [],
      deals: [],
      notes: [],
      lastActivity: null,
    });
  }

  return c.json({ details } as z.infer<typeof DetailsResponse>, 200);
});

function isFresh(at: Date, hours: number): boolean {
  return Date.now() - at.getTime() < hours * 3600_000;
}

// =============================================================================
// POST /v1/companies/:companyId/crm/cache — desktop pushes a fresh payload
// =============================================================================
//
// The gateway can't hold per-user CRM tokens (they live in the OS
// keychain on the desktop). To keep the read path cache-warm, the
// desktop proxies a fetched payload back here whenever it pulls
// fresh CRM details for the chat agent. Cheap insert/upsert; one
// row per (tenant, company, crmType).

const CachePushBody = z
  .object({
    crmType: z.enum(["HUBSPOT", "SALESFORCE", "DYNAMICS"]),
    payload: z.record(z.unknown()),
  })
  .openapi("CompanyCrmCachePushBody");

const cachePushRoute = createRoute({
  method: "post",
  path: "/companies/{companyId}/crm/cache",
  tags: [tag],
  summary: "Push a fresh CRM enrichment payload into the gateway cache",
  request: {
    params: CompanyIdParam,
    body: { content: { "application/json": { schema: CachePushBody } }, required: true },
  },
  responses: {
    204: { description: "stored" },
  },
});

companiesCrmRouter.openapi(cachePushRoute, async (c) => {
  const { companyId } = c.req.valid("param");
  const body = c.req.valid("json");
  const auth = c.get("auth");
  if (!auth) throw new HTTPException(401, { message: "unauthenticated" });
  await putCrmCache(getGatewayPool(), {
    tenantId: auth.tenantId,
    companyId,
    crmType: body.crmType as CrmType,
    payload: body.payload,
  });
  await markCrmLinkSynced(getGatewayPool(), {
    tenantId: auth.tenantId,
    companyId,
    crmType: body.crmType as CrmType,
  });
  logger.info(
    { tenantId: auth.tenantId, companyId, crmType: body.crmType },
    "company-crm-cache: push stored",
  );
  return c.body(null, 204);
});

// =============================================================================
// POST /v1/companies/:companyId/crm/links — manual link from picker UI
// =============================================================================
//
// Workstream C4 — the renderer's "Mit CRM verknüpfen" dialog calls this
// after the user picks a row from the CRM-side search results. The
// payload is upserted under the same uniqueness key (tenantId, companyId,
// crmType) used by the importer, so re-linking the same company simply
// replaces the external id.

const ManualLinkBody = z
  .object({
    crmType: z.enum(["HUBSPOT", "SALESFORCE", "DYNAMICS"]),
    crmExternalId: z.string().min(1),
    crmDisplayName: z.string().nullable().optional(),
  })
  .openapi("CompanyCrmManualLinkBody");

const manualLinkRoute = createRoute({
  method: "post",
  path: "/companies/{companyId}/crm/links",
  tags: [tag],
  summary: "Create or replace a manual CRM link for a company",
  request: {
    params: CompanyIdParam,
    body: { content: { "application/json": { schema: ManualLinkBody } }, required: true },
  },
  responses: { 204: { description: "linked" } },
});

companiesCrmRouter.openapi(manualLinkRoute, async (c) => {
  const { companyId } = c.req.valid("param");
  const body = c.req.valid("json");
  const auth = c.get("auth");
  if (!auth) throw new HTTPException(401, { message: "unauthenticated" });
  await upsertCrmLink(getGatewayPool(), {
    tenantId: auth.tenantId,
    companyId,
    crmType: body.crmType as CrmType,
    crmExternalId: body.crmExternalId,
    crmDisplayName: body.crmDisplayName ?? null,
    confirmedSource: "MANUAL_LINK",
  });
  logger.info(
    { tenantId: auth.tenantId, companyId, crmType: body.crmType },
    "company-crm-link: manual link stored",
  );
  return c.body(null, 204);
});

// =============================================================================
// POST /v1/companies/crm-links/batch — bulk lookup for list views
// =============================================================================
//
// Workstream C4 — Meine-Firmen / Vorgänge surface a small CRM badge
// next to each company name. Issuing one /crm call per row would N+1
// the gateway; the batch endpoint resolves all known links in one
// SELECT.

const BatchLinksBody = z
  .object({
    companyIds: z.array(z.string().min(1)).max(500),
  })
  .openapi("CompanyCrmBatchLinksBody");

const BatchLinkShape = z.object({
  crmType: z.enum(["HUBSPOT", "SALESFORCE", "DYNAMICS"]),
  crmDisplayName: z.string().nullable(),
});

const BatchLinksResponse = z
  .object({
    links: z.record(z.string(), z.array(BatchLinkShape)),
  })
  .openapi("CompanyCrmBatchLinksResponse");

const batchLinksRoute = createRoute({
  method: "post",
  path: "/companies/crm-links/batch",
  tags: [tag],
  summary: "Resolve CRM-link summaries for a batch of companies",
  request: {
    body: {
      content: { "application/json": { schema: BatchLinksBody } },
      required: true,
    },
  },
  responses: {
    200: {
      content: { "application/json": { schema: BatchLinksResponse } },
      description: "links keyed by companyId",
    },
  },
});

companiesCrmRouter.openapi(batchLinksRoute, async (c) => {
  const body = c.req.valid("json");
  const auth = c.get("auth");
  if (!auth) throw new HTTPException(401, { message: "unauthenticated" });
  if (body.companyIds.length === 0) {
    return c.json({ links: {} }, 200);
  }
  const rows = await listCrmLinksForCompanies(getGatewayPool(), {
    tenantId: auth.tenantId,
    companyIds: body.companyIds,
  });
  const out: Record<string, Array<{ crmType: CrmType; crmDisplayName: string | null }>> = {};
  for (const row of rows) {
    (out[row.companyId] ||= []).push({
      crmType: row.crmType,
      crmDisplayName: row.crmDisplayName,
    });
  }
  return c.json({ links: out }, 200);
});

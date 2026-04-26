import { OpenAPIHono, createRoute, z } from "@hono/zod-openapi";
import { requireScope } from "../../middleware/auth";
import { callUpstream } from "../../lib/upstream";
import {
  CompanyContactShape,
  CompanyIdParam,
  CompanyKeywordShape,
  CompanyProfileShape,
  CompanyPublicationShape,
  CompanyShape,
  ErrorShape,
  PaginatedShape,
  PaginationQuery,
  SearchQuery,
  SearchResultShape,
  StructuredContentShape,
  WebsiteShape,
} from "./schemas";

// §4.1 Company reads.
//
// Q1 resolved: companyId is GLOBAL — no tenant filtering. Gateway fans out
// by companyId only; any tenant can read any company.
//
// All routes require `company:read` scope. Handlers proxy to the upstream
// service's existing REST surface; see DESKTOP_DATA_FLOW.md §4.1 for the
// source-of-truth workflow mapping.

export const companiesRouter = new OpenAPIHono();
companiesRouter.use("*", requireScope("company:read"));

// ---- Helpers ---------------------------------------------------------------

const tag = "companies";
const errorResponses = {
  401: { content: { "application/json": { schema: ErrorShape } }, description: "unauthenticated" },
  403: { content: { "application/json": { schema: ErrorShape } }, description: "forbidden" },
  404: { content: { "application/json": { schema: ErrorShape } }, description: "not found" },
  429: { content: { "application/json": { schema: ErrorShape } }, description: "rate limited" },
  502: { content: { "application/json": { schema: ErrorShape } }, description: "upstream failure" },
} as const;

// ---- GET /v1/companies/search ---------------------------------------------

const searchRoute = createRoute({
  method: "get",
  path: "/companies/search",
  tags: [tag],
  summary: "Fuzzy search companies (W6)",
  request: { query: SearchQuery },
  responses: {
    200: {
      content: { "application/json": { schema: SearchResultShape(CompanyShape) } },
      description: "matches",
    },
    ...errorResponses,
  },
});

companiesRouter.openapi(searchRoute, async (c) => {
  const { q, limit } = c.req.valid("query");
  const upstream = await callUpstream<unknown>(c, "masterData", "/api/germany/v1/companies/fuzzy/search", {
    query: { q, limit },
  });
  // master-data returns either an array or an object — normalize.
  const items = (Array.isArray(upstream)
    ? upstream
    : ((upstream as { items?: unknown[] })?.items ?? [])) as Array<z.infer<typeof CompanyShape>>;
  return c.json({ items, total: items.length }, 200);
});

// ---- GET /v1/companies -----------------------------------------------------

const listRoute = createRoute({
  method: "get",
  path: "/companies",
  tags: [tag],
  summary: "List companies (W7)",
  request: { query: PaginationQuery },
  responses: {
    200: {
      content: { "application/json": { schema: PaginatedShape(CompanyShape) } },
      description: "page of companies",
    },
    ...errorResponses,
  },
});

companiesRouter.openapi(listRoute, async (c) => {
  const { page, pageSize } = c.req.valid("query");
  // master-data list is POST /api/germany/v1/companies with pagination in query.
  // Filter body is deferred until the Desktop-App sends structured filter input.
  const upstream = await callUpstream<{ items?: unknown[]; total?: number }>(
    c,
    "masterData",
    "/api/germany/v1/companies",
    { method: "POST", query: { pageNumber: page, pageSize }, body: {} },
  );
  return c.json(
    {
      items: (upstream?.items ?? []) as Array<z.infer<typeof CompanyShape>>,
      page,
      pageSize,
      total: upstream?.total ?? 0,
    },
    200,
  );
});

// ---- GET /v1/companies/:companyId ------------------------------------------

const detailRoute = createRoute({
  method: "get",
  path: "/companies/{companyId}",
  tags: [tag],
  summary: "Get company (W6 drill-down)",
  request: { params: CompanyIdParam },
  responses: {
    200: {
      content: { "application/json": { schema: CompanyShape } },
      description: "company",
    },
    ...errorResponses,
  },
});

companiesRouter.openapi(detailRoute, async (c) => {
  const { companyId } = c.req.valid("param");
  const upstream = await callUpstream<z.infer<typeof CompanyShape>>(
    c,
    "masterData",
    `/api/germany/v1/companies/${encodeURIComponent(companyId)}`,
  );
  return c.json(upstream, 200);
});

// ---- GET /v1/companies/:companyId/profile ----------------------------------

const profileRoute = createRoute({
  method: "get",
  path: "/companies/{companyId}/profile",
  tags: [tag],
  summary: "Get company profile (W8)",
  request: { params: CompanyIdParam },
  responses: {
    200: { content: { "application/json": { schema: CompanyProfileShape } }, description: "profile" },
    ...errorResponses,
  },
});

companiesRouter.openapi(profileRoute, async (c) => {
  const { companyId } = c.req.valid("param");
  const upstream = await callUpstream<z.infer<typeof CompanyProfileShape>>(
    c,
    "companyProfile",
    `/api/v1/company-profiles/${encodeURIComponent(companyId)}`,
  );
  return c.json(upstream, 200);
});

// ---- GET /v1/companies/:companyId/keywords ---------------------------------

const keywordsRoute = createRoute({
  method: "get",
  path: "/companies/{companyId}/keywords",
  tags: [tag],
  summary: "Get company keywords (W9)",
  request: { params: CompanyIdParam },
  responses: {
    200: {
      content: { "application/json": { schema: z.object({ items: z.array(CompanyKeywordShape) }) } },
      description: "keywords",
    },
    ...errorResponses,
  },
});

companiesRouter.openapi(keywordsRoute, async (c) => {
  const { companyId } = c.req.valid("param");
  const upstream = await callUpstream<unknown>(
    c,
    "companyProfile",
    `/api/v1/company-keywords/${encodeURIComponent(companyId)}`,
  );
  const items = (Array.isArray(upstream)
    ? upstream
    : ((upstream as { items?: unknown[] })?.items ?? [])) as Array<z.infer<typeof CompanyKeywordShape>>;
  return c.json({ items }, 200);
});

// ---- GET /v1/companies/:companyId/website ----------------------------------

const websiteRoute = createRoute({
  method: "get",
  path: "/companies/{companyId}/website",
  tags: [tag],
  summary: "Get company website (W10)",
  request: { params: CompanyIdParam },
  responses: {
    200: { content: { "application/json": { schema: WebsiteShape } }, description: "website" },
    ...errorResponses,
  },
});

companiesRouter.openapi(websiteRoute, async (c) => {
  const { companyId } = c.req.valid("param");
  const upstream = await callUpstream<z.infer<typeof WebsiteShape>>(
    c,
    "website",
    `/api/v1/websites/${encodeURIComponent(companyId)}`,
  );
  return c.json(upstream, 200);
});

// ---- GET /v1/companies/:companyId/publications -----------------------------

const publicationsRoute = createRoute({
  method: "get",
  path: "/companies/{companyId}/publications",
  tags: [tag],
  summary: "Get company publications (W11)",
  request: { params: CompanyIdParam },
  responses: {
    200: {
      content: {
        "application/json": { schema: z.object({ items: z.array(CompanyPublicationShape) }) },
      },
      description: "publications",
    },
    ...errorResponses,
  },
});

companiesRouter.openapi(publicationsRoute, async (c) => {
  const { companyId } = c.req.valid("param");
  const upstream = await callUpstream<unknown>(
    c,
    "companyPublication",
    `/api/v1/company-publications/${encodeURIComponent(companyId)}`,
  );
  const items = (Array.isArray(upstream)
    ? upstream
    : ((upstream as { items?: unknown[] })?.items ?? [])) as Array<z.infer<typeof CompanyPublicationShape>>;
  return c.json({ items }, 200);
});

// ---- GET /v1/companies/:companyId/contacts ---------------------------------

const contactsRoute = createRoute({
  method: "get",
  path: "/companies/{companyId}/contacts",
  tags: [tag],
  summary: "Get company contacts (W12)",
  request: { params: CompanyIdParam },
  responses: {
    200: {
      content: { "application/json": { schema: z.object({ items: z.array(CompanyContactShape) }) } },
      description: "contacts",
    },
    ...errorResponses,
  },
});

companiesRouter.openapi(contactsRoute, async (c) => {
  const { companyId } = c.req.valid("param");
  const upstream = await callUpstream<unknown>(
    c,
    "companyContact",
    `/api/v1/company-contacts/${encodeURIComponent(companyId)}`,
  );
  const items = (Array.isArray(upstream)
    ? upstream
    : ((upstream as { items?: unknown[] })?.items ?? [])) as Array<z.infer<typeof CompanyContactShape>>;
  return c.json({ items }, 200);
});

// ---- GET /v1/companies/:companyId/structured-content -----------------------

const structuredContentRoute = createRoute({
  method: "get",
  path: "/companies/{companyId}/structured-content",
  tags: [tag],
  summary: "Get structured content (W13)",
  request: { params: CompanyIdParam },
  responses: {
    200: {
      content: { "application/json": { schema: StructuredContentShape } },
      description: "structured content",
    },
    ...errorResponses,
  },
});

companiesRouter.openapi(structuredContentRoute, async (c) => {
  const { companyId } = c.req.valid("param");
  const upstream = await callUpstream<z.infer<typeof StructuredContentShape>>(
    c,
    "structuredContent",
    `/api/v1/structured-contents/${encodeURIComponent(companyId)}`,
  );
  return c.json(upstream, 200);
});

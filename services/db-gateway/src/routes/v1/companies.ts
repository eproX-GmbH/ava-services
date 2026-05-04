import { OpenAPIHono, createRoute, z } from "@hono/zod-openapi";
import { HTTPException } from "hono/http-exception";
import { requireScope } from "../../middleware/auth";
import { callUpstream } from "../../lib/upstream";
import { getProducerPool } from "../../lib/producer-pools";
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
  // master-data canonical shape is `{ count, germanCompanies }` (see
  // master-data/src/application/germany/companies/queries/fuzzy-search-companies).
  // Tolerate `items`/array too in case some other upstream ever ends up here,
  // but read the canonical fields first or the search will silently look empty.
  const u = upstream as
    | unknown[]
    | { germanCompanies?: unknown[]; items?: unknown[]; count?: number; total?: number }
    | null
    | undefined;
  const items = (
    Array.isArray(u) ? u : (u?.germanCompanies ?? u?.items ?? [])
  ) as Array<z.infer<typeof CompanyShape>>;
  const total = (Array.isArray(u) ? u.length : (u?.count ?? u?.total ?? items.length));
  return c.json({ items, total }, 200);
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
  // Canonical response shape is `{count, pageNumber, pageSize, germanCompanies}`
  // (see master-data list-companies query). Tolerate `items`/`total` as a
  // fallback in case anything else ever ends up wired here.
  const upstream = await callUpstream<unknown>(
    c,
    "masterData",
    "/api/germany/v1/companies",
    { method: "POST", query: { pageNumber: page, pageSize }, body: {} },
  );
  const u = upstream as
    | { germanCompanies?: unknown[]; items?: unknown[]; count?: number; total?: number }
    | null
    | undefined;
  const items = (u?.germanCompanies ?? u?.items ?? []) as Array<z.infer<typeof CompanyShape>>;
  const total = u?.count ?? u?.total ?? items.length;
  return c.json({ items, page, pageSize, total }, 200);
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

// §8.v3: company-profile lives only on the user's device now (compute
// path) + cloud db-gateway (persist path + reads). Gateway reads MPG
// directly via the producer-pool helper instead of proxying to a fly
// upstream that no longer exists.
companiesRouter.openapi(profileRoute, async (c) => {
  const { companyId } = c.req.valid("param");
  const pool = getProducerPool("company-profile");
  const profileRow = await pool.query<{
    id: string;
    profile: string;
    url: string | null;
    businessPurpose: string | null;
    createdAt: Date;
    updatedAt: Date;
  }>(
    `SELECT id, profile, url, "businessPurpose", "createdAt", "updatedAt"
     FROM "CompanyProfile" WHERE id = $1 LIMIT 1`,
    [companyId],
  );
  if (profileRow.rowCount === 0) {
    throw new HTTPException(404, { message: "not_found" });
  }
  const row = profileRow.rows[0];
  const keywordsRows = await pool.query<{ keyword: string }>(
    `SELECT keyword FROM "CompanyKeyword" WHERE "companyId" = $1 ORDER BY keyword`,
    [companyId],
  );
  const payload: z.infer<typeof CompanyProfileShape> = {
    id: row.id,
    profile: row.profile,
    url: row.url ?? null,
    businessPurpose: row.businessPurpose ?? null,
    keywords: keywordsRows.rows.map((r) => r.keyword),
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
  };
  return c.json(payload, 200);
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

// §8.v3 — direct MPG read (see profileRoute above).
companiesRouter.openapi(keywordsRoute, async (c) => {
  const { companyId } = c.req.valid("param");
  const pool = getProducerPool("company-profile");
  const rows = await pool.query<{
    companyId: string;
    keyword: string;
    createdAt: Date;
    updatedAt: Date;
  }>(
    `SELECT "companyId", keyword, "createdAt", "updatedAt"
     FROM "CompanyKeyword" WHERE "companyId" = $1 ORDER BY keyword`,
    [companyId],
  );
  const items: Array<z.infer<typeof CompanyKeywordShape>> = rows.rows.map((r) => ({
    companyId: r.companyId,
    keyword: r.keyword,
    createdAt: r.createdAt.toISOString(),
    updatedAt: r.updatedAt.toISOString(),
  }));
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

// §8.v3 — website is localized; gateway reads MPG directly. The
// composite shape merges Website + CompanySerp; deepResearches +
// jobPostings still come from their owners later (placeholders for
// now since their producers haven't localized yet).
companiesRouter.openapi(websiteRoute, async (c) => {
  const { companyId } = c.req.valid("param");
  const pool = getProducerPool("website");
  const websiteRow = await pool.query<{
    companyId: string;
    siteName: string | null;
    description: string | null;
    tags: string[];
    createdAt: Date;
    updatedAt: Date;
  }>(
    `SELECT "companyId", "siteName", description, tags, "createdAt", "updatedAt"
     FROM "Website" WHERE "companyId" = $1 LIMIT 1`,
    [companyId],
  );
  const serpRow = await pool.query<{
    companyId: string;
    url: string | null;
    companyNickname: string | null;
    category: string | null;
    latitude: number | null;
    longitude: number | null;
    address: string | null;
    phone: string | null;
    rating: number | null;
    reviewCount: number | null;
    createdAt: Date;
    updatedAt: Date;
  }>(
    `SELECT "companyId", url, "companyNickname", category, latitude, longitude,
            address, phone, rating, "reviewCount", "createdAt", "updatedAt"
     FROM "CompanySerp" WHERE "companyId" = $1 LIMIT 1`,
    [companyId],
  );
  const payload: z.infer<typeof WebsiteShape> = {
    website: websiteRow.rows[0]
      ? {
          companyId: websiteRow.rows[0].companyId,
          siteName: websiteRow.rows[0].siteName ?? null,
          description: websiteRow.rows[0].description ?? null,
          tags: websiteRow.rows[0].tags ?? [],
          createdAt: websiteRow.rows[0].createdAt.toISOString(),
          updatedAt: websiteRow.rows[0].updatedAt.toISOString(),
        }
      : undefined,
    companySerp: serpRow.rows[0]
      ? {
          companyId: serpRow.rows[0].companyId,
          url: serpRow.rows[0].url ?? null,
          companyNickname: serpRow.rows[0].companyNickname ?? null,
          category: serpRow.rows[0].category ?? null,
          latitude: serpRow.rows[0].latitude ?? null,
          longitude: serpRow.rows[0].longitude ?? null,
          address: serpRow.rows[0].address ?? null,
          phone: serpRow.rows[0].phone ?? null,
          rating: serpRow.rows[0].rating ?? null,
          reviewCount: serpRow.rows[0].reviewCount ?? null,
          createdAt: serpRow.rows[0].createdAt.toISOString(),
          updatedAt: serpRow.rows[0].updatedAt.toISOString(),
        }
      : undefined,
    // deepResearches + jobPostings still come from their (legacy)
    // fly producers. When those localize, replace with direct MPG
    // reads against their tables.
    deepResearches: [],
    jobPostings: [],
  };
  return c.json(payload, 200);
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
      content: { "application/json": { schema: CompanyContactShape } },
      description: "contacts",
    },
    ...errorResponses,
  },
});

companiesRouter.openapi(contactsRoute, async (c) => {
  const { companyId } = c.req.valid("param");
  // Upstream returns a single CompanyContact aggregate (not a list) — see
  // company-contact/web/api/controllers/v1/company-contacts-controller.ts.
  // Earlier wrapping into `{items: [...]}` always produced an empty list.
  const upstream = await callUpstream<z.infer<typeof CompanyContactShape>>(
    c,
    "companyContact",
    `/api/v1/company-contacts/${encodeURIComponent(companyId)}`,
  );
  return c.json(upstream, 200);
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

// §8.v3 — structured-content lives only on the user's device now;
// gateway reads MPG directly. JOINs the ManagingDirector children
// in a second query to keep the two SQL statements simple.
companiesRouter.openapi(structuredContentRoute, async (c) => {
  const { companyId } = c.req.valid("param");
  const pool = getProducerPool("structured-content");
  const sc = await pool.query<{
    companyId: string;
    name: string | null;
    corporatePurpose: string | null;
    shareCapital: string | null;
    legalForm: string | null;
    street: string | null;
    houseNumber: string | null;
    zipCode: string | null;
    city: string | null;
    foundingYear: number | null;
    lastRegisterEntry: Date | null;
    lastRegisterModification: Date | null;
    createdAt: Date;
    updatedAt: Date;
  }>(
    `SELECT "companyId", name, "corporatePurpose", "shareCapital", "legalForm",
            street, "houseNumber", "zipCode", city, "foundingYear",
            "lastRegisterEntry", "lastRegisterModification", "createdAt", "updatedAt"
     FROM "StructuredContent" WHERE "companyId" = $1 LIMIT 1`,
    [companyId],
  );
  if (sc.rowCount === 0) {
    throw new HTTPException(404, { message: "not_found" });
  }
  const row = sc.rows[0];
  const mds = await pool.query<{
    firstName: string;
    lastName: string;
    birthDay: Date | null;
    city: string | null;
  }>(
    `SELECT "firstName", "lastName", "birthDay", city
     FROM "ManagingDirector" WHERE "companyId" = $1
     ORDER BY id`,
    [companyId],
  );
  const payload: z.infer<typeof StructuredContentShape> = {
    companyId: row.companyId,
    name: row.name ?? null,
    corporatePurpose: row.corporatePurpose ?? null,
    // Existing schema declares shareCapital + foundingYear as strings
    // for OpenAPI compatibility; coerce numerics to strings here.
    shareCapital:
      row.shareCapital === null || row.shareCapital === undefined
        ? null
        : String(row.shareCapital),
    legalForm: row.legalForm ?? null,
    street: row.street ?? null,
    houseNumber: row.houseNumber ?? null,
    zipCode: row.zipCode ?? null,
    city: row.city ?? null,
    foundingYear:
      row.foundingYear === null || row.foundingYear === undefined
        ? null
        : String(row.foundingYear),
    lastRegisterEntry: row.lastRegisterEntry
      ? row.lastRegisterEntry.toISOString()
      : null,
    lastRegisterModification: row.lastRegisterModification
      ? row.lastRegisterModification.toISOString()
      : null,
    managingDirectors: mds.rows.map((md) => ({
      firstName: md.firstName,
      lastName: md.lastName,
      birthDay: md.birthDay ? md.birthDay.toISOString() : null,
      city: md.city ?? null,
    })),
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
  };
  return c.json(payload, 200);
});

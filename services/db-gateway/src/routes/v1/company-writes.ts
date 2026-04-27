import { OpenAPIHono, createRoute } from "@hono/zod-openapi";
import { requireScope } from "../../middleware/auth";
import { callUpstream } from "../../lib/upstream";
import {
  CompanyIdParam,
  CompanyProfileShape,
  CompanyProfileUpsertBody,
  CompanyPublicationShape,
  CompanyPublicationsUpsertBody,
  CompanyWebsiteUpsertBody,
  ErrorShape,
  WebsiteShape,
} from "./schemas";
import { z } from "@hono/zod-openapi";

// =============================================================================
// §5.3 Manual corrections (W23, W24, W25).
//
// Three "re-scrape" upserts the desktop client triggers when an analyst
// notices a row needs refreshing. Each one fans out to a different upstream
// service (company-profile / website / company-publication) and each one
// already exists upstream as the same command master-data fires through the
// CloudEvent fan-out — these gateway routes just expose the *manual* trigger
// path the desktop UI needs.
//
// Spec ↔ upstream drift (DESKTOP_DATA_FLOW.md §5.3 was aspirational):
//   - profile: spec implies "upsert profile fields"; upstream actually
//     re-fetches a URL ({companyId,url}). Adopted upstream — desktop sends
//     just `url`, gateway injects companyId from the path.
//   - website: upstream wants {companyId, companyName, street, zipCode,
//     city}; not field-level edits. Adopted upstream.
//   - publications: spec was `/publications/:year` (per-year row); upstream
//     scrapes ALL years for the company in one shot. Path simplified to
//     `/publications` (no :year). Per-year manual edit is upstream work
//     tracked in §11.
//
// Companies are global per D2 — no per-tenant ownership column on company
// entities. JWT scope+tenant gate is the protection here.
// =============================================================================

export const companyWritesRouter = new OpenAPIHono();
companyWritesRouter.use("*", requireScope("company:write"));

const tag = "companies";
const errorResponses = {
  400: { content: { "application/json": { schema: ErrorShape } }, description: "bad request" },
  401: { content: { "application/json": { schema: ErrorShape } }, description: "unauthenticated" },
  403: { content: { "application/json": { schema: ErrorShape } }, description: "forbidden" },
  404: { content: { "application/json": { schema: ErrorShape } }, description: "not found" },
  429: { content: { "application/json": { schema: ErrorShape } }, description: "rate limited" },
  502: { content: { "application/json": { schema: ErrorShape } }, description: "upstream failure" },
} as const;

// ---- PUT /v1/companies/:companyId/profile ----------------------------------
//
// Upstream is POST /api/v1/company-profiles {companyId, url}. We use PUT at
// the gateway (matches the REST shape of "upsert this resource"); the path
// carries companyId. `isSkippable` is forwarded as a query string per
// upstream's controller.

const profileUpsertRoute = createRoute({
  method: "put",
  path: "/companies/{companyId}/profile",
  tags: [tag],
  summary: "Re-scrape company profile from a URL (W23)",
  request: {
    params: CompanyIdParam,
    body: { content: { "application/json": { schema: CompanyProfileUpsertBody } }, required: true },
  },
  responses: {
    200: {
      content: { "application/json": { schema: CompanyProfileShape } },
      description: "updated profile (or empty 204 upstream → empty body)",
    },
    204: { description: "upstream returned no body" },
    ...errorResponses,
  },
});

companyWritesRouter.openapi(profileUpsertRoute, async (c) => {
  const { companyId } = c.req.valid("param");
  const { url, isSkippable } = c.req.valid("json");

  // Upstream is POST + body, with isSkippable on the query string.
  const upstream = await callUpstream<z.infer<typeof CompanyProfileShape> | undefined>(
    c,
    "companyProfile",
    `/api/v1/company-profiles${
      isSkippable !== undefined ? `?isSkippable=${isSkippable ? "true" : "false"}` : ""
    }`,
    { method: "POST", body: { companyId, url } },
  );
  if (!upstream) return c.body(null, 204);
  return c.json(upstream, 200);
});

// ---- PUT /v1/companies/:companyId/website ----------------------------------

const websiteUpsertRoute = createRoute({
  method: "put",
  path: "/companies/{companyId}/website",
  tags: [tag],
  summary: "Re-scrape website data for a company (W24)",
  request: {
    params: CompanyIdParam,
    body: { content: { "application/json": { schema: CompanyWebsiteUpsertBody } }, required: true },
  },
  responses: {
    200: {
      content: { "application/json": { schema: WebsiteShape } },
      description: "updated website composite",
    },
    204: { description: "upstream returned no body" },
    ...errorResponses,
  },
});

companyWritesRouter.openapi(websiteUpsertRoute, async (c) => {
  const { companyId } = c.req.valid("param");
  const { companyName, street, zipCode, city, isSkippable } = c.req.valid("json");

  const upstream = await callUpstream<z.infer<typeof WebsiteShape> | undefined>(
    c,
    "website",
    `/api/v1/websites${
      isSkippable !== undefined ? `?isSkippable=${isSkippable ? "true" : "false"}` : ""
    }`,
    { method: "PUT", body: { companyId, companyName, street, zipCode, city } },
  );
  if (!upstream) return c.body(null, 204);
  return c.json(upstream, 200);
});

// ---- PUT /v1/companies/:companyId/publications -----------------------------
//
// Upstream PUT /api/v1/company-publications {companyId, companyName,
// companyLocation} — re-scrapes the full set of yearly rows for the company.
// Returns the upserted publication record (CompanyPublicationShape).
//
// Note re §5.3 spec drift: the spec wrote `/publications/:year` to upsert a
// single year row, but no such upstream endpoint exists today. We expose the
// only operation upstream supports; per-year manual edit is open follow-up.

const publicationsUpsertRoute = createRoute({
  method: "put",
  path: "/companies/{companyId}/publications",
  tags: [tag],
  summary: "Re-scrape publications for a company (W25)",
  request: {
    params: CompanyIdParam,
    body: {
      content: { "application/json": { schema: CompanyPublicationsUpsertBody } },
      required: true,
    },
  },
  responses: {
    200: {
      content: { "application/json": { schema: CompanyPublicationShape } },
      description: "upserted publication record",
    },
    ...errorResponses,
  },
});

companyWritesRouter.openapi(publicationsUpsertRoute, async (c) => {
  const { companyId } = c.req.valid("param");
  const { companyName, companyLocation } = c.req.valid("json");

  const upstream = await callUpstream<z.infer<typeof CompanyPublicationShape>>(
    c,
    "companyPublication",
    "/api/v1/company-publications",
    { method: "PUT", body: { companyId, companyName, companyLocation } },
  );
  return c.json(upstream, 200);
});

import { OpenAPIHono, createRoute } from "@hono/zod-openapi";
import { HTTPException } from "hono/http-exception";
import { requireScope } from "../../middleware/auth";
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

// =============================================================================
// §5.3 Manual corrections (W23, W24, W25) — STUBBED FOR §8.v3.
//
// These three "re-scrape this single company" trigger routes used to call
// fly's company-profile / website / company-publication upstream. With those
// fly apps decommissioned (§8.v3) and the producers running locally on the
// user's desktop, the correct path is for the gateway to publish an AMQP
// work event the local producer subscribes to.
//
// We haven't built that publish path yet — the desktop UI doesn't currently
// expose the manual re-scrape buttons (see desktop CompanyDetail.tsx — only
// GETs against the read endpoints). Until it does, returning 501 Not
// Implemented is honest: the route exists in the OpenAPI spec but the
// trigger path is pending.
//
// When the desktop adds the re-scrape buttons, replace each handler with:
//   - Build the same CloudEvent the legacy producer's controller built
//     (e.g. `website.upsertCompanyProfile` for profile)
//   - Publish via a shared gateway AMQPClient (mirrors master-data's
//     consolidated publisher)
//   - Return 202 Accepted; the persist event flow + EntityProgress write
//     surface completion via SSE / the entities endpoint
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
  // §8.v3 — upstream fly company-profile is gone; AMQP publish path is
  // not yet built (see file header). Return 501 so callers see "not
  // implemented" rather than a 502.
  void c.req.valid("param");
  void c.req.valid("json");
  throw new HTTPException(501, {
    message: "company-profile re-scrape trigger pending §8.v3 AMQP publish path",
  });
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
  void c.req.valid("param");
  void c.req.valid("json");
  throw new HTTPException(501, {
    message: "website re-scrape trigger pending §8.v3 AMQP publish path",
  });
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
  void c.req.valid("param");
  void c.req.valid("json");
  throw new HTTPException(501, {
    message: "publications re-scrape trigger pending §8.v3 AMQP publish path",
  });
});

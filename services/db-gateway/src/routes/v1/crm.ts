// v0.1.54 — CRM OAuth proxy (Salesforce / HubSpot / Dynamics).
//
// The desktop hits these endpoints to:
//   1. Get a fully-built authorize URL (with the operator's
//      `client_id` baked in — desktops don't ship the IDs).
//   2. Exchange an OAuth code for access + refresh tokens. HubSpot
//      requires `client_secret` here which only lives on the
//      operator's fly secrets.
//   3. Refresh expired access tokens.
//
// All endpoints are JWT-gated (the existing app middleware) so a
// random caller can't drive OAuth flows on behalf of the operator's
// CRM apps.
//
// Provider configuration uses fly secrets:
//   SALESFORCE_CLIENT_ID            (public client; no secret)
//   SALESFORCE_LOGIN_BASE           (defaults to login.salesforce.com)
//   HUBSPOT_CLIENT_ID
//   HUBSPOT_CLIENT_SECRET
//   DYNAMICS_CLIENT_ID
//
// Per-user OAuth tokens NEVER touch the gateway DB — the desktop
// stores them in OS keychain. The gateway is a stateless transit
// layer for the IdP exchanges only.

import { OpenAPIHono, createRoute, z } from "@hono/zod-openapi";
import { HTTPException } from "hono/http-exception";
import { loadEnv } from "../../lib/env";
import { logger } from "../../lib/logger";

export const crmRouter = new OpenAPIHono();

const env = loadEnv();

const ProviderParam = z
  .object({
    provider: z
      .enum(["salesforce", "hubspot", "dynamics"])
      .openapi({ param: { name: "provider", in: "path" } }),
  })
  .openapi("CrmProviderParam");

const AuthorizeUrlQuery = z
  .object({
    /** Same provider as the path; convenient for telemetry. */
    provider: z.enum(["salesforce", "hubspot", "dynamics"]).optional(),
    /** PKCE S256 challenge from the desktop. */
    codeChallenge: z.string().min(40),
    /** Anti-CSRF state echo. */
    state: z.string().min(8),
    /** Loopback redirect the desktop is listening on. */
    redirectUri: z.string().url(),
    /** Dynamics org URL (host-only; we'll construct the resource
     *  scope from it). Ignored by Salesforce / HubSpot. */
    orgUrl: z.string().min(1).optional(),
  })
  .openapi("CrmAuthorizeUrlQuery");

const AuthorizeUrlResponse = z
  .object({
    authorizeUrl: z.string().url(),
    state: z.string(),
    redirectUri: z.string().url(),
  })
  .openapi("CrmAuthorizeUrlResponse");

const ExchangeBody = z
  .object({
    provider: z.enum(["salesforce", "hubspot", "dynamics"]),
    code: z.string().min(1),
    codeVerifier: z.string().min(40),
    redirectUri: z.string().url(),
    orgUrl: z.string().min(1).optional(),
  })
  .openapi("CrmExchangeBody");

const ExchangeResponse = z
  .object({
    accessToken: z.string(),
    refreshToken: z.string().nullable(),
    expiresIn: z.number().int().positive(),
    extra: z.record(z.string()),
    account: z.string(),
  })
  .openapi("CrmExchangeResponse");

const RefreshBody = z
  .object({
    refreshToken: z.string().min(1),
    orgUrl: z.string().min(1).optional(),
  })
  .openapi("CrmRefreshBody");

// =============================================================================
// Provider config
// =============================================================================

interface ProviderConfig {
  authorizeUrl: string;
  tokenUrl: string;
  clientId: string;
  /** Set when the provider requires a confidential client (HubSpot). */
  clientSecret?: string;
  scope: string;
  /** Some providers (Salesforce) return per-org instance URLs in the
   *  token response that the API client needs. Maps the field name
   *  in the IdP response to the key in our `extra` output. */
  extraFields: Record<string, string>;
  /** Builds the display label from the IdP token response. */
  buildAccount: (
    tokenResponse: Record<string, unknown>,
    orgUrl: string | undefined,
  ) => string;
}

function configFor(provider: "salesforce" | "hubspot" | "dynamics"): ProviderConfig {
  switch (provider) {
    case "salesforce": {
      if (!env.SALESFORCE_CLIENT_ID) {
        throw new HTTPException(503, {
          message: "salesforce_not_configured",
        });
      }
      const base =
        env.SALESFORCE_LOGIN_BASE ?? "https://login.salesforce.com";
      return {
        authorizeUrl: `${base}/services/oauth2/authorize`,
        tokenUrl: `${base}/services/oauth2/token`,
        clientId: env.SALESFORCE_CLIENT_ID,
        scope: "api refresh_token",
        extraFields: { instance_url: "instanceUrl" },
        buildAccount: (r) => {
          const instance = (r["instance_url"] as string | undefined) ?? "";
          const id = (r["id"] as string | undefined) ?? "";
          // Salesforce's `id` is an identity URL like
          // https://login.salesforce.com/id/<orgId>/<userId>; we
          // surface it verbatim — the renderer can shorten if it wants.
          return [instance, id].filter(Boolean).join(" · ") || "Salesforce";
        },
      };
    }
    case "hubspot": {
      if (!env.HUBSPOT_CLIENT_ID || !env.HUBSPOT_CLIENT_SECRET) {
        throw new HTTPException(503, { message: "hubspot_not_configured" });
      }
      return {
        authorizeUrl: "https://app.hubspot.com/oauth/authorize",
        tokenUrl: "https://api.hubapi.com/oauth/v1/token",
        clientId: env.HUBSPOT_CLIENT_ID,
        clientSecret: env.HUBSPOT_CLIENT_SECRET,
        scope:
          "crm.objects.contacts.read crm.objects.contacts.write " +
          "crm.objects.companies.read crm.objects.companies.write " +
          "crm.objects.deals.read crm.objects.deals.write",
        extraFields: { hub_id: "hubId" },
        buildAccount: (r) => {
          const hubId = r["hub_id"];
          return hubId ? `HubSpot Portal ${hubId}` : "HubSpot";
        },
      };
    }
    case "dynamics": {
      if (!env.DYNAMICS_CLIENT_ID) {
        throw new HTTPException(503, { message: "dynamics_not_configured" });
      }
      return {
        authorizeUrl:
          "https://login.microsoftonline.com/common/oauth2/v2.0/authorize",
        tokenUrl: "https://login.microsoftonline.com/common/oauth2/v2.0/token",
        clientId: env.DYNAMICS_CLIENT_ID,
        // Dynamics scope is per-org: `<orgUrl>/.default offline_access`.
        // The actual scope string is built at authorize-time once we
        // know orgUrl; placeholder here.
        scope: "offline_access",
        extraFields: {},
        buildAccount: (_r, orgUrl) => orgUrl ?? "Microsoft Dynamics",
      };
    }
  }
}

// =============================================================================
// GET /v1/crm/:provider/authorize-url
// =============================================================================

const authorizeUrlRoute = createRoute({
  method: "get",
  path: "/crm/{provider}/authorize-url",
  tags: ["crm"],
  summary: "Build the OAuth authorize URL for the given CRM provider",
  request: { params: ProviderParam, query: AuthorizeUrlQuery },
  responses: {
    200: {
      content: { "application/json": { schema: AuthorizeUrlResponse } },
      description: "authorize URL + echoed state",
    },
  },
});

crmRouter.openapi(authorizeUrlRoute, async (c) => {
  const { provider } = c.req.valid("param");
  const { codeChallenge, state, redirectUri, orgUrl } = c.req.valid("query");
  const cfg = configFor(provider);

  const params = new URLSearchParams({
    response_type: "code",
    client_id: cfg.clientId,
    redirect_uri: redirectUri,
    state,
    code_challenge: codeChallenge,
    code_challenge_method: "S256",
  });

  if (provider === "dynamics") {
    if (!orgUrl) {
      throw new HTTPException(400, { message: "dynamics_orgUrl_required" });
    }
    // Dynamics resource scope = `<https://orgUrl>/.default`. orgUrl
    // can come in as either bare host or with scheme; normalize.
    const normalizedOrg = orgUrl.startsWith("http")
      ? orgUrl
      : `https://${orgUrl}`;
    params.set("scope", `${normalizedOrg}/.default offline_access`);
  } else {
    params.set("scope", cfg.scope);
  }

  return c.json(
    {
      authorizeUrl: `${cfg.authorizeUrl}?${params.toString()}`,
      state,
      redirectUri,
    },
    200,
  );
});

// =============================================================================
// POST /v1/crm/:provider/exchange — code → access + refresh tokens
// =============================================================================

const exchangeRoute = createRoute({
  method: "post",
  path: "/crm/{provider}/exchange",
  tags: ["crm"],
  summary: "Exchange an OAuth authorization code for tokens",
  request: {
    params: ProviderParam,
    body: { content: { "application/json": { schema: ExchangeBody } }, required: true },
  },
  responses: {
    200: {
      content: { "application/json": { schema: ExchangeResponse } },
      description: "tokens",
    },
  },
});

crmRouter.openapi(exchangeRoute, async (c) => {
  const { provider } = c.req.valid("param");
  const body = c.req.valid("json");
  const cfg = configFor(provider);

  const form = new URLSearchParams({
    grant_type: "authorization_code",
    code: body.code,
    redirect_uri: body.redirectUri,
    client_id: cfg.clientId,
    code_verifier: body.codeVerifier,
  });
  if (cfg.clientSecret) {
    form.set("client_secret", cfg.clientSecret);
  }

  const resp = await idpTokenCall(cfg.tokenUrl, form, provider);
  return c.json(buildExchangeResponse(resp, cfg, body.orgUrl), 200);
});

// =============================================================================
// POST /v1/crm/:provider/refresh
// =============================================================================

const refreshRoute = createRoute({
  method: "post",
  path: "/crm/{provider}/refresh",
  tags: ["crm"],
  summary: "Refresh a CRM access token",
  request: {
    params: ProviderParam,
    body: { content: { "application/json": { schema: RefreshBody } }, required: true },
  },
  responses: {
    200: {
      content: { "application/json": { schema: ExchangeResponse } },
      description: "refreshed tokens",
    },
  },
});

crmRouter.openapi(refreshRoute, async (c) => {
  const { provider } = c.req.valid("param");
  const { refreshToken, orgUrl } = c.req.valid("json");
  const cfg = configFor(provider);

  const form = new URLSearchParams({
    grant_type: "refresh_token",
    refresh_token: refreshToken,
    client_id: cfg.clientId,
  });
  if (cfg.clientSecret) {
    form.set("client_secret", cfg.clientSecret);
  }
  // Some providers (Microsoft, Salesforce) want the same scope on
  // refresh as on the original authorize.
  if (provider === "dynamics" && orgUrl) {
    const normalizedOrg = orgUrl.startsWith("http") ? orgUrl : `https://${orgUrl}`;
    form.set("scope", `${normalizedOrg}/.default offline_access`);
  } else if (provider !== "dynamics") {
    form.set("scope", cfg.scope);
  }

  const resp = await idpTokenCall(cfg.tokenUrl, form, provider);
  return c.json(buildExchangeResponse(resp, cfg, orgUrl), 200);
});

// =============================================================================
// helpers
// =============================================================================

async function idpTokenCall(
  url: string,
  form: URLSearchParams,
  provider: string,
): Promise<Record<string, unknown>> {
  const res = await fetch(url, {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: form.toString(),
  });
  const text = await res.text();
  if (!res.ok) {
    logger.warn(
      { provider, status: res.status, body: text.slice(0, 200) },
      "crm: IdP token call failed",
    );
    throw new HTTPException(502, {
      message: `crm_token_call_failed: ${res.status} ${text.slice(0, 200)}`,
    });
  }
  try {
    return JSON.parse(text) as Record<string, unknown>;
  } catch {
    throw new HTTPException(502, { message: "crm_token_invalid_json" });
  }
}

function buildExchangeResponse(
  raw: Record<string, unknown>,
  cfg: ProviderConfig,
  orgUrl: string | undefined,
): {
  accessToken: string;
  refreshToken: string | null;
  expiresIn: number;
  extra: Record<string, string>;
  account: string;
} {
  const accessToken = String(raw["access_token"] ?? "");
  if (!accessToken) {
    throw new HTTPException(502, { message: "crm_no_access_token" });
  }
  const refreshToken = (raw["refresh_token"] as string | undefined) ?? null;
  const expiresIn = Number(raw["expires_in"] ?? 3600);
  const extra: Record<string, string> = {};
  for (const [src, dst] of Object.entries(cfg.extraFields)) {
    const v = raw[src];
    if (typeof v === "string") extra[dst] = v;
  }
  if (orgUrl) {
    extra.orgUrl = orgUrl;
  }
  return {
    accessToken,
    refreshToken,
    expiresIn,
    extra,
    account: cfg.buildAccount(raw, orgUrl),
  };
}

// MCP-OAuth (docs/PLAN_MCP_OEFFNUNG.md, P0): Discovery und Client-Registrierung.
//
// MCP-Clients (Claude.ai, Claude Code, ChatGPT) finden ueber die Protected-
// Resource-Metadata den Autorisierungsserver, lesen dessen Metadata und
// registrieren sich dynamisch (RFC 7591). Keycloak laesst anonyme
// Registrierung nur mit Initial-Access-Token zu, deshalb uebernimmt das
// Gateway die Registrierung: es legt den Client ueber die Admin-API an
// (Service-Account `ava-registrar`, Rollen manage-clients + view-clients)
// und kopiert die Client-Scopes des Desktop-Clients, damit die Tokens
// dieselben Scopes tragen (company:read, import:write, …).
//
// Issuer der Metadata ist das Gateway (`<public>/mcp/oauth`), die Endpunkte
// fuer Autorisierung und Token zeigen auf Keycloak. Die Access-Tokens sind
// normale Realm-Tokens; die Auth-Middleware prueft sie wie die der App.
//
// Alles hier ist OEFFENTLICH (kein Bearer). Schutz: Allowlist der
// Redirect-Hosts, Rate-Limit je Adresse, Namenspraefix `mcp-`.

import { Hono } from "hono";
import type { Context } from "hono";
import { loadEnv } from "../lib/env";
import { logger } from "../lib/logger";
import { createMcpClient, RegistrationDisabledError } from "../lib/keycloak-admin";

export const mcpOauthRouter = new Hono();

const SCOPES_SUPPORTED = ["openid", "offline_access"];

/** Erlaubte Redirect-Ziele: die bekannten MCP-Clients und lokale Werkzeuge. */
const REDIRECT_ERLAUBT: RegExp[] = [
  /^https:\/\/claude\.ai\//,
  /^https:\/\/claude\.com\//,
  /^https:\/\/[a-z0-9.-]+\.anthropic\.com\//,
  /^https:\/\/chatgpt\.com\//,
  /^https:\/\/chat\.openai\.com\//,
  /^https:\/\/platform\.openai\.com\//,
  /^http:\/\/localhost(:\d+)?\//,
  /^http:\/\/127\.0\.0\.1(:\d+)?\//,
  /^https:\/\/localhost(:\d+)?\//,
];

/**
 * Zwei Adressen fuer denselben Endpunkt (docs/PLAN_MCP_OEFFNUNG.md):
 *   https://<gateway>/mcp  mit OAuth unter /mcp/oauth   (Fly-Hostname)
 *   https://mcp.ava.bi     mit OAuth unter /oauth        (eigener Host)
 * Die Metadata muss zur aufgerufenen Adresse passen, sonst lehnen Clients
 * den Issuer ab. Deshalb haengt alles am Host-Header.
 */
export interface McpBasis {
  base: string;
  mcpPfad: string;
  oauthPfad: string;
  eigenerHost: boolean;
}

export function mcpBasis(hostHeader: string | undefined): McpBasis {
  const env = loadEnv();
  const host = (hostHeader ?? "").toLowerCase().split(":")[0];
  if (host && host === env.MCP_PUBLIC_HOST.toLowerCase()) {
    return { base: `https://${host}`, mcpPfad: "", oauthPfad: "/oauth", eigenerHost: true };
  }
  return { base: env.GATEWAY_PUBLIC_URL.replace(/\/+$/, ""), mcpPfad: "/mcp", oauthPfad: "/mcp/oauth", eigenerHost: false };
}

export function istMcpHost(hostHeader: string | undefined): boolean {
  return mcpBasis(hostHeader).eigenerHost;
}

function realmUrl(): string | null {
  const u = loadEnv().KEYCLOAK_REALM_URL;
  return u ? u.replace(/\/+$/, "") : null;
}

function resourceMetadata(b: McpBasis) {
  return {
    resource: `${b.base}${b.mcpPfad}`,
    authorization_servers: [`${b.base}${b.oauthPfad}`],
    scopes_supported: SCOPES_SUPPORTED,
    bearer_methods_supported: ["header"],
    resource_name: "AVA",
    resource_documentation: "https://ava.bi",
  };
}

function authorizationServerMetadata(b: McpBasis) {
  const realm = realmUrl();
  if (!realm) return null;
  return {
    issuer: `${b.base}${b.oauthPfad}`,
    authorization_endpoint: `${realm}/protocol/openid-connect/auth`,
    token_endpoint: `${realm}/protocol/openid-connect/token`,
    revocation_endpoint: `${realm}/protocol/openid-connect/revoke`,
    jwks_uri: `${realm}/protocol/openid-connect/certs`,
    registration_endpoint: `${b.base}${b.oauthPfad}/register`,
    scopes_supported: SCOPES_SUPPORTED,
    response_types_supported: ["code"],
    response_modes_supported: ["query"],
    grant_types_supported: ["authorization_code", "refresh_token"],
    token_endpoint_auth_methods_supported: ["none"],
    revocation_endpoint_auth_methods_supported: ["none"],
    code_challenge_methods_supported: ["S256"],
  };
}

// RFC 9728: Metadata der geschuetzten Ressource (mit und ohne Pfad-Suffix).
mcpOauthRouter.get("/.well-known/oauth-protected-resource", (c) => c.json(resourceMetadata(mcpBasis(c.req.header("host")))));
mcpOauthRouter.get("/.well-known/oauth-protected-resource/mcp", (c) => c.json(resourceMetadata(mcpBasis(c.req.header("host")))));

// RFC 8414: Metadata des Autorisierungsservers fuer den Issuer <base><oauthPfad>,
// sowohl am Pfad-Suffix-Ort als auch unter dem Issuer selbst.
const asMetadata = (c: { req: { header: (n: string) => string | undefined }; json: (b: unknown, s?: 200 | 503) => Response }) => {
  const m = authorizationServerMetadata(mcpBasis(c.req.header("host")));
  if (!m) return c.json({ error: "keycloak_not_configured" }, 503);
  return c.json(m);
};
mcpOauthRouter.get("/.well-known/oauth-authorization-server/mcp/oauth", asMetadata);
mcpOauthRouter.get("/mcp/oauth/.well-known/oauth-authorization-server", asMetadata);
mcpOauthRouter.get("/mcp/oauth/.well-known/openid-configuration", asMetadata);
// Eigener Host (mcp.ava.bi): OAuth unter /oauth.
mcpOauthRouter.get("/.well-known/oauth-authorization-server/oauth", asMetadata);
mcpOauthRouter.get("/oauth/.well-known/oauth-authorization-server", asMetadata);
mcpOauthRouter.get("/oauth/.well-known/openid-configuration", asMetadata);

// ---- Dynamic Client Registration (RFC 7591) --------------------------------

const REGISTRIERUNGEN = new Map<string, number[]>();
const REG_MAX_JE_STUNDE = 20;

function rateLimitOk(key: string): boolean {
  const jetzt = Date.now();
  const l = (REGISTRIERUNGEN.get(key) ?? []).filter((t) => jetzt - t < 3_600_000);
  if (l.length >= REG_MAX_JE_STUNDE) return false;
  l.push(jetzt);
  REGISTRIERUNGEN.set(key, l);
  return true;
}

async function registriere(c: Context) {
  const ip = c.req.header("fly-client-ip") ?? c.req.header("x-forwarded-for") ?? "unbekannt";
  if (!rateLimitOk(ip)) {
    return c.json({ error: "invalid_client_metadata", error_description: "Zu viele Registrierungen, spaeter erneut versuchen." }, 429);
  }
  let body: Record<string, unknown>;
  try {
    body = (await c.req.json()) as Record<string, unknown>;
  } catch {
    return c.json({ error: "invalid_client_metadata", error_description: "JSON erwartet." }, 400);
  }
  const redirectUris = Array.isArray(body.redirect_uris) ? body.redirect_uris.filter((u): u is string => typeof u === "string") : [];
  if (redirectUris.length === 0 || redirectUris.length > 10) {
    return c.json({ error: "invalid_redirect_uri", error_description: "redirect_uris fehlt oder zu viele." }, 400);
  }
  const unerlaubt = redirectUris.filter((u) => !REDIRECT_ERLAUBT.some((re) => re.test(u)));
  if (unerlaubt.length > 0) {
    return c.json({ error: "invalid_redirect_uri", error_description: `Redirect-Ziel nicht erlaubt: ${unerlaubt.join(", ")}` }, 400);
  }
  const authMethod = typeof body.token_endpoint_auth_method === "string" ? body.token_endpoint_auth_method : "none";
  if (authMethod !== "none") {
    // Nur oeffentliche Clients mit PKCE; ein Secret wuerde beim Client liegen.
    return c.json({ error: "invalid_client_metadata", error_description: "Nur token_endpoint_auth_method 'none' (PKCE)." }, 400);
  }
  const clientName = typeof body.client_name === "string" && body.client_name.trim() ? body.client_name.trim().slice(0, 80) : "MCP-Client";
  try {
    const erzeugt = await createMcpClient({ clientName, redirectUris });
    logger.info({ clientId: erzeugt.clientId, clientName, redirectUris, ip }, "[mcp-oauth] Client registriert");
    return c.json(
      {
        client_id: erzeugt.clientId,
        client_id_issued_at: Math.floor(Date.now() / 1000),
        client_name: clientName,
        redirect_uris: redirectUris,
        token_endpoint_auth_method: "none",
        grant_types: ["authorization_code", "refresh_token"],
        response_types: ["code"],
        scope: SCOPES_SUPPORTED.join(" "),
      },
      201,
    );
  } catch (err) {
    if (err instanceof RegistrationDisabledError) {
      return c.json({ error: "temporarily_unavailable", error_description: "Registrierung ist auf diesem Gateway nicht eingerichtet." }, 503);
    }
    logger.error({ err: err instanceof Error ? err.message : String(err) }, "[mcp-oauth] Registrierung fehlgeschlagen");
    return c.json({ error: "server_error", error_description: "Registrierung fehlgeschlagen." }, 500);
  }
}

mcpOauthRouter.post("/mcp/oauth/register", registriere);
mcpOauthRouter.post("/oauth/register", registriere);

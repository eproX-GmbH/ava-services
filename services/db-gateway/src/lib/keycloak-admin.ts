// In-App-Registration Helper #1 — Keycloak Admin API wrapper.
//
// Used by POST /v1/auth/register to create a new user via the
// `ava-registrar` confidential client. The client has the
// `realm-management/manage-users` service-account role; no human
// admin credentials touch the gateway.
//
// Token-Caching: client_credentials grant returns a short-lived
// access_token (~5 min typical). We cache it and refresh ~30s before
// expiry. The cache is per-process; on a multi-instance deploy each
// process holds its own copy (acceptable — same client_id, no
// contention).

import { loadEnv } from "./env";
import { logger } from "./logger";

interface CachedToken {
  accessToken: string;
  /** Unix ms when this token must be refreshed. We refresh 30s ahead
   *  of the issuer's expiry to absorb clock skew + in-flight requests. */
  refreshAt: number;
}

let cached: CachedToken | null = null;

function issuerBase(): string {
  const env = loadEnv();
  if (!env.KEYCLOAK_REALM_URL) {
    throw new RegistrationDisabledError(
      "KEYCLOAK_REALM_URL is not configured",
    );
  }
  // Strip trailing slashes once so callers can concatenate paths
  // cleanly.
  return env.KEYCLOAK_REALM_URL.replace(/\/+$/, "");
}

/** Thrown when the operator hasn't configured any of the
 *  KEYCLOAK_REGISTRAR_* env vars. The route handler turns this into
 *  a 503 "registration disabled" response, so deploys that don't
 *  want self-serve registration can simply leave the secrets unset. */
export class RegistrationDisabledError extends Error {
  readonly code = "registration_disabled";
}

/** Thrown when the underlying Keycloak Admin call returns a structured
 *  error we want to surface (409 user_exists, 400 weak password, etc.). */
export class KeycloakAdminError extends Error {
  constructor(
    public readonly status: number,
    public readonly body: string,
    public readonly errorKind:
      | "email_taken"
      | "weak_password"
      | "invalid_input"
      | "keycloak_error",
  ) {
    super(`Keycloak admin ${status}: ${body.slice(0, 200)}`);
  }
}

async function fetchServiceAccountToken(): Promise<CachedToken> {
  const env = loadEnv();
  if (
    !env.KEYCLOAK_REGISTRAR_CLIENT_ID ||
    !env.KEYCLOAK_REGISTRAR_CLIENT_SECRET
  ) {
    throw new RegistrationDisabledError(
      "KEYCLOAK_REGISTRAR_CLIENT_ID / _SECRET not configured",
    );
  }
  const body = new URLSearchParams({
    grant_type: "client_credentials",
    client_id: env.KEYCLOAK_REGISTRAR_CLIENT_ID,
    client_secret: env.KEYCLOAK_REGISTRAR_CLIENT_SECRET,
  });
  const res = await fetch(
    `${issuerBase()}/protocol/openid-connect/token`,
    {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: body.toString(),
    },
  );
  if (!res.ok) {
    const text = await res.text().catch(() => "");
    throw new KeycloakAdminError(
      res.status,
      text,
      "keycloak_error",
    );
  }
  const data = (await res.json()) as {
    access_token: string;
    expires_in: number;
  };
  // Refresh 30s ahead of stated expiry to absorb skew. Floor of 60s so
  // we never re-fetch on every request even if Keycloak hands us a
  // pathologically short token.
  const ttlMs = Math.max(60_000, data.expires_in * 1000 - 30_000);
  return {
    accessToken: data.access_token,
    refreshAt: Date.now() + ttlMs,
  };
}

async function getAdminToken(): Promise<string> {
  if (cached && cached.refreshAt > Date.now()) {
    return cached.accessToken;
  }
  cached = await fetchServiceAccountToken();
  return cached.accessToken;
}

function realmSegmentFromRealmUrl(): string {
  // KEYCLOAK_REALM_URL ends in `/realms/<name>` — extract `<name>`.
  const url = issuerBase();
  const m = url.match(/\/realms\/([^/]+)$/);
  if (!m) {
    throw new Error(
      `KEYCLOAK_REALM_URL must end in /realms/<name>: ${url}`,
    );
  }
  return m[1]!;
}

function adminBase(): string {
  // The admin API lives at `<root>/admin/realms/<name>`, where <root>
  // is the issuer URL with `/realms/<name>` stripped.
  const realm = realmSegmentFromRealmUrl();
  const root = issuerBase().replace(/\/realms\/[^/]+$/, "");
  return `${root}/admin/realms/${realm}`;
}

export interface CreateUserInput {
  email: string;
  firstName: string;
  lastName: string;
  password: string;
}

/** Returns the new user's Keycloak id. */
export async function createUser(input: CreateUserInput): Promise<string> {
  const token = await getAdminToken();
  // Keycloak's POST /users endpoint accepts `credentials` inline, which
  // means we can avoid a separate reset-password call. The user is
  // marked emailVerified:true because the operator decided to skip
  // email-verification for the initial registration UX.
  const res = await fetch(`${adminBase()}/users`, {
    method: "POST",
    headers: {
      authorization: `Bearer ${token}`,
      "content-type": "application/json",
    },
    body: JSON.stringify({
      username: input.email,
      email: input.email,
      firstName: input.firstName,
      lastName: input.lastName,
      enabled: true,
      emailVerified: true,
      credentials: [
        {
          type: "password",
          value: input.password,
          temporary: false,
        },
      ],
    }),
  });

  if (res.status === 201) {
    // Keycloak returns 201 with no body and the new id in the Location
    // header (`.../users/<uuid>`). Parse it out so callers can log
    // creation.
    const loc = res.headers.get("location") ?? "";
    const m = loc.match(/\/users\/([0-9a-f-]+)/i);
    if (!m) {
      // Defensive: still succeed because user was created, but warn.
      logger.warn(
        { loc },
        "[register] keycloak 201 without parseable Location header",
      );
      return "";
    }
    return m[1]!;
  }

  // Map the most common error shapes back to a stable kind we can
  // turn into a German error in the route handler.
  const text = await res.text().catch(() => "");
  if (res.status === 409) {
    throw new KeycloakAdminError(409, text, "email_taken");
  }
  if (res.status === 400) {
    const lower = text.toLowerCase();
    // Keycloak's password-policy violations come back as 400 with the
    // message body mentioning "password policy". Surface as
    // weak_password so the UI can highlight the password field.
    if (lower.includes("password policy") || lower.includes("invalidpassword")) {
      throw new KeycloakAdminError(400, text, "weak_password");
    }
    throw new KeycloakAdminError(400, text, "invalid_input");
  }
  throw new KeycloakAdminError(res.status, text, "keycloak_error");
}


// ---- O1 — Tenant-Gruppen (docs/PLAN_ORGANISATIONEN.md) -----------------
//
// Gruppe `tenant:<tenantId>` mit Attributen tenant_id/tenant_name; der
// User-Attribute-Mapper (T3) loest sie in die Token-Claims auf. Ein User
// gehoert genau einer tenant:*-Gruppe an. Rollen leben NICHT hier
// (Gateway-Wahrheit: TenantMember.role).

async function adminFetch(path: string, init: RequestInit = {}): Promise<Response> {
  const token = await getAdminToken();
  return fetch(`${adminBase()}${path}`, {
    ...init,
    headers: {
      authorization: `Bearer ${token}`,
      "content-type": "application/json",
      ...(init.headers ?? {}),
    },
  });
}

export async function ensureTenantGroup(tenantId: string, tenantName: string): Promise<string> {
  const name = `tenant:${tenantId}`;
  const q = await adminFetch(`/groups?search=${encodeURIComponent(name)}&exact=true&briefRepresentation=false`);
  if (!q.ok) throw new KeycloakAdminError(q.status, await q.text().catch(() => ""), "keycloak_error");
  const found = ((await q.json()) as Array<{ id: string; name: string }>).find((g) => g.name === name);
  if (found) return found.id;
  const c = await adminFetch(`/groups`, {
    method: "POST",
    body: JSON.stringify({ name, attributes: { tenant_id: [tenantId], tenant_name: [tenantName] } }),
  });
  if (!c.ok && c.status !== 409) throw new KeycloakAdminError(c.status, await c.text().catch(() => ""), "keycloak_error");
  const again = await adminFetch(`/groups?search=${encodeURIComponent(name)}&exact=true`);
  const g = ((await again.json()) as Array<{ id: string; name: string }>).find((x) => x.name === name);
  if (!g) throw new KeycloakAdminError(500, `group ${name} not found after create`, "keycloak_error");
  return g.id;
}

/** User in genau EINE tenant:*-Gruppe haengen (alle anderen entfernen). */
export async function moveUserToTenantGroup(userId: string, tenantId: string, tenantName: string): Promise<void> {
  const gid = await ensureTenantGroup(tenantId, tenantName);
  const r = await adminFetch(`/users/${encodeURIComponent(userId)}/groups?max=200`);
  if (!r.ok) throw new KeycloakAdminError(r.status, await r.text().catch(() => ""), "keycloak_error");
  const groups = (await r.json()) as Array<{ id: string; name: string }>;
  for (const g of groups) {
    if (g.name.startsWith("tenant:") && g.id !== gid) {
      await adminFetch(`/users/${encodeURIComponent(userId)}/groups/${g.id}`, { method: "DELETE" });
    }
  }
  if (!groups.some((g) => g.id === gid)) {
    const a = await adminFetch(`/users/${encodeURIComponent(userId)}/groups/${gid}`, { method: "PUT" });
    if (!a.ok) throw new KeycloakAdminError(a.status, await a.text().catch(() => ""), "keycloak_error");
  }
}

// ---- MCP: Clients ueber die Admin-API anlegen (docs/PLAN_MCP_OEFFNUNG.md) ----
//
// Keycloak laesst anonyme Dynamic Client Registration nur mit Initial-Access-
// Token zu. Das Gateway legt deshalb den Client selbst an: oeffentlich, nur
// Authorization-Code mit PKCE, Redirect-URIs aus der Allowlist der Route,
// Client-Scopes kopiert vom Desktop-Client (damit die Tokens company:read,
// import:write usw. tragen) plus `offline_access` als optionaler Scope fuer
// langlebige Refresh-Tokens. Braucht am Service-Account `ava-registrar` die
// Realm-Rollen `manage-clients` und `view-clients`.

export interface CreateMcpClientInput {
  clientName: string;
  redirectUris: string[];
}

interface ClientScopeRep {
  id: string;
  name: string;
}

async function clientScopesVon(clientUuid: string, art: "default" | "optional"): Promise<ClientScopeRep[]> {
  const res = await adminFetch(`/clients/${encodeURIComponent(clientUuid)}/${art}-client-scopes`);
  if (!res.ok) throw new KeycloakAdminError(res.status, await res.text(), "keycloak_error");
  return (await res.json()) as ClientScopeRep[];
}

export async function createMcpClient(input: CreateMcpClientInput): Promise<{ clientId: string; uuid: string }> {
  const env = loadEnv();
  const vorlageId = env.KEYCLOAK_MCP_TEMPLATE_CLIENT_ID;
  const clientId = `mcp-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
  const rep = {
    clientId,
    name: `MCP: ${input.clientName}`,
    description: `Dynamisch registrierter MCP-Client (${new Date().toISOString().slice(0, 10)})`,
    protocol: "openid-connect",
    enabled: true,
    publicClient: true,
    standardFlowEnabled: true,
    implicitFlowEnabled: false,
    directAccessGrantsEnabled: false,
    serviceAccountsEnabled: false,
    redirectUris: input.redirectUris,
    webOrigins: ["+"],
    attributes: {
      "pkce.code.challenge.method": "S256",
      "post.logout.redirect.uris": "+",
      "use.refresh.tokens": "true",
    },
  };
  const res = await adminFetch("/clients", { method: "POST", body: JSON.stringify(rep) });
  if (!res.ok) throw new KeycloakAdminError(res.status, await res.text(), "keycloak_error");
  const location = res.headers.get("location") ?? "";
  const uuid = location.split("/").pop() ?? "";
  if (!uuid) throw new KeycloakAdminError(500, "Location-Header ohne Client-ID", "keycloak_error");

  // Scopes der Vorlage (Desktop-Client) uebernehmen.
  const vorlage = await adminFetch(`/clients?clientId=${encodeURIComponent(vorlageId)}`);
  if (vorlage.ok) {
    const liste = (await vorlage.json()) as Array<{ id: string }>;
    const vorlageUuid = liste[0]?.id;
    if (vorlageUuid) {
      for (const art of ["default", "optional"] as const) {
        const scopes = await clientScopesVon(vorlageUuid, art).catch(() => [] as ClientScopeRep[]);
        for (const sc of scopes) {
          await adminFetch(`/clients/${encodeURIComponent(uuid)}/${art}-client-scopes/${encodeURIComponent(sc.id)}`, { method: "PUT" }).catch(() => undefined);
        }
      }
    } else {
      logger.warn({ vorlageId }, "[mcp] Vorlage-Client nicht gefunden — Client ohne kopierte Scopes");
    }
  }
  // offline_access als optionaler Scope (langlebige Refresh-Tokens fuer MCP-Clients).
  const alle = await adminFetch("/client-scopes");
  if (alle.ok) {
    const scopes = (await alle.json()) as ClientScopeRep[];
    const offline = scopes.find((s) => s.name === "offline_access");
    if (offline) {
      await adminFetch(`/clients/${encodeURIComponent(uuid)}/optional-client-scopes/${encodeURIComponent(offline.id)}`, { method: "PUT" }).catch(() => undefined);
    }
  }
  return { clientId, uuid };
}

// ---- Verbundene Dienste: Einwilligungen des Nutzers (docs/PLAN_MCP_OEFFNUNG.md, P5) ----

export interface Einwilligung {
  clientId: string;
  name: string | null;
  mcp: boolean;
  erteiltAt: string | null;
  zuletztAt: string | null;
  scopes: string[];
}

interface ConsentRep {
  clientId?: string;
  grantedClientScopes?: string[];
  createdDate?: number;
  lastUpdatedDate?: number;
}

async function clientUuidVon(clientId: string): Promise<{ id: string; name: string | null } | null> {
  const res = await adminFetch(`/clients?clientId=${encodeURIComponent(clientId)}`);
  if (!res.ok) return null;
  const liste = (await res.json()) as Array<{ id: string; name?: string }>;
  return liste[0] ? { id: liste[0].id, name: liste[0].name ?? null } : null;
}

/** Einwilligungen (consents) eines Nutzers; MCP-Clients zuerst. */
export async function listeEinwilligungen(userId: string): Promise<Einwilligung[]> {
  const res = await adminFetch(`/users/${encodeURIComponent(userId)}/consents`);
  if (!res.ok) throw new KeycloakAdminError(res.status, await res.text(), "keycloak_error");
  const rows = (await res.json()) as ConsentRep[];
  const out: Einwilligung[] = [];
  for (const r of rows) {
    if (!r.clientId) continue;
    const client = await clientUuidVon(r.clientId).catch(() => null);
    out.push({
      clientId: r.clientId,
      name: client?.name ?? null,
      mcp: r.clientId.startsWith("mcp-"),
      erteiltAt: r.createdDate ? new Date(r.createdDate).toISOString() : null,
      zuletztAt: r.lastUpdatedDate ? new Date(r.lastUpdatedDate).toISOString() : null,
      scopes: r.grantedClientScopes ?? [],
    });
  }
  return out.sort((a, b) => Number(b.mcp) - Number(a.mcp) || (b.zuletztAt ?? "").localeCompare(a.zuletztAt ?? ""));
}

/**
 * Einwilligung widerrufen (Tokens des Clients fuer diesen Nutzer werden
 * ungueltig). Dynamische MCP-Clients ohne weitere Nutzer werden geloescht:
 * Keycloak kennt keine Zaehlung je Client, deshalb nur, wenn der Client
 * `mcp-` heisst und die Widerrufende die einzige bekannte Sitzung hatte.
 */
export async function widerrufeEinwilligung(userId: string, clientId: string): Promise<{ gefunden: boolean; entfernt: boolean }> {
  const res = await adminFetch(`/users/${encodeURIComponent(userId)}/consents/${encodeURIComponent(clientId)}`, { method: "DELETE" });
  if (res.status === 404) return { gefunden: false, entfernt: false };
  if (!res.ok) throw new KeycloakAdminError(res.status, await res.text(), "keycloak_error");
  let entfernt = false;
  if (clientId.startsWith("mcp-")) {
    const client = await clientUuidVon(clientId).catch(() => null);
    if (client) {
      const sessions = await adminFetch(`/clients/${encodeURIComponent(client.id)}/session-count`).catch(() => null);
      const n = sessions && sessions.ok ? ((await sessions.json()) as { count?: number }).count ?? 0 : 0;
      if (n === 0) {
        const del = await adminFetch(`/clients/${encodeURIComponent(client.id)}`, { method: "DELETE" });
        entfernt = del.ok;
      }
    }
  }
  return { gefunden: true, entfernt };
}


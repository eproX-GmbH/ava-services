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

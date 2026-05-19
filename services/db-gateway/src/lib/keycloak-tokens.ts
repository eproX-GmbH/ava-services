// In-App-Registration Helper #2 — ROPC token exchange.
//
// After `keycloak-admin.createUser` succeeds, we want the new user
// signed in immediately. To get a real OIDC token-set without sending
// the user through the browser, we use Resource-Owner-Password-
// Credentials grant against a public client (`ava-registration`) that
// has ONLY direct-access-grants enabled — no standard flow, no
// service accounts. Trust surface stays narrow: the only thing
// possible with this client_id is "exchange email+password for a
// token", which is what we just collected from the user anyway.
//
// The returned token-set has the same shape as the OIDC auth-code
// response, so the desktop side can reuse its existing applyTokens()
// path. See services/desktop/src/main/auth.ts:343 (TokenResponse).

import { loadEnv } from "./env";
import {
  KeycloakAdminError,
  RegistrationDisabledError,
} from "./keycloak-admin";

export interface RopcTokenSet {
  access_token: string;
  refresh_token: string;
  id_token?: string;
  expires_in: number;
  refresh_expires_in?: number;
  token_type: string;
  scope?: string;
}

function realmTokenEndpoint(): string {
  const env = loadEnv();
  if (!env.KEYCLOAK_REALM_URL) {
    throw new RegistrationDisabledError("KEYCLOAK_REALM_URL not configured");
  }
  return `${env.KEYCLOAK_REALM_URL.replace(/\/+$/, "")}/protocol/openid-connect/token`;
}

/** Exchange a freshly-set email+password for a token-set using the
 *  `ava-registration` public client (direct-access-grants only).
 *
 *  Throws RegistrationDisabledError if the env is unconfigured.
 *  Throws KeycloakAdminError on any non-2xx from Keycloak. */
export async function passwordGrant(
  email: string,
  password: string,
): Promise<RopcTokenSet> {
  const env = loadEnv();
  if (!env.KEYCLOAK_REGISTRATION_CLIENT_ID) {
    throw new RegistrationDisabledError(
      "KEYCLOAK_REGISTRATION_CLIENT_ID not configured",
    );
  }
  // The scope list mirrors what the desktop's OIDC flow requests in
  // APP_SCOPES (services/desktop/src/main/auth.ts:79). We keep them
  // in sync by hand because this gateway can't import from the
  // desktop package — the alternative (a shared @ava/auth-config
  // package) is overkill for one literal list.
  const scopes = [
    "openid",
    "profile",
    "email",
    "company:read",
    "company:write",
    "transaction:read",
    "evaluation:read",
    "evaluation:write",
    "import:write",
    "valueserp:enabled",
  ].join(" ");
  const body = new URLSearchParams({
    grant_type: "password",
    client_id: env.KEYCLOAK_REGISTRATION_CLIENT_ID,
    username: email,
    password,
    scope: scopes,
  });
  const res = await fetch(realmTokenEndpoint(), {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: body.toString(),
  });
  if (!res.ok) {
    const text = await res.text().catch(() => "");
    // A 401 here right after a successful createUser usually means the
    // direct-access-grants flag is off on `ava-registration` — that's
    // an operator-config bug, not the user's fault. Surface it
    // explicitly so the route can return a 502 + tells the operator
    // exactly what to fix.
    throw new KeycloakAdminError(res.status, text, "keycloak_error");
  }
  return (await res.json()) as RopcTokenSet;
}

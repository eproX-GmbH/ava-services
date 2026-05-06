#!/usr/bin/env node
// =============================================================================
// One-shot configuration script for the AVA Keycloak realm.
//
// Applies the realm-level settings the desktop UX requires — kept
// here as code rather than as a tribal-knowledge admin-UI checklist
// so they can be re-applied to a fresh Keycloak instance verbatim
// (think: dev → staging → prod, or rebuilding the fly app).
//
// What it does (idempotent — re-running is safe):
//   1. Realm `ava`:
//      - registrationAllowed = true              (#1 — show "Register" link on login form)
//      - registrationEmailAsUsername = true       (one less form field; matches
//                                                  desktop UX where email is the canonical id)
//      - resetPasswordAllowed = true              (gives users a "Forgot password" link)
//      - rememberMe = true
//      - ssoSessionIdleTimeout = 30 days          (#2 — long refresh; user not booted on idle)
//      - ssoSessionMaxLifespan  = 30 days         (#2 — refresh-token max age)
//      - offlineSessionIdleTimeout = 30 days
//      - loginTheme = "ava"                       (#4 — branded login form; theme must
//                                                  be baked into the Keycloak image first)
//
//   2. Client `ava-desktop`:
//      - publicClient = true (no secret — required for native PKCE)
//      - standardFlowEnabled = true
//      - directAccessGrantsEnabled = false
//      - rootUrl / baseUrl: not set (native app, no web URL)
//      - redirectUris includes `http://127.0.0.1:*` (RFC 8252 native loopback)
//      - webOrigins: empty (no CORS for native app)
//      - attributes: `pkce.code.challenge.method = S256`
//
// Usage:
//   KEYCLOAK_ADMIN_URL=https://fly-keycloak-broken-bird-3701.fly.dev \
//   KEYCLOAK_ADMIN_USER=admin \
//   KEYCLOAK_ADMIN_PASSWORD='…' \
//   node infra/scripts/keycloak-config.mjs
//
// The script authenticates against the master realm (admin-cli client),
// then PUTs the desired state into the `ava` realm + `ava-desktop`
// client. Existing values that aren't listed here are preserved.
//
// Why a Node script instead of a Terraform / Crossplane resource:
//   - Single concrete deploy, not a fleet — Terraform is overkill.
//   - Keycloak's REST API is stable and well-documented.
//   - Node is already in the toolchain; no extra runtime to install.
// =============================================================================

const SECONDS = {
  day: 24 * 60 * 60,
};

const config = {
  realm: "ava",
  clientId: "ava-desktop",
  loginTheme: "ava",
  realmPatch: {
    registrationAllowed: true,
    registrationEmailAsUsername: true,
    resetPasswordAllowed: true,
    rememberMe: true,
    verifyEmail: false,
    loginWithEmailAllowed: true,
    duplicateEmailsAllowed: false,
    // 30-day sessions — the user complained they get logged out too
    // often. This is the max-age of the refresh token; the access
    // token is still short-lived (default 5 min, refreshed silently).
    ssoSessionIdleTimeout: 30 * SECONDS.day,
    ssoSessionMaxLifespan: 30 * SECONDS.day,
    offlineSessionIdleTimeout: 30 * SECONDS.day,
    loginTheme: "ava",
  },
  clientPatch: {
    enabled: true,
    publicClient: true,
    standardFlowEnabled: true,
    directAccessGrantsEnabled: false,
    serviceAccountsEnabled: false,
    redirectUris: ["http://127.0.0.1:*", "http://localhost:*"],
    webOrigins: [],
    attributes: {
      "pkce.code.challenge.method": "S256",
    },
  },
};

function envOrDie(name) {
  const v = process.env[name];
  if (!v) {
    console.error(`error: ${name} is required`);
    process.exit(1);
  }
  return v;
}

const adminUrl = envOrDie("KEYCLOAK_ADMIN_URL").replace(/\/$/, "");
const adminUser = envOrDie("KEYCLOAK_ADMIN_USER");
const adminPassword = envOrDie("KEYCLOAK_ADMIN_PASSWORD");

async function getAdminToken() {
  const body = new URLSearchParams({
    grant_type: "password",
    client_id: "admin-cli",
    username: adminUser,
    password: adminPassword,
  });
  const res = await fetch(
    `${adminUrl}/realms/master/protocol/openid-connect/token`,
    {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: body.toString(),
    },
  );
  if (!res.ok) {
    throw new Error(`admin login failed: ${res.status} ${await res.text()}`);
  }
  const data = await res.json();
  return data.access_token;
}

async function api(token, method, path, body) {
  const res = await fetch(`${adminUrl}/admin${path}`, {
    method,
    headers: {
      authorization: `Bearer ${token}`,
      "content-type": "application/json",
    },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  if (!res.ok) {
    const text = await res.text();
    throw new Error(`${method} ${path} → ${res.status}: ${text}`);
  }
  if (res.status === 204) return null;
  const text = await res.text();
  return text ? JSON.parse(text) : null;
}

async function main() {
  console.log(`> authenticating against ${adminUrl}`);
  const token = await getAdminToken();

  console.log(`> fetching realm "${config.realm}"`);
  const realm = await api(token, "GET", `/realms/${config.realm}`);

  console.log(`> patching realm settings`);
  await api(token, "PUT", `/realms/${config.realm}`, {
    ...realm,
    ...config.realmPatch,
  });
  console.log(
    `  - registration: ${config.realmPatch.registrationAllowed ? "ENABLED" : "disabled"}`,
  );
  console.log(
    `  - SSO session max: ${config.realmPatch.ssoSessionMaxLifespan / SECONDS.day} days`,
  );
  console.log(`  - login theme: ${config.realmPatch.loginTheme}`);

  console.log(`> finding client "${config.clientId}"`);
  const clients = await api(
    token,
    "GET",
    `/realms/${config.realm}/clients?clientId=${encodeURIComponent(config.clientId)}`,
  );
  if (!Array.isArray(clients) || clients.length === 0) {
    throw new Error(
      `client "${config.clientId}" not found in realm "${config.realm}". ` +
        `Create it once via the admin UI, then re-run this script to patch its settings.`,
    );
  }
  const client = clients[0];
  console.log(`> patching client ${client.id}`);
  await api(token, "PUT", `/realms/${config.realm}/clients/${client.id}`, {
    ...client,
    ...config.clientPatch,
    attributes: { ...(client.attributes ?? {}), ...config.clientPatch.attributes },
  });

  console.log("> done.");
  console.log("");
  console.log("Verify:");
  console.log(`  ${adminUrl}/realms/${config.realm}/protocol/openid-connect/auth?client_id=${config.clientId}&response_type=code&redirect_uri=http://127.0.0.1:1/callback`);
  console.log(
    "Open that URL in a browser — you should see the AVA-themed login",
  );
  console.log(
    "page with a 'Register' link below the sign-in button.",
  );
}

main().catch((err) => {
  console.error("FAILED:", err.message);
  process.exit(1);
});

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
  // -------------------------------------------------------------------
  // In-App-Registration clients (added with the desktop sign-up flow).
  //
  // `ava-registrar`     — confidential service-account client used by the
  //                       gateway to call the Keycloak Admin API and
  //                       create new users. Needs role
  //                       `realm-management/manage-users`.
  //
  // `ava-registration`  — public client with ONLY direct-access-grants
  //                       enabled. Used by the gateway IMMEDIATELY after
  //                       user creation to ROPC-exchange the freshly-
  //                       set password for a token-set, so the new
  //                       user is signed in without a browser detour.
  //                       Standard flow is OFF on purpose — this
  //                       client must not show up in normal logins.
  //
  // The script will (idempotently) create both clients if missing,
  // print the registrar's secret on first run so the operator can
  // copy it into fly secrets, and warn on subsequent runs that the
  // existing secret is preserved.
  // -------------------------------------------------------------------
  registrarClientId: "ava-registrar",
  registrationClientId: "ava-registration",
  // Custom client scopes added on top of OIDC defaults. Each is
  // created once if missing, then attached as a *default* client
  // scope on `ava-desktop` so every issued token includes the
  // scope value in its `scope` claim — desktop's APP_SCOPES list
  // already requests them, but Keycloak only mints what the client
  // is configured for.
  //
  // Per-tenant gating: the gateway's ProxyQuotaOverride.enabled flag
  // is the immediate kill-switch; this scope is the realm-level
  // feature flag (would let us run a "free realm" without the
  // proxy entirely, e.g. trial vs paid).
  customClientScopes: [
    {
      name: "valueserp:enabled",
      description: "Grants access to the operator-paid valueserp search proxy",
    },
  ],
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
    // v0.1.253 — Direct Access Grants (ROPC) auf ava-desktop ENABLED.
    // Genutzt vom Backend (db-gateway) NACH erfolgreicher Registrierung,
    // um aus email+passwort einen Token-Set zu generieren — so dass der
    // neu angelegte User direkt eingeloggt ist, ohne den OIDC-Browser-
    // Round-Trip. Trust-Surface: minimal, weil der Token DIESES Mal
    // genau die Identität bekommt, die die Desktop-App ohnehin gerade
    // im Sign-Up-Form gesammelt hat.
    directAccessGrantsEnabled: true,
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

  // ---- Custom client scopes ------------------------------------------------
  //
  // Idempotent: GET the realm's client-scopes list, create any
  // missing ones, then ensure each is attached as a default scope
  // on the `ava-desktop` client.
  if (config.customClientScopes && config.customClientScopes.length > 0) {
    console.log(`> ensuring custom client scopes`);
    const existingScopes = await api(
      token,
      "GET",
      `/realms/${config.realm}/client-scopes`,
    );
    for (const desired of config.customClientScopes) {
      let scope = existingScopes.find((s) => s.name === desired.name);
      if (!scope) {
        await api(
          token,
          "POST",
          `/realms/${config.realm}/client-scopes`,
          {
            name: desired.name,
            description: desired.description,
            protocol: "openid-connect",
            attributes: {
              "include.in.token.scope": "true",
              "display.on.consent.screen": "false",
            },
          },
        );
        // POST returns 201 with no body; re-list to pick up the id.
        const refreshed = await api(
          token,
          "GET",
          `/realms/${config.realm}/client-scopes`,
        );
        scope = refreshed.find((s) => s.name === desired.name);
        console.log(`  - created client scope: ${desired.name}`);
      } else {
        console.log(`  - client scope already exists: ${desired.name}`);
      }
      // Attach as default scope on the desktop client. PUT is a
      // no-op if already attached, so safe to re-run.
      await api(
        token,
        "PUT",
        `/realms/${config.realm}/clients/${client.id}/default-client-scopes/${scope.id}`,
      );
      console.log(`    → attached as default scope on ${config.clientId}`);
    }
  }

  // ---- In-App-Registration: registrar + registration clients --------------
  //
  // Both are idempotent: if missing, create with the desired shape;
  // if present, PATCH the shape but keep the registrar's secret.
  await ensureRegistrarClient(token);
  await ensureRegistrationClient(token);

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

// ---- Registrar (service-account, confidential) -----------------------------
//
// Creates the `ava-registrar` client + binds the `manage-users`
// service-account role from the realm-management client. Prints the
// generated secret on FIRST run so the operator can put it into
// fly secrets — on later runs we leave the existing secret in place
// (rotating it would silently break the gateway's create-user calls).

async function ensureRegistrarClient(token) {
  console.log(`> ensuring confidential client "${config.registrarClientId}"`);
  const existing = await api(
    token,
    "GET",
    `/realms/${config.realm}/clients?clientId=${encodeURIComponent(config.registrarClientId)}`,
  );
  let registrar;
  if (Array.isArray(existing) && existing.length > 0) {
    registrar = existing[0];
    console.log(`  - already exists; preserving secret`);
    await api(token, "PUT", `/realms/${config.realm}/clients/${registrar.id}`, {
      ...registrar,
      enabled: true,
      publicClient: false,
      standardFlowEnabled: false,
      implicitFlowEnabled: false,
      directAccessGrantsEnabled: false,
      serviceAccountsEnabled: true,
      redirectUris: [],
      webOrigins: [],
    });
  } else {
    await api(token, "POST", `/realms/${config.realm}/clients`, {
      clientId: config.registrarClientId,
      enabled: true,
      publicClient: false,
      standardFlowEnabled: false,
      implicitFlowEnabled: false,
      directAccessGrantsEnabled: false,
      serviceAccountsEnabled: true,
      redirectUris: [],
      webOrigins: [],
    });
    const refreshed = await api(
      token,
      "GET",
      `/realms/${config.realm}/clients?clientId=${encodeURIComponent(config.registrarClientId)}`,
    );
    registrar = refreshed[0];
    console.log(`  - created`);
  }

  // Bind `realm-management/manage-users` to the service account.
  const realmMgmt = await api(
    token,
    "GET",
    `/realms/${config.realm}/clients?clientId=realm-management`,
  );
  if (!realmMgmt || realmMgmt.length === 0) {
    throw new Error(
      "realm-management client not found — is this really a Keycloak realm?",
    );
  }
  const realmMgmtId = realmMgmt[0].id;
  const sa = await api(
    token,
    "GET",
    `/realms/${config.realm}/clients/${registrar.id}/service-account-user`,
  );
  if (!sa || !sa.id) {
    throw new Error(
      `service-account user not found on ${config.registrarClientId} — serviceAccountsEnabled may not have applied yet`,
    );
  }
  const manageUsersRole = await api(
    token,
    "GET",
    `/realms/${config.realm}/clients/${realmMgmtId}/roles/manage-users`,
  );
  // POST is idempotent here (already-assigned → 204, otherwise 204
  // and the role is bound). Wrap in try/catch defensively because
  // some Keycloak versions return 409 instead of 204 for duplicates.
  try {
    await api(
      token,
      "POST",
      `/realms/${config.realm}/users/${sa.id}/role-mappings/clients/${realmMgmtId}`,
      [
        {
          id: manageUsersRole.id,
          name: manageUsersRole.name,
          composite: manageUsersRole.composite,
          clientRole: true,
          containerId: realmMgmtId,
        },
      ],
    );
    console.log(`  - role manage-users bound to service-account`);
  } catch (err) {
    if (String(err.message).includes("409")) {
      console.log(`  - role manage-users already bound`);
    } else {
      throw err;
    }
  }

  // Read the client secret + print it on FIRST run.
  const secretDoc = await api(
    token,
    "GET",
    `/realms/${config.realm}/clients/${registrar.id}/client-secret`,
  );
  console.log(`  - secret: ${secretDoc.value}`);
  console.log(
    `    (copy this into fly secrets for db-gateway: KEYCLOAK_REGISTRAR_CLIENT_SECRET=...)`,
  );
}

// ---- Registration (ROPC-only public client) --------------------------------
//
// Public, NO standard flow, NO service accounts, ONLY direct-access-
// grants. The gateway uses this client_id to ROPC-exchange the
// freshly-set password for a token-set right after creating the user
// — sole purpose. By keeping it separate from `ava-desktop` we avoid
// enabling direct-access-grants on the main login client.

async function ensureRegistrationClient(token) {
  console.log(`> ensuring public client "${config.registrationClientId}"`);
  const existing = await api(
    token,
    "GET",
    `/realms/${config.realm}/clients?clientId=${encodeURIComponent(config.registrationClientId)}`,
  );
  const desired = {
    clientId: config.registrationClientId,
    enabled: true,
    publicClient: true,
    standardFlowEnabled: false,
    implicitFlowEnabled: false,
    directAccessGrantsEnabled: true,
    serviceAccountsEnabled: false,
    redirectUris: [],
    webOrigins: [],
  };
  let registrationClient;
  if (Array.isArray(existing) && existing.length > 0) {
    registrationClient = existing[0];
    await api(token, "PUT", `/realms/${config.realm}/clients/${registrationClient.id}`, {
      ...registrationClient,
      ...desired,
    });
    console.log(`  - already exists; patched to desired shape`);
  } else {
    await api(token, "POST", `/realms/${config.realm}/clients`, desired);
    const refreshed = await api(
      token,
      "GET",
      `/realms/${config.realm}/clients?clientId=${encodeURIComponent(config.registrationClientId)}`,
    );
    registrationClient = refreshed[0];
    console.log(`  - created`);
  }

  // Scope-Mirror: alle default- + optional-client-scopes vom
  // ava-desktop-Client auch an ava-registration anhängen. Sonst
  // schlägt der ROPC-Token-Grant mit `invalid_scope` fehl, sobald die
  // Desktop-App ihren APP_SCOPES-Set anfragt (openid + profile + email
  // + die custom AVA-Scopes). Wir mirrorn beide Listen, damit der
  // Token aus dem Registration-Flow exakt dieselben Scopes hat wie
  // ein Token aus dem regulären OIDC-Login.
  console.log(`  - mirroring scopes from ${config.clientId}`);
  const desktopClients = await api(
    token,
    "GET",
    `/realms/${config.realm}/clients?clientId=${encodeURIComponent(config.clientId)}`,
  );
  if (!Array.isArray(desktopClients) || desktopClients.length === 0) {
    console.warn(
      `  - WARN: ${config.clientId} not found; skipping scope mirror`,
    );
    return;
  }
  const desktopId = desktopClients[0].id;
  const defaultScopes = await api(
    token,
    "GET",
    `/realms/${config.realm}/clients/${desktopId}/default-client-scopes`,
  );
  const optionalScopes = await api(
    token,
    "GET",
    `/realms/${config.realm}/clients/${desktopId}/optional-client-scopes`,
  );
  for (const scope of defaultScopes ?? []) {
    await api(
      token,
      "PUT",
      `/realms/${config.realm}/clients/${registrationClient.id}/default-client-scopes/${scope.id}`,
    );
  }
  for (const scope of optionalScopes ?? []) {
    await api(
      token,
      "PUT",
      `/realms/${config.realm}/clients/${registrationClient.id}/optional-client-scopes/${scope.id}`,
    );
  }
  console.log(
    `    → mirrored ${defaultScopes?.length ?? 0} default + ${optionalScopes?.length ?? 0} optional scopes`,
  );
}

main().catch((err) => {
  console.error("FAILED:", err.message);
  process.exit(1);
});

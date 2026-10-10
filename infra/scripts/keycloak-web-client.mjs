#!/usr/bin/env node
// Keycloak-Client `ava-web` für die Web-Konsole admin.ava.bi (docs/PLAN_ADMIN_WEB.md §3.1).
//
// Vertraulicher Client (Geheimnis bleibt im Server-Teil der Konsole) mit
// Authorization Code + PKCE S256. Scopes werden vom Desktop-Client gespiegelt,
// damit die Tokens dieselben Claims tragen (tenant_id, E-Mail, …); offline_access
// bewusst nicht (Sitzung höchstens 8 Stunden).
//
//   KEYCLOAK_ADMIN_URL=https://fly-keycloak-broken-bird-3701.fly.dev \
//   KEYCLOAK_ADMIN_USER=… KEYCLOAK_ADMIN_PASSWORD=… \
//   node infra/scripts/keycloak-web-client.mjs [--vercel /Pfad/zu/ava-admin]
//
// Idempotent: legt den Client an oder gleicht ihn ab. Mit --vercel wird das
// Client-Geheimnis direkt per stdin als AUTH_CLIENT_SECRET (production) in das
// Vercel-Projekt geschrieben; es erscheint nie im Terminal.

import { spawnSync } from "node:child_process";

const REALM = "ava";
const CLIENT_ID = "ava-web";
const VORLAGE = "ava-desktop";
const REDIRECTS = ["https://admin.ava.bi/auth/callback", "http://localhost:3000/auth/callback"];

function env(name) {
  const v = process.env[name]?.trim();
  if (!v) {
    console.error(`✗ ${name} fehlt.`);
    process.exit(1);
  }
  return v;
}

const adminUrl = env("KEYCLOAK_ADMIN_URL").replace(/\/$/, "");
const vercelIdx = process.argv.indexOf("--vercel");
const vercelDir = vercelIdx > -1 ? process.argv[vercelIdx + 1] : null;

async function adminToken() {
  const res = await fetch(`${adminUrl}/realms/master/protocol/openid-connect/token`, {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({ grant_type: "password", client_id: "admin-cli", username: env("KEYCLOAK_ADMIN_USER"), password: env("KEYCLOAK_ADMIN_PASSWORD") }),
  });
  if (!res.ok) throw new Error(`Admin-Anmeldung fehlgeschlagen (${res.status})`);
  return (await res.json()).access_token;
}

async function api(token, method, path, body) {
  const res = await fetch(`${adminUrl}/admin/realms/${REALM}${path}`, {
    method,
    headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  if (!res.ok) throw new Error(`${method} ${path} → ${res.status}: ${await res.text()}`);
  const text = res.status === 204 ? "" : await res.text();
  return text ? JSON.parse(text) : null;
}

async function main() {
  const token = await adminToken();
  const darstellung = {
    clientId: CLIENT_ID,
    name: "AVA Konsole (Web)",
    description: "Web-Konsole admin.ava.bi: Organisation, Vorgaben, Schlüssel, Instanzen",
    protocol: "openid-connect",
    enabled: true,
    publicClient: false,
    clientAuthenticatorType: "client-secret",
    standardFlowEnabled: true,
    implicitFlowEnabled: false,
    directAccessGrantsEnabled: false,
    serviceAccountsEnabled: false,
    frontchannelLogout: false,
    redirectUris: REDIRECTS,
    webOrigins: [],
    attributes: {
      "pkce.code.challenge.method": "S256",
      "use.refresh.tokens": "true",
      "post.logout.redirect.uris": "https://admin.ava.bi/abgemeldet##http://localhost:3000/abgemeldet",
    },
  };

  let [client] = await api(token, "GET", `/clients?clientId=${CLIENT_ID}`);
  if (client) {
    console.log(`> ${CLIENT_ID} vorhanden, gleiche Einstellungen ab`);
    await api(token, "PUT", `/clients/${client.id}`, { ...client, ...darstellung, attributes: { ...client.attributes, ...darstellung.attributes } });
  } else {
    console.log(`> lege ${CLIENT_ID} an`);
    await api(token, "POST", "/clients", darstellung);
    [client] = await api(token, "GET", `/clients?clientId=${CLIENT_ID}`);
  }

  const [vorlage] = await api(token, "GET", `/clients?clientId=${VORLAGE}`);
  if (!vorlage) throw new Error(`Vorlage ${VORLAGE} nicht gefunden.`);
  for (const art of ["default", "optional"]) {
    const vorhanden = new Set((await api(token, "GET", `/clients/${client.id}/${art}-client-scopes`)).map((s) => s.id));
    for (const sc of await api(token, "GET", `/clients/${vorlage.id}/${art}-client-scopes`)) {
      if (sc.name === "offline_access" || vorhanden.has(sc.id)) continue;
      await api(token, "PUT", `/clients/${client.id}/${art}-client-scopes/${sc.id}`);
      console.log(`  + ${art}: ${sc.name}`);
    }
  }
  // offline_access entfernen, falls Keycloak ihn als Standard angehängt hat.
  for (const art of ["default", "optional"]) {
    for (const sc of await api(token, "GET", `/clients/${client.id}/${art}-client-scopes`)) {
      if (sc.name === "offline_access") await api(token, "DELETE", `/clients/${client.id}/${art}-client-scopes/${sc.id}`);
    }
  }

  const geheimnis = (await api(token, "GET", `/clients/${client.id}/client-secret`))?.value;
  if (!geheimnis) throw new Error("Kein Client-Geheimnis erhalten.");
  if (vercelDir) {
    const r = spawnSync("vercel", ["env", "add", "AUTH_CLIENT_SECRET", "production", "--force", "--scope", "quikk"], { cwd: vercelDir, input: geheimnis, encoding: "utf8" });
    if (r.status !== 0) throw new Error(`vercel env add fehlgeschlagen: ${(r.stderr || r.stdout).slice(-300)}`);
    console.log("✓ AUTH_CLIENT_SECRET im Vercel-Projekt gesetzt (production). Danach neu ausrollen: vercel deploy --prod");
  } else {
    console.log("✓ Client bereit. Geheimnis: Keycloak → Clients → ava-web → Credentials (oder Skript mit --vercel <ava-admin> erneut ausführen).");
  }
}

main().catch((err) => {
  console.error(`✗ ${err.message}`);
  process.exit(1);
});

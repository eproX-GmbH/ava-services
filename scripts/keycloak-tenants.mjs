#!/usr/bin/env node
// T3 (docs/PLAN_TENANT_MULTI_ACCOUNT.md) — Tenants im Keycloak-Realm.
//
// Idempotent. Ohne --apply wird NUR geplant (keine Schreibzugriffe).
//
//   KEYCLOAK_ADMIN_URL=https://fly-keycloak-broken-bird-3701.fly.dev \
//   KEYCLOAK_ADMIN_USER=admin KEYCLOAK_ADMIN_PASSWORD='…' \
//   node scripts/keycloak-tenants.mjs            # Plan
//   node scripts/keycloak-tenants.mjs --apply    # Anwenden
//
// Was das Skript sicherstellt:
//   1. Protocol-Mapper am Client `ava-desktop`: `tenant_id` und
//      `tenant_name` (User-Attribute-Mapper, Access-/ID-Token/Userinfo).
//      Keycloaks User-Attribute-Mapper loest Attribute auch ueber die
//      GRUPPEN des Users auf (KeycloakModelUtils.resolveAttribute) —
//      deshalb tragen die Tenant-Gruppen die Attribute, nicht die User.
//   2. Je User ohne Tenant eine persoenliche Gruppe `tenant:<sub>` mit
//      Attributen tenant_id=<sub>, tenant_name=<E-Mail|Name>, und die
//      Mitgliedschaft. Entscheidung 2026-09-03: genau ein Tenant je User;
//      Zusammenlegungen pflegt der Operator spaeter von Hand (User in
//      eine andere tenant:*-Gruppe verschieben, alte Gruppe loeschen).
//
// Warum tenant_id = sub fuer persoenliche Tenants: das Gateway faellt
// heute ohne Claim auf `sub` zurueck; alle tenant-gebundenen Zeilen
// (TenantBilling, UsageEntry, ParkedCompany, CrmLink) sind mit der
// User-UUID geschluesselt. Der Claim aendert damit KEINE Datenzuordnung.

const URL_ = (process.env.KEYCLOAK_ADMIN_URL || "").replace(/\/+$/, "");
const USER = process.env.KEYCLOAK_ADMIN_USER || "";
const PASS = process.env.KEYCLOAK_ADMIN_PASSWORD || "";
const REALM = process.env.KEYCLOAK_REALM || "ava";
const CLIENT_ID = process.env.KEYCLOAK_CLIENT_ID || "ava-desktop";
const APPLY = process.argv.includes("--apply");

if (!URL_ || !USER || !PASS) {
  console.error("Bitte KEYCLOAK_ADMIN_URL, KEYCLOAK_ADMIN_USER, KEYCLOAK_ADMIN_PASSWORD setzen.");
  process.exit(2);
}

let token = "";
async function login() {
  const res = await fetch(`${URL_}/realms/master/protocol/openid-connect/token`, {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({ grant_type: "password", client_id: "admin-cli", username: USER, password: PASS }),
  });
  if (!res.ok) throw new Error(`Admin-Login fehlgeschlagen: HTTP ${res.status} ${await res.text()}`);
  token = (await res.json()).access_token;
}
async function api(method, path, body) {
  const res = await fetch(`${URL_}/admin/realms/${REALM}${path}`, {
    method,
    headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  if (!res.ok) throw new Error(`${method} ${path} → HTTP ${res.status} ${await res.text()}`);
  const text = await res.text();
  return text ? JSON.parse(text) : null;
}
const plan = [];
function todo(text, fn) { plan.push({ text, fn }); }

async function ensureMappers() {
  const clients = await api("GET", `/clients?clientId=${encodeURIComponent(CLIENT_ID)}`);
  if (!clients?.length) throw new Error(`Client ${CLIENT_ID} nicht gefunden`);
  const client = clients[0];
  const mappers = await api("GET", `/clients/${client.id}/protocol-mappers/models`);
  for (const claim of ["tenant_id", "tenant_name"]) {
    const vorhanden = mappers.find((m) => m.config?.["claim.name"] === claim);
    if (vorhanden) { console.log(`  ✓ Mapper ${claim} vorhanden (${vorhanden.name})`); continue; }
    todo(`Mapper ${claim} am Client ${CLIENT_ID} anlegen`, () =>
      api("POST", `/clients/${client.id}/protocol-mappers/models`, {
        name: claim,
        protocol: "openid-connect",
        protocolMapper: "oidc-usermodel-attribute-mapper",
        consentRequired: false,
        config: {
          "user.attribute": claim,
          "claim.name": claim,
          "jsonType.label": "String",
          "id.token.claim": "true",
          "access.token.claim": "true",
          "userinfo.token.claim": "true",
          "aggregate.attrs": "false",
          "multivalued": "false",
        },
      }));
  }
}

async function alleUser() {
  const out = [];
  for (let first = 0; ; first += 100) {
    const page = await api("GET", `/users?first=${first}&max=100&briefRepresentation=false`);
    out.push(...page);
    if (page.length < 100) break;
  }
  return out;
}

async function ensureTenants() {
  const users = await alleUser();
  const gruppen = await api("GET", `/groups?first=0&max=1000&briefRepresentation=false`);
  const tenantGruppen = new Map(gruppen.filter((g) => g.name.startsWith("tenant:")).map((g) => [g.name, g]));
  let mitTenant = 0, ohne = 0;
  for (const u of users) {
    const eigene = await api("GET", `/users/${u.id}/groups?max=100`);
    const tenantGruppe = eigene.find((g) => g.name.startsWith("tenant:"));
    const attr = u.attributes?.tenant_id?.[0];
    if (tenantGruppe || attr) { mitTenant++; continue; }
    ohne++;
    const name = `tenant:${u.id}`;
    const anzeige = u.email || [u.firstName, u.lastName].filter(Boolean).join(" ") || u.username || u.id;
    const existing = tenantGruppen.get(name);
    todo(`${anzeige}: persoenlicher Tenant ${name}${existing ? " (Gruppe existiert, nur Mitgliedschaft)" : ""}`, async () => {
      let gid = existing?.id;
      if (!gid) {
        await api("POST", `/groups`, { name, attributes: { tenant_id: [u.id], tenant_name: [anzeige] } });
        const g = await api("GET", `/groups?search=${encodeURIComponent(name)}&exact=true`);
        gid = g.find((x) => x.name === name)?.id;
        if (!gid) throw new Error(`Gruppe ${name} nach Anlage nicht gefunden`);
      }
      await api("PUT", `/users/${u.id}/groups/${gid}`);
    });
  }
  console.log(`  User gesamt ${users.length}: ${mitTenant} mit Tenant, ${ohne} ohne`);
}

(async () => {
  await login();
  console.log(`Realm ${REALM} @ ${URL_} — ${APPLY ? "APPLY" : "PLAN (keine Aenderung)"}`);
  console.log("Mapper:"); await ensureMappers();
  console.log("Tenants:"); await ensureTenants();
  if (plan.length === 0) { console.log("Nichts zu tun."); return; }
  console.log(`\n${plan.length} Aenderung(en):`);
  for (const p of plan) console.log(`  - ${p.text}`);
  if (!APPLY) { console.log("\nPlan-Modus. Anwenden mit --apply."); return; }
  for (const p of plan) { await p.fn(); console.log(`  ✓ ${p.text}`); }
  console.log("\nFertig. Hinweis: bestehende Tokens tragen die Claims erst nach dem naechsten Refresh/Login.");
})().catch((e) => { console.error(e.message || e); process.exit(1); });

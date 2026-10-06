import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import M from "../src/main/auth/siwc-oauth.ts";
const { generateSiwcPkce, buildSiwcAuthorizationUrl, parseSiwcCallback, hatPlanScope, istAusgegebeneClientId, ladeOderErzeugeHostId, refreshEndgueltigGescheitert, SIWC_REDIRECT_URI } = M;

// Host-ID: stabil je Installation
{
  const dir = mkdtempSync(join(tmpdir(), "siwc-"));
  const a = ladeOderErzeugeHostId(join(dir, "siwc-host.json"));
  const b = ladeOderErzeugeHostId(join(dir, "siwc-host.json"));
  assert.match(a, /^urn:uuid:[0-9a-f-]{36}$/);
  assert.equal(a, b);
}
// Erstanmeldung: dynamische Client-ID + agent_name_hint; Wiederanmeldung ohne
{
  const pkce = generateSiwcPkce();
  const url = new URL(buildSiwcAuthorizationUrl({ pkce, hostId: "urn:uuid:x" }));
  assert.equal(url.origin + url.pathname, "https://auth.openai.com/api/accounts/authorize");
  assert.equal(url.searchParams.get("client_id"), "dynamic_agent_client");
  assert.equal(url.searchParams.get("agent_name_hint"), "AVA");
  assert.equal(url.searchParams.get("ext_agent_host_id"), "urn:uuid:x");
  assert.equal(url.searchParams.get("redirect_uri"), SIWC_REDIRECT_URI);
  assert.match(SIWC_REDIRECT_URI, /^http:\/\/127\.0\.0\.1:\d+\/auth\/callback$/);
  assert.equal(url.searchParams.get("resource"), "https://api.openai.com/v1");
  assert.equal(url.searchParams.get("code_challenge_method"), "S256");
  assert.equal(url.searchParams.get("code_challenge"), pkce.challenge);
  assert.ok(url.searchParams.get("scope").includes("chatgpt.tokens.use.direct"));
  const wieder = new URL(buildSiwcAuthorizationUrl({ pkce, hostId: "urn:uuid:x", clientId: "oaiapp_abc", idTokenHint: "id.tok.en" }));
  assert.equal(wieder.searchParams.get("client_id"), "oaiapp_abc");
  assert.equal(wieder.searchParams.get("agent_name_hint"), null);
  assert.equal(wieder.searchParams.get("id_token_hint"), "id.tok.en");
}
// Callback-Parsing + Scope-Pruefung
{
  const cb = parseSiwcCallback("http://127.0.0.1:1456/auth/callback?code=C1&state=S1&client_id=oaiapp_abc123&scope=chatgpt.tokens.use.direct+email+offline_access+openid+profile+resource.invoke");
  assert.equal(cb.code, "C1");
  assert.equal(cb.clientId, "oaiapp_abc123");
  assert.ok(istAusgegebeneClientId(cb.clientId));
  assert.ok(!istAusgegebeneClientId("dynamic_agent_client"));
  assert.ok(hatPlanScope(cb.scope));
  assert.ok(!hatPlanScope("openid profile email offline_access resource.invoke"));
  const abgelehnt = parseSiwcCallback("http://127.0.0.1:1456/auth/callback?error=access_denied&state=S1");
  assert.equal(abgelehnt.error, "access_denied");
}
// Refresh-Fehler: endgueltig vs. voruebergehend
{
  assert.ok(refreshEndgueltigGescheitert({ status: 400, detail: '{"error":"invalid_grant"}' }));
  assert.ok(refreshEndgueltigGescheitert({ status: 401, detail: "" }));
  assert.ok(!refreshEndgueltigGescheitert({ status: 503, detail: "" }));
  assert.ok(!refreshEndgueltigGescheitert({ status: 400, detail: '{"error":"temporarily_unavailable"}' }));
}
console.log("siwc-oauth: alle Pruefungen bestanden");

// Phase A6 — Innerer Runner für test-anthropic-oauth.mjs.
//
// Importiert die TS-Quelle direkt (tsx-Loader registriert in der
// .mjs-Hülle) und prüft die reinen Helfer. Kein Electron-Stub nötig:
// das OAuth-Helfer-Modul hängt nur an `node:crypto` und `fetch`.

import { createHash } from "node:crypto";
import { Buffer } from "node:buffer";

const mod = await import("../src/main/auth/anthropic-oauth.ts");
const {
  generatePkce,
  buildAuthorizationUrl,
  ANTHROPIC_OAUTH_AUTHORIZE_URL,
  ANTHROPIC_OAUTH_CLIENT_ID,
  ANTHROPIC_OAUTH_REDIRECT_URI,
  ANTHROPIC_OAUTH_SCOPE,
} = mod;

const failures = [];
function assert(cond, msg) {
  if (cond) {
    console.log(`  ok  ${msg}`);
  } else {
    failures.push(msg);
    console.log(`  FAIL ${msg}`);
  }
}

console.log("[test:anthropic-oauth] start");

// --- generatePkce -----------------------------------------------------

const a = generatePkce();
const b = generatePkce();

const BASE64URL = /^[A-Za-z0-9_-]+$/;

assert(typeof a.verifier === "string", "Verifier ist ein String");
assert(BASE64URL.test(a.verifier), "Verifier ist base64url-codiert (keine = + /)");
// 32 Bytes → base64 ohne Padding sind 43 Zeichen.
assert(a.verifier.length === 43, "Verifier-Länge entspricht 32 Bytes base64url");

assert(typeof a.challenge === "string", "Challenge ist ein String");
assert(BASE64URL.test(a.challenge), "Challenge ist base64url-codiert");
// sha256 ist 32 Byte → 43 Zeichen base64url.
assert(a.challenge.length === 43, "Challenge-Länge entspricht sha256 base64url");

// Manuell nachrechnen.
const expectedChallenge = createHash("sha256")
  .update(a.verifier)
  .digest("base64")
  .replace(/=+$/, "")
  .replace(/\+/g, "-")
  .replace(/\//g, "_");
assert(
  a.challenge === expectedChallenge,
  "Challenge === base64url(sha256(verifier))",
);

assert(typeof a.state === "string", "State ist ein String");
assert(BASE64URL.test(a.state), "State ist base64url-codiert");
assert(a.state.length === 43, "State-Länge entspricht 32 Bytes base64url");

assert(a.verifier !== b.verifier, "Verifier unterscheidet sich zwischen Aufrufen");
assert(a.state !== b.state, "State unterscheidet sich zwischen Aufrufen");

// --- buildAuthorizationUrl --------------------------------------------

const url = buildAuthorizationUrl(a);
assert(
  url.startsWith(ANTHROPIC_OAUTH_AUTHORIZE_URL + "?"),
  "URL beginnt mit dem Authorize-Endpoint",
);

const parsed = new URL(url);
const params = parsed.searchParams;
assert(
  params.get("client_id") === ANTHROPIC_OAUTH_CLIENT_ID,
  "client_id = öffentliche Claude-Code-Client-ID",
);
assert(params.get("response_type") === "code", "response_type=code");
assert(
  params.get("redirect_uri") === ANTHROPIC_OAUTH_REDIRECT_URI,
  "redirect_uri = console.anthropic.com/oauth/code/callback",
);
assert(params.get("scope") === ANTHROPIC_OAUTH_SCOPE, "scope=user:inference");
assert(params.get("state") === a.state, "State wird durchgereicht");
assert(params.get("code_challenge") === a.challenge, "code_challenge passt");
assert(
  params.get("code_challenge_method") === "S256",
  "code_challenge_method=S256",
);
assert(params.get("code") === "true", "Anthropic-spezifisches code=true vorhanden");

// Escaping: state und challenge enthalten nur URL-safe Zeichen, müssen
// aber trotzdem als-ist durch URLSearchParams hindurch — kein doppeltes
// Encoding. Wir prüfen, dass der Roh-String im URL.search auftaucht.
assert(
  parsed.search.includes(a.state),
  "State erscheint unverändert in der URL",
);

if (failures.length > 0) {
  console.error(
    `[test:anthropic-oauth] ${failures.length} Assertion(s) fehlgeschlagen:`,
  );
  for (const f of failures) console.error("  - " + f);
  process.exit(1);
}
console.log("[test:anthropic-oauth] alle Assertions ok");

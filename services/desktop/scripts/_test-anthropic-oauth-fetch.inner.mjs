// v0.1.146 — Inner runner für test:anthropic-oauth-fetch.
// Importiert den TS-Quellcode direkt via tsx und validiert das
// Verhalten des Fetch-Wrappers gegen einen Fake-Fetch.
//
// Abdeckung:
//   - Authorization: Bearer <token>
//   - anthropic-beta: oauth-2025-04-20
//   - x-api-key entfernt
//   - system-Feld (string + array + missing) bekommt den Claude-Code-Marker
//   - idempotent: doppelte Anwendung fügt nichts hinzu
//   - Pfade außerhalb /v1/messages bleiben body-unverändert
//   - URL-Objekt als input wird korrekt erkannt

import {
  CLAUDE_CODE_MARKER,
  makeAnthropicOAuthFetch,
} from "../../../packages/ai-provider/src/anthropic-oauth-fetch.ts";

let failed = 0;
function ok(label, cond) {
  if (cond) {
    console.log(`  ok  ${label}`);
  } else {
    console.error(`  FAIL  ${label}`);
    failed++;
  }
}

/** Build a fake fetch that captures the last call. */
function captureFetch() {
  const capture = {};
  const fakeFetch = async (input, init) => {
    capture.input = input;
    capture.init = init;
    return new Response("{}", { status: 200 });
  };
  return { fakeFetch, capture };
}

function getHeader(init, name) {
  const headers = init.headers;
  if (headers instanceof Headers) return headers.get(name);
  if (Array.isArray(headers)) {
    const found = headers.find(([k]) => k.toLowerCase() === name.toLowerCase());
    return found ? found[1] : null;
  }
  if (headers && typeof headers === "object") {
    const key = Object.keys(headers).find(
      (k) => k.toLowerCase() === name.toLowerCase(),
    );
    return key ? headers[key] : null;
  }
  return null;
}

// ----- Test 1: POST /v1/messages with string system -----
{
  const { fakeFetch, capture } = captureFetch();
  const wrapped = makeAnthropicOAuthFetch(fakeFetch, "sk-ant-oat01-test");
  await wrapped("https://api.anthropic.com/v1/messages", {
    method: "POST",
    headers: { "x-api-key": "leaked-key", "Content-Type": "application/json" },
    body: JSON.stringify({ system: "Foo", messages: [] }),
  });
  ok(
    "Test1: Authorization-Header ist Bearer <token>",
    getHeader(capture.init, "authorization") === "Bearer sk-ant-oat01-test",
  );
  ok(
    "Test1: anthropic-beta ist oauth-2025-04-20",
    getHeader(capture.init, "anthropic-beta") === "oauth-2025-04-20",
  );
  ok(
    "Test1: x-api-key wurde entfernt",
    getHeader(capture.init, "x-api-key") === null,
  );
  const parsed = JSON.parse(capture.init.body);
  ok(
    "Test1: system-Marker wurde dem String prepended",
    parsed.system === `${CLAUDE_CODE_MARKER}\n\nFoo`,
  );
}

// ----- Test 2: POST /v1/messages with array-system -----
{
  const { fakeFetch, capture } = captureFetch();
  const wrapped = makeAnthropicOAuthFetch(fakeFetch, "sk-ant-oat01-test");
  await wrapped("https://api.anthropic.com/v1/messages", {
    method: "POST",
    body: JSON.stringify({
      system: [{ type: "text", text: "Foo" }],
      messages: [],
    }),
  });
  const parsed = JSON.parse(capture.init.body);
  ok(
    "Test2: array-system bekommt Marker als ersten Eintrag",
    Array.isArray(parsed.system) &&
      parsed.system.length === 2 &&
      parsed.system[0].text === CLAUDE_CODE_MARKER &&
      parsed.system[1].text === "Foo",
  );
}

// ----- Test 3: Idempotenz (Marker bereits gesetzt) -----
{
  const { fakeFetch, capture } = captureFetch();
  const wrapped = makeAnthropicOAuthFetch(fakeFetch, "sk-ant-oat01-test");
  await wrapped("https://api.anthropic.com/v1/messages", {
    method: "POST",
    body: JSON.stringify({
      system: `${CLAUDE_CODE_MARKER}\n\nFoo`,
      messages: [],
    }),
  });
  const parsed = JSON.parse(capture.init.body);
  ok(
    "Test3: Marker wird nicht doppelt vorangestellt",
    parsed.system === `${CLAUDE_CODE_MARKER}\n\nFoo`,
  );
}

// ----- Test 4: Non-/v1/messages path -> body untouched, headers still set -----
{
  const { fakeFetch, capture } = captureFetch();
  const wrapped = makeAnthropicOAuthFetch(fakeFetch, "sk-ant-oat01-test");
  await wrapped("https://api.anthropic.com/v1/models", {
    method: "POST",
    headers: { "x-api-key": "leaked" },
    body: JSON.stringify({ foo: "bar" }),
  });
  ok(
    "Test4: Bearer-Header auch auf Nicht-/v1/messages-Pfaden",
    getHeader(capture.init, "authorization") === "Bearer sk-ant-oat01-test",
  );
  ok(
    "Test4: Body bei Nicht-/v1/messages-Pfaden unverändert",
    capture.init.body === JSON.stringify({ foo: "bar" }),
  );
}

// ----- Test 5: URL object as input -----
{
  const { fakeFetch, capture } = captureFetch();
  const wrapped = makeAnthropicOAuthFetch(fakeFetch, "sk-ant-oat01-test");
  await wrapped(new URL("https://api.anthropic.com/v1/messages"), {
    method: "POST",
    body: JSON.stringify({ system: "Foo", messages: [] }),
  });
  const parsed = JSON.parse(capture.init.body);
  ok(
    "Test5: URL-Objekt wird erkannt und Body korrekt umgeschrieben",
    parsed.system === `${CLAUDE_CODE_MARKER}\n\nFoo`,
  );
}

// ----- Test 6: Missing system field -----
{
  const { fakeFetch, capture } = captureFetch();
  const wrapped = makeAnthropicOAuthFetch(fakeFetch, "sk-ant-oat01-test");
  await wrapped("https://api.anthropic.com/v1/messages", {
    method: "POST",
    body: JSON.stringify({ messages: [] }),
  });
  const parsed = JSON.parse(capture.init.body);
  ok(
    "Test6: fehlendes system-Feld wird auf den Marker gesetzt",
    parsed.system === CLAUDE_CODE_MARKER,
  );
}

if (failed === 0) {
  console.log("[test:anthropic-oauth-fetch] done — all passed");
  process.exit(0);
} else {
  console.error(`[test:anthropic-oauth-fetch] ${failed} test(s) failed`);
  process.exit(1);
}

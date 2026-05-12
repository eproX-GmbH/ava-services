// Phase A1 — Smoke test for the Anthropic-subscription token storage
// path on ProviderConfigStore. Exercises:
//   - setAnthropicSubscriptionToken / getAnthropicSubscriptionToken
//     round-trip
//   - keychain isolation from the regular anthropic API key (both
//     stored at the same time)
//   - hasAnthropicSubscriptionToken reflects on-disk state
//   - clearAnthropicSubscriptionToken removes the blob
//   - persisting `anthropicAuthMode` round-trips through the config

// Note: electron stub is injected via a Node loader registered in the
// parent (test-anthropic-subscription.mjs). When the store imports
// `app` and `safeStorage` from "electron", the loader rewrites the
// specifier to a data: URL exporting in-memory stubs. This file just
// imports the store and exercises it.

const { ProviderConfigStore } = await import(
  "../src/main/agent/providers/store.ts"
);

const failures = [];
function assert(cond, msg) {
  if (cond) {
    console.log(`  ok  ${msg}`);
  } else {
    failures.push(msg);
    console.log(`  FAIL ${msg}`);
  }
}

console.log("[test:anthropic-subscription] start");

const store = ProviderConfigStore.shared();

// 1. Default state.
assert(
  !store.hasAnthropicSubscriptionToken(),
  "Default: kein Subscription-Token vorhanden",
);
assert(
  store.getConfig().anthropicAuthMode === "api-key",
  "Default: anthropicAuthMode === 'api-key'",
);

// 2. Set + read back.
const TOKEN = "sk-ant-oat01-test-" + "x".repeat(40);
store.setAnthropicSubscriptionToken(TOKEN);
assert(
  store.hasAnthropicSubscriptionToken(),
  "Nach set: hasAnthropicSubscriptionToken === true",
);
const got = await store.getAnthropicSubscriptionToken();
assert(got === TOKEN, "Round-trip: gelesener Token === geschriebener Token");

// 3. Keychain isolation: also stash an anthropic API key and confirm
//    the two blobs don't collide.
const API_KEY = "sk-ant-api03-test-" + "y".repeat(40);
store.setKey("anthropic", API_KEY);
assert(store.hasKey("anthropic"), "anthropic API-Key gespeichert");
assert(
  store.hasAnthropicSubscriptionToken(),
  "Subscription-Token bleibt nach Api-Key-Speichern erhalten",
);
const apiBack = await store.getKey("anthropic");
const subBack = await store.getAnthropicSubscriptionToken();
assert(apiBack === API_KEY, "API-Key Round-trip");
assert(subBack === TOKEN, "Subscription-Token Round-trip nach API-Key-Set");
assert(
  apiBack !== subBack,
  "API-Key und Subscription-Token sind unterschiedlich (Isolation)",
);

// 4. anthropicAuthMode round-trips through setConfig.
store.setConfig({ anthropicAuthMode: "subscription" });
assert(
  store.getConfig().anthropicAuthMode === "subscription",
  "setConfig('subscription') persistiert",
);
store.setConfig({ anthropicAuthMode: "api-key" });
assert(
  store.getConfig().anthropicAuthMode === "api-key",
  "setConfig('api-key') persistiert",
);

// 5. Clear removes the blob without touching the API key.
store.clearAnthropicSubscriptionToken();
assert(
  !store.hasAnthropicSubscriptionToken(),
  "Nach clear: Token weg",
);
assert(
  store.hasKey("anthropic"),
  "Nach clear: anthropic API-Key bleibt erhalten",
);

// 6. Empty / short tokens are rejected by the store.
let threw = false;
try {
  store.setAnthropicSubscriptionToken("");
} catch {
  threw = true;
}
assert(threw, "setAnthropicSubscriptionToken('') wirft");

if (failures.length > 0) {
  console.error(
    `[test:anthropic-subscription] ${failures.length} Assertion(s) fehlgeschlagen:`,
  );
  for (const f of failures) console.error("  - " + f);
  process.exit(1);
}
console.log("[test:anthropic-subscription] alle Assertions ok");

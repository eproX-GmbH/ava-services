import type { HostedProviderKind } from "../../../shared/types";

// Use Node's undici fetch instead of Electron's Chromium-net global
// fetch — same reasoning as packages/ai-provider/src/runtime.ts.
// Chromium's macOS trust store fails to parse some intermediate
// certs in Hardened-Runtime builds, surfacing as ECONNRESET. undici
// uses Node's TLS stack directly.
let probeFetch: typeof fetch = fetch;
try {
  // eslint-disable-next-line @typescript-eslint/no-require-imports, @typescript-eslint/no-var-requires
  const undici = require("undici") as { fetch?: typeof fetch };
  if (typeof undici.fetch === "function") {
    probeFetch = undici.fetch;
  }
} catch {
  /* keep global fetch */
}

// Cheap API-key validation probes (Phase 8.k10b).
//
// Goal: tell the user "yes that key works" or "401, try again" in <2s
// before we persist it and flip the active provider. We deliberately
// pick the cheapest verifiable endpoint per provider — usually the
// model-list — because:
//   - It's GET-only / metadata-only on every provider here, so no
//     completion tokens get billed.
//   - 401 / 403 means key bad; 200 means at least the auth side works.
//     Quota/billing problems still surface later as 429/402 on the real
//     completion call, but those aren't "wrong key" failures and the
//     user can sort them out without us re-prompting for a paste.
//   - Network errors are reported separately from auth failures so the
//     user can distinguish "your key is wrong" from "you're offline".
//
// We do NOT issue a 1-token completion as a "definitive" probe: that
// costs cents per check, would time out behind some corporate proxies
// (Anthropic streams, Google's generateContent is non-trivial), and
// the metadata endpoint is enough to catch the overwhelmingly common
// "user mistyped the key" case that motivates this feature.

const PROBE_TIMEOUT_MS = 4_000;

export type KeyValidation =
  | { ok: true }
  | { ok: false, reason: string };

export async function validateApiKey(
  kind: HostedProviderKind,
  apiKey: string,
): Promise<KeyValidation> {
  const trimmed = apiKey.trim();
  if (trimmed.length === 0) {
    return { ok: false, reason: "Empty API key." };
  }

  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), PROBE_TIMEOUT_MS);
  try {
    switch (kind) {
      case "openai":
        return await probeOpenAI(trimmed, ctrl.signal);
      case "anthropic":
        return await probeAnthropic(trimmed, ctrl.signal);
      case "google":
        return await probeGoogle(trimmed, ctrl.signal);
      case "mistral":
        return await probeMistral(trimmed, ctrl.signal);
    }
  } catch (err) {
    if (err instanceof Error && err.name === "AbortError") {
      return {
        ok: false,
        reason: `Timed out after ${PROBE_TIMEOUT_MS / 1000}s — check your network.`,
      };
    }
    return {
      ok: false,
      reason: `Network error: ${err instanceof Error ? err.message : String(err)}`,
    };
  } finally {
    clearTimeout(timer);
  }
}

// OpenAI: `GET /v1/models` is the canonical "is this key live" probe.
// Returns 401 with `{ "error": { "code": "invalid_api_key", ... } }`
// when the key is wrong, 200 with a long model list when it's right.
async function probeOpenAI(
  apiKey: string,
  signal: AbortSignal,
): Promise<KeyValidation> {
  const res = await probeFetch("https://api.openai.com/v1/models", {
    method: "GET",
    headers: { authorization: `Bearer ${apiKey}` },
    signal,
  });
  return interpret(res, "OpenAI");
}

// Anthropic: `GET /v1/models` was added in 2024 and is auth-checked.
// Requires the `anthropic-version` header — without it the endpoint
// 400s on shape, not auth, which would falsely accept invalid keys.
async function probeAnthropic(
  apiKey: string,
  signal: AbortSignal,
): Promise<KeyValidation> {
  const res = await probeFetch("https://api.anthropic.com/v1/models", {
    method: "GET",
    headers: {
      "x-api-key": apiKey,
      "anthropic-version": "2023-06-01",
    },
    signal,
  });
  return interpret(res, "Anthropic");
}

// Google: the public Generative Language API takes the key as a query
// arg. `?key=…` on `/v1beta/models` returns 200 + a model list when
// valid, 400 with `API_KEY_INVALID` when not. Note Google uses 400
// rather than 401 here — we treat both as auth failures via the body
// peek below.
async function probeGoogle(
  apiKey: string,
  signal: AbortSignal,
): Promise<KeyValidation> {
  const url = new URL("https://generativelanguage.googleapis.com/v1beta/models");
  url.searchParams.set("key", apiKey);
  const res = await probeFetch(url, { method: "GET", signal });
  if (res.ok) return { ok: true };
  const body = await safeReadJson(res);
  const status = body?.error?.status as string | undefined;
  if (status === "INVALID_ARGUMENT" || status === "UNAUTHENTICATED") {
    return { ok: false, reason: "Google rejected the key (invalid)." };
  }
  return interpretFallback(res, "Google", body);
}

// Mistral: `GET /v1/models`, Bearer auth, identical contract to OpenAI's.
async function probeMistral(
  apiKey: string,
  signal: AbortSignal,
): Promise<KeyValidation> {
  const res = await probeFetch("https://api.mistral.ai/v1/models", {
    method: "GET",
    headers: { authorization: `Bearer ${apiKey}` },
    signal,
  });
  return interpret(res, "Mistral");
}

// Shared 200-or-401-or-other handler. We don't read the body on success
// (the model list can be tens of KB and we don't need it), only on
// failure to extract a human-readable reason.
async function interpret(
  res: Response,
  label: string,
): Promise<KeyValidation> {
  if (res.ok) return { ok: true };
  if (res.status === 401 || res.status === 403) {
    return { ok: false, reason: `${label} rejected the key (invalid).` };
  }
  return interpretFallback(res, label, await safeReadJson(res));
}

function interpretFallback(
  res: Response,
  label: string,
  body: { error?: { message?: string } } | null,
): KeyValidation {
  const msg = body?.error?.message;
  return {
    ok: false,
    reason: `${label} returned HTTP ${res.status}${msg ? ` — ${msg}` : ""}.`,
  };
}

async function safeReadJson(
  res: Response,
): Promise<{ error?: { message?: string; status?: string } } | null> {
  try {
    return (await res.json()) as { error?: { message?: string; status?: string } };
  } catch {
    return null;
  }
}

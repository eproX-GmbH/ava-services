// v0.1.353 — Desktop-lokaler Builder für das ChatGPT-Abo-Modell
// („Sign in with ChatGPT"). Bewusst NICHT im geteilten @ava/ai-provider-
// Paket, weil dessen `dist/index.js` per CI-Guard (check-vendor-drift)
// byte-genau gegen die in den Producer-Submodulen vendorten Kopien
// abgeglichen wird. Die Producer brauchen den Abo-Pfad nicht (sie laufen
// mit ihrem env-LLM), also bleibt die ganze Logik hier im Desktop —
// kein Drift, kein vendor-Update nötig.
//
// Das Abo läuft über den Codex-Backend-Endpunkt:
//   POST https://chatgpt.com/backend-api/codex/responses   (Responses-API)
// mit Bearer-Token + `chatgpt-account-id`-Header. Wir setzen die baseURL
// des @ai-sdk/openai-Clients auf `…/codex` und nutzen `.responses(model)`.

import { createOpenAI } from "@ai-sdk/openai";
import type { LanguageModel } from "ai";

const OPENAI_CODEX_BASE_URL = "https://chatgpt.com/backend-api/codex";

// Node 20+ undici-fetch bevorzugen (Chromium-net-fetch hat im Hardened-
// Runtime macOS-Build den bekannten ECONNRESET-Bug bei gestreamten
// Responses). Probe beim Modul-Load, Fallback auf global fetch.
let preferredFetch: typeof fetch | undefined;
try {
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const undici = require("undici") as { fetch?: typeof fetch };
  if (typeof undici.fetch === "function") preferredFetch = undici.fetch;
} catch {
  /* undici nicht auflösbar — global fetch */
}

function randomSessionId(): string {
  try {
    const c = (globalThis as { crypto?: { randomUUID?: () => string } }).crypto;
    if (c?.randomUUID) return c.randomUUID();
  } catch {
    /* fall through */
  }
  return Date.now().toString(16) + "-" + Math.random().toString(16).slice(2, 10);
}

/**
 * Wrap fetch: Bearer + chatgpt-account-id + Codex-Marker-Header, und bei
 * POSTs auf `/responses` `store: false` einfügen (der Endpunkt ist
 * stateless und verlangt das).
 */
function makeCodexFetch(
  baseFetch: typeof fetch,
  accessToken: string,
  accountId: string | undefined,
): typeof fetch {
  const sessionId = randomSessionId();
  return ((input: Parameters<typeof fetch>[0], init?: RequestInit) => {
    const next: RequestInit = { ...(init ?? {}) };
    const headers = new Headers(next.headers ?? {});
    headers.delete("x-api-key");
    headers.set("authorization", `Bearer ${accessToken}`);
    if (accountId && accountId.length > 0) {
      headers.set("chatgpt-account-id", accountId);
    }
    if (!headers.has("openai-beta")) {
      headers.set("openai-beta", "responses=experimental");
    }
    headers.set("originator", "codex_cli_rs");
    if (!headers.has("session_id")) headers.set("session_id", sessionId);
    next.headers = headers;

    const url =
      typeof input === "string"
        ? input
        : input instanceof URL
          ? input.toString()
          : input.url;
    if (url.includes("/responses") && typeof next.body === "string") {
      try {
        const parsed = JSON.parse(next.body) as Record<string, unknown>;
        if (parsed.store !== false) parsed.store = false;
        next.body = JSON.stringify(parsed);
      } catch {
        /* body not JSON */
      }
    }
    return baseFetch(input, next);
  }) as typeof fetch;
}

/**
 * Baue ein AI-SDK-LanguageModel, das gegen den Codex-Abo-Endpunkt
 * spricht. `model` ist eine Codex-fähige Modell-ID (z. B. `gpt-5.1`,
 * `gpt-5.1-codex`). `accountId` ist optional, wird aber von OpenAI
 * üblicherweise verlangt.
 */
export function createOpenAISubscriptionModel(args: {
  model: string;
  accessToken: string;
  accountId?: string;
}): LanguageModel {
  const client = createOpenAI({
    apiKey: "oauth-placeholder",
    baseURL: OPENAI_CODEX_BASE_URL,
    fetch: makeCodexFetch(
      preferredFetch ?? fetch,
      args.accessToken,
      args.accountId,
    ),
  });
  return client.responses(args.model);
}

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

// v0.1.382 — Der Codex-Backend-Endpunkt akzeptiert NUR Codex-fähige
// Modell-IDs (im Kern `gpt-5` und `gpt-5-codex`), NICHT die allgemeinen
// API-Katalog-IDs (gpt-5.4-mini, gpt-5.5, gpt-4o, o3, …). Schickt der
// Nutzer eine Katalog-ID — und der Default fürs Abo war `gpt-5.4-mini` —
// antwortet der Endpunkt mit `400 Bad Request`. Genau der gemeldete
// Fehler. Wir mappen darum jede eingehende ID auf eine Codex-erlaubte ID.
// Override per Env, falls OpenAI die IDs umbenennt (kein Rebuild nötig).
const CODEX_DEFAULT_MODEL = "gpt-5";

// v0.1.383 — Der Codex-Backend-Endpunkt erwartet im `instructions`-Feld eine
// kurze Codex-Basispräambel und limitiert das Feld auf ~32 KiB. Der
// @ai-sdk/openai-Responses-Provider mappt aber unseren KOMPLETTEN
// System-Prompt (Persona + Skills + Tools + Erinnerungen) in genau dieses
// Feld — das ist fast immer deutlich >32 KiB → der Endpunkt antwortet mit
// `400 Bad Request` (der gemeldete Fehler, der auch nach Neu-Verbinden des
// Abos blieb, weil er nichts mit dem Token zu tun hat). Wir verschieben den
// echten AVA-Prompt darum in eine führende `developer`-Input-Nachricht
// (höheres Limit, gleiche Anweisungs-Priorität) und setzen `instructions` auf
// die erwartete kurze Codex-Präambel. Analog zum Anthropic-CLAUDE_CODE_MARKER,
// nur invers: dort PREPENDen wir den Marker, hier ERSETZEN wir das Feld und
// reichen den eigentlichen Prompt als Input durch.
const CODEX_INSTRUCTIONS =
  "You are Codex, based on GPT-5. You are running as a coding agent.";

export function normalizeCodexModel(model: string): string {
  const override = process.env.AVA_OPENAI_CODEX_MODEL?.trim();
  if (override) return override;
  const m = (model || "").trim().toLowerCase();
  if (!m) return CODEX_DEFAULT_MODEL;
  // Bereits eine Codex-ID (…-codex) → unverändert durchlassen.
  if (m.includes("codex")) return model;
  // Exakt erlaubte Basis-IDs durchlassen.
  if (m === "gpt-5" || m === "gpt-5-codex") return m;
  // Alles andere (gpt-5.x, gpt-4*, o3/o4, mini/nano …) → Codex-Default.
  return CODEX_DEFAULT_MODEL;
}

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
  return (async (
    input: Parameters<typeof fetch>[0],
    init?: RequestInit,
  ) => {
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

        // Großen System-Prompt aus `instructions` in eine führende
        // `developer`-Input-Nachricht verschieben (umgeht das ~32-KiB-Limit
        // des Codex-Endpunkts) und `instructions` auf die kurze Präambel
        // setzen. Idempotent: bereits-gemappte Requests werden übersprungen.
        const instr = parsed.instructions;
        if (typeof instr === "string" && instr.length > 0) {
          if (instr !== CODEX_INSTRUCTIONS) {
            const devMsg = {
              type: "message",
              role: "developer",
              content: [{ type: "input_text", text: instr }],
            };
            parsed.input = Array.isArray(parsed.input)
              ? [devMsg, ...parsed.input]
              : [devMsg];
            parsed.instructions = CODEX_INSTRUCTIONS;
          }
        } else if (instr == null) {
          // Kein System-Prompt im Body — der Endpunkt verlangt trotzdem ein
          // nicht-leeres `instructions`-Feld.
          parsed.instructions = CODEX_INSTRUCTIONS;
        }

        next.body = JSON.stringify(parsed);
      } catch {
        /* body not JSON */
      }
    }

    const res = await baseFetch(input, next);

    // v0.1.382 — Bei 4xx/5xx auf dem Codex-Endpunkt den ECHTEN Fehler-Body
    // loggen. Vorher ging er verloren und der Nutzer sah nur ein opakes
    // „Bad Request". Wir klonen die Response (Original bleibt für das
    // AI-SDK lesbar) und schreiben Status + Body-Auszug in die Konsole —
    // so ist eine künftige 400 sofort diagnostizierbar.
    if (!res.ok && url.includes("/responses")) {
      try {
        const bodyText = await res.clone().text();
        // eslint-disable-next-line no-console
        console.error(
          `[openai-subscription] Codex ${res.status} ${res.statusText}: ${bodyText.slice(0, 1000)}`,
        );
      } catch {
        /* body not readable */
      }
    }
    return res;
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
  const codexModel = normalizeCodexModel(args.model);
  if (codexModel !== args.model) {
    // eslint-disable-next-line no-console
    console.log(
      `[openai-subscription] Modell für Codex-Endpunkt gemappt: ${args.model} → ${codexModel} (nur Codex-IDs werden akzeptiert)`,
    );
  }
  const client = createOpenAI({
    apiKey: "oauth-placeholder",
    baseURL: OPENAI_CODEX_BASE_URL,
    fetch: makeCodexFetch(
      preferredFetch ?? fetch,
      args.accessToken,
      args.accountId,
    ),
  });
  return client.responses(codexModel);
}

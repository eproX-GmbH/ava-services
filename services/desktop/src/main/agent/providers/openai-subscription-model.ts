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

// v0.1.385 — Der ChatGPT-Account-Codex-Endpunkt akzeptiert NUR die
// `…-codex`-Modellfamilie, NICHT die allgemeinen API-Katalog-IDs — und
// (entgegen der v0.1.382-Annahme) AUCH NICHT das nackte `gpt-5`. Der echte
// Server-Body belegt das wörtlich:
//   {"detail":"The 'gpt-5' model is not supported when using Codex with a
//    ChatGPT account."}
// Darum mappen wir JEDE Nicht-Codex-ID (gpt-5, gpt-5.4-mini, gpt-4o, o3, …)
// auf das Codex-Default `gpt-5-codex` (das Default des echten Codex-CLI mit
// ChatGPT-Login). Override per Env, falls OpenAI die IDs umbenennt (kein
// Rebuild nötig).
const CODEX_DEFAULT_MODEL = "gpt-5-codex";

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
  // Alles andere — inkl. des nackten `gpt-5`, das der ChatGPT-Account-Codex-
  // Endpunkt ablehnt — auf das Codex-Default mappen.
  return CODEX_DEFAULT_MODEL;
}

// ===========================================================================
// v0.1.388 — Modell-Auflösung über das Codex-`/models`-Endpoint.
//
// KERN-ERKENNTNIS (aus dem echten Server-Body + openai/codex-Quellen): WELCHE
// Codex-Modelle ein ChatGPT-Konto nutzen darf, ist KONTO-/PLAN-/ZEIT-abhängig
// und vom Backend gegated. Jedes feste Modell scheitert früher oder später mit
//   {"detail":"The '<slug>' model is not supported when using Codex with a
//    ChatGPT account."}
// — das trifft auch die offizielle Codex-CLI (#14306, #19654). Deshalb hardcodet
// die offizielle CLI NICHTS, sondern fragt
//   GET https://chatgpt.com/backend-api/codex/models?client_version=…
// (mit Bearer + chatgpt-account-id) ab und nutzt den fürs Konto berechtigten
// Default-Slug + dessen `base_instructions`. Genau das machen wir hier.
// ===========================================================================

// Client-Version für den ?client_version=-Query. Hoch genug, damit das Backend
// keine Modelle wegen `minimal_client_version` herausfiltert; Format wie in den
// openai/codex-Tests.
const CODEX_CLIENT_VERSION = "0.99.0";

interface CodexModelInfo {
  slug: string;
  priority?: number;
  visibility?: string;
  isDefault?: boolean;
  baseInstructions?: string;
}

export interface ResolvedCodexModel {
  slug: string;
  baseInstructions?: string;
}

interface CodexModelCacheEntry {
  resolved: ResolvedCodexModel;
  fetchedAt: number;
}

const CODEX_MODEL_CACHE_TTL_MS = 30 * 60 * 1000; // 30 min
const codexModelCache = new Map<string, CodexModelCacheEntry>();
const codexModelInFlight = new Map<string, Promise<ResolvedCodexModel>>();

/** GET /models — die fürs Konto berechtigten Codex-Modelle abrufen. */
async function fetchEntitledCodexModels(
  baseFetch: typeof fetch,
  accessToken: string,
  accountId: string | undefined,
): Promise<CodexModelInfo[]> {
  const headers = new Headers();
  headers.set("authorization", `Bearer ${accessToken}`);
  if (accountId && accountId.length > 0) {
    headers.set("chatgpt-account-id", accountId);
  }
  headers.set("originator", "codex_cli_rs");
  headers.set("accept", "application/json");
  const url = `${OPENAI_CODEX_BASE_URL}/models?client_version=${CODEX_CLIENT_VERSION}`;
  const res = await baseFetch(url, { method: "GET", headers });
  if (!res.ok) {
    const body = await res.clone().text().catch(() => "");
    throw new Error(
      `models endpoint ${res.status} ${res.statusText}: ${body.slice(0, 300)}`,
    );
  }
  const json = (await res.json()) as { models?: unknown };
  const raw = Array.isArray(json.models) ? json.models : [];
  const models: CodexModelInfo[] = [];
  for (const m of raw) {
    if (!m || typeof m !== "object") continue;
    const o = m as Record<string, unknown>;
    if (typeof o.slug !== "string" || o.slug.length === 0) continue;
    models.push({
      slug: o.slug,
      priority: typeof o.priority === "number" ? o.priority : undefined,
      visibility: typeof o.visibility === "string" ? o.visibility : undefined,
      isDefault: o.is_default === true,
      baseInstructions:
        typeof o.base_instructions === "string"
          ? o.base_instructions
          : undefined,
    });
  }
  return models;
}

/** Aus der berechtigten Liste den besten Slug wählen. */
function pickBestCodexModel(
  models: CodexModelInfo[],
  preferred: string | undefined,
): CodexModelInfo | null {
  const listable = models.filter((m) => m.visibility !== "hidden");
  const pool = listable.length > 0 ? listable : models;
  if (pool.length === 0) return null;
  // 1) Nutzer-/Env-Wunsch ehren, falls das Konto ihn wirklich freigeschaltet hat.
  if (preferred) {
    const want = preferred.trim().toLowerCase();
    const hit = pool.find((m) => m.slug.toLowerCase() === want);
    if (hit) return hit;
  }
  // 2) Vom Backend als Default markiertes Modell.
  const def = pool.find((m) => m.isDefault);
  if (def) return def;
  // 3) Höchste Priorität (kleinste priority-Zahl = oben).
  return (
    [...pool].sort((a, b) => (a.priority ?? 9999) - (b.priority ?? 9999))[0] ??
    null
  );
}

/**
 * Den fürs Konto gültigen Codex-Slug (+ base_instructions) ermitteln.
 * Gecacht pro Konto (30 min) mit In-Flight-Dedup. Bei Fehlern Fallback auf
 * normalizeCodexModel (best guess) — dann scheitert /responses zwar evtl.,
 * aber der echte Grund ist seit v0.1.384 in der Chat-Meldung sichtbar.
 */
export async function resolveCodexModel(
  baseFetch: typeof fetch,
  accessToken: string,
  accountId: string | undefined,
  preferred: string,
): Promise<ResolvedCodexModel> {
  // Expliziter Env-Override schlägt alles (kein /models-Roundtrip nötig).
  const envOverride = process.env.AVA_OPENAI_CODEX_MODEL?.trim();
  if (envOverride) return { slug: envOverride };

  const key = accountId && accountId.length > 0 ? accountId : "__noacct__";
  const cached = codexModelCache.get(key);
  if (cached && Date.now() - cached.fetchedAt < CODEX_MODEL_CACHE_TTL_MS) {
    return cached.resolved;
  }
  const inFlight = codexModelInFlight.get(key);
  if (inFlight) return inFlight;

  const task = (async (): Promise<ResolvedCodexModel> => {
    try {
      const models = await fetchEntitledCodexModels(
        baseFetch,
        accessToken,
        accountId,
      );
      const best = pickBestCodexModel(models, preferred);
      if (!best) {
        throw new Error("models endpoint returned no usable slugs");
      }
      const resolved: ResolvedCodexModel = {
        slug: best.slug,
        baseInstructions: best.baseInstructions,
      };
      codexModelCache.set(key, { resolved, fetchedAt: Date.now() });
      // eslint-disable-next-line no-console
      console.log(
        `[openai-subscription] Codex-Modell vom Konto aufgelöst: ${best.slug}` +
          ` (berechtigte: ${models.map((m) => m.slug).join(", ") || "—"})`,
      );
      return resolved;
    } catch (err) {
      // eslint-disable-next-line no-console
      console.warn(
        "[openai-subscription] /models-Abruf fehlgeschlagen, nutze Fallback-Mapping:",
        err instanceof Error ? err.message : String(err),
      );
      return { slug: normalizeCodexModel(preferred) };
    } finally {
      codexModelInFlight.delete(key);
    }
  })();
  codexModelInFlight.set(key, task);
  return task;
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

        // v0.1.388 — Das fürs Konto BERECHTIGTE Modell + dessen offizielle
        // `base_instructions` vom /models-Endpoint holen (gecacht) und in den
        // Request einsetzen. Das ersetzt das alte „rate ein Modell"-Verfahren.
        const wanted =
          typeof parsed.model === "string" ? parsed.model : CODEX_DEFAULT_MODEL;
        const resolved = await resolveCodexModel(
          baseFetch,
          accessToken,
          accountId,
          wanted,
        );
        parsed.model = resolved.slug;

        // Präambel: bevorzugt die offizielle `base_instructions` des Modells
        // (was der echte Client schickt), sonst die kurze Fallback-Präambel.
        const preamble = resolved.baseInstructions ?? CODEX_INSTRUCTIONS;

        // Großen System-Prompt aus `instructions` in eine führende
        // `developer`-Input-Nachricht verschieben (umgeht das ~32-KiB-Limit
        // des Codex-Endpunkts). Idempotent: bereits-verschobene Requests
        // (instructions == preamble) werden übersprungen.
        const instr = parsed.instructions;
        if (typeof instr === "string" && instr.length > 0) {
          if (instr !== preamble) {
            const devMsg = {
              type: "message",
              role: "developer",
              content: [{ type: "input_text", text: instr }],
            };
            parsed.input = Array.isArray(parsed.input)
              ? [devMsg, ...parsed.input]
              : [devMsg];
            parsed.instructions = preamble;
          }
        } else if (instr == null) {
          // Kein System-Prompt im Body — der Endpunkt verlangt trotzdem ein
          // nicht-leeres `instructions`-Feld.
          parsed.instructions = preamble;
        }

        next.body = JSON.stringify(parsed);
      } catch (err) {
        // v0.1.388 — Body-Parse/Resolve fehlgeschlagen: nicht verschlucken,
        // sonst ginge ein ungemapptes Modell raus. Loggen, Original-Body lassen.
        // eslint-disable-next-line no-console
        console.warn(
          "[openai-subscription] Codex-Body-Rewrite übersprungen:",
          err instanceof Error ? err.message : String(err),
        );
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
  // v0.1.388 — Nur ein Platzhalter-Slug. Das tatsächlich verwendete Modell
  // wird pro Request in makeCodexFetch über das /models-Endpoint des Kontos
  // aufgelöst und in den Body eingesetzt (resolveCodexModel). Der hier
  // übergebene Wert greift nur, falls der Rewrite mal nicht stattfindet.
  const codexModel = normalizeCodexModel(args.model);
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

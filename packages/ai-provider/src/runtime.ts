// Runtime-config factories (Phase 8.k).
//
// The existing `getLLM()` / `getEmbedder()` in `./index` read process.env
// at the moment of construction. That's right for backend services
// (12-factor, restart on config change) but wrong for the Desktop-App,
// which lets the *user* pick a provider at runtime in Settings → Agent
// and persists the key encrypted via Electron's safeStorage.
//
// `createLLM` / `createEmbedder` take the same provider taxonomy but
// accept the key + optional baseURL as arguments. No process.env read,
// no exception on missing env. The desktop's LlmProviderManager passes
// a fresh config bundle each time the user flips the picker.
//
// Backend services keep using `getLLM()`. We deliberately don't merge
// the two paths — env-fallback in a runtime-config factory turns into
// a "why is this picking up OPENAI_API_KEY when I cleared it?" footgun.

import { createOpenAI } from "@ai-sdk/openai";
import { createAnthropic } from "@ai-sdk/anthropic";
import { createGoogleGenerativeAI } from "@ai-sdk/google";
import { createMistral } from "@ai-sdk/mistral";
import { createOllama } from "ollama-ai-provider-v2";
import type { EmbeddingModel, LanguageModel } from "ai";
import type { CatalogProvider } from "./catalog";
import { makeAnthropicOAuthFetch } from "./anthropic-oauth-fetch";

// Force Node's undici-based fetch instead of Electron's Chromium-net
// global fetch when we're inside an Electron main process. Chromium's
// trust_store_mac.cc has a known bug parsing certain TLS certificate
// extensions in Hardened-Runtime macOS builds, which manifests as
// `read ECONNRESET` inside TLSWrap.onStreamRead the moment OpenAI's
// streamed `/v1/responses` chunked response starts coming back.
//
// undici is bundled with Node 20+ and re-exposed here via a runtime
// require so this file still type-checks in environments without
// undici on the resolution path. We probe at module load and fall
// back to the global fetch if undici isn't reachable (browser /
// edge runtime).
let preferredFetch: typeof fetch | undefined;
try {
  // eslint-disable-next-line @typescript-eslint/no-require-imports, @typescript-eslint/no-var-requires
  const undici = require("undici") as { fetch?: typeof fetch };
  if (typeof undici.fetch === "function") {
    preferredFetch = undici.fetch;
  }
} catch {
  /* undici not on resolution path — keep global fetch */
}

/** Runtime-config taxonomy. Same set as catalog.CatalogProvider. */
export type RuntimeProvider = CatalogProvider;

export interface CreateLLMOptions {
  provider: RuntimeProvider;
  /** Model id from the catalog (or any tag the provider accepts). */
  model: string;
  /**
   * API key. Required for hosted providers. Ignored for `ollama` (the
   * local server has no auth in our deployment). Mutually exclusive
   * with `anthropicSubscriptionToken` when `provider === "anthropic"`.
   */
  apiKey?: string;
  /**
   * Phase A1 — Anthropic OAuth subscription token, produced by
   * Anthropic's `claude setup-token` CLI. When set and
   * `provider === "anthropic"`, the runtime sends
   * `Authorization: Bearer <token>` instead of `x-api-key`, consuming
   * the user's Claude Pro/Max-Abo quota instead of API credits.
   * Ignored for every other provider.
   */
  anthropicSubscriptionToken?: string;
  /**
   * Override the provider base URL. Used for self-hosted Ollama on a
   * non-default port, or a hypothetical OpenAI-compatible endpoint.
   * Pass `http://host:port/api` for Ollama (the trailing /api is
   * required by ollama-ai-provider-v2).
   */
  baseURL?: string;
  /** OpenAI multi-tenant headers — passed straight through to the SDK. */
  openaiProject?: string;
  openaiOrganization?: string;
}

export interface CreateEmbedderOptions extends Omit<CreateLLMOptions, "provider"> {
  /** Mistral has no embedding endpoint we use; `anthropic` has no embed at all. */
  provider: Exclude<RuntimeProvider, "anthropic" | "mistral">;
}

/**
 * Build an AI-SDK LanguageModel from runtime config. Throws on missing
 * keys for hosted providers — the caller (LlmProviderManager) checks
 * `hasKey()` first and returns a friendly status before reaching here.
 */
export function createLLM(opts: CreateLLMOptions): LanguageModel {
  switch (opts.provider) {
    case "openai": {
      const client = createOpenAI({
        apiKey: requireKey(opts, "OPENAI_API_KEY"),
        project: opts.openaiProject,
        organization: opts.openaiOrganization,
        fetch: preferredFetch,
      });
      return client(opts.model);
    }
    case "anthropic": {
      const subscriptionToken = opts.anthropicSubscriptionToken;
      if (subscriptionToken && subscriptionToken.length > 0) {
        // Phase A1 — Claude Pro/Max-Abo OAuth path. See
        // `anthropic-oauth-fetch.ts` for the full wrapper rationale
        // (bearer injection + Claude-Code system-marker on
        // /v1/messages). We pass a placeholder apiKey because the SDK
        // refuses to construct without one; the fetch wrapper strips
        // any x-api-key the SDK would otherwise emit.
        const client = createAnthropic({
          apiKey: "oauth-placeholder",
          headers: { "x-api-key": "" },
          fetch: makeAnthropicOAuthFetch(
            preferredFetch ?? fetch,
            subscriptionToken,
          ),
        });
        return client(opts.model);
      }
      const client = createAnthropic({
        apiKey: requireKey(opts, "ANTHROPIC_API_KEY"),
        fetch: preferredFetch,
      });
      return client(opts.model);
    }
    case "google": {
      const client = createGoogleGenerativeAI({
        apiKey: requireKey(opts, "GOOGLE_API_KEY"),
        fetch: preferredFetch,
      });
      return client(opts.model);
    }
    case "mistral": {
      const client = createMistral({
        apiKey: requireKey(opts, "MISTRAL_API_KEY"),
        fetch: preferredFetch,
      });
      return client(opts.model);
    }
    case "ollama": {
      const client = createOllama({
        baseURL: opts.baseURL ?? "http://localhost:11434/api",
        fetch: preferredFetch,
      });
      return client(opts.model);
    }
    default: {
      // Exhaustiveness check — flips to a TS error if a new provider
      // joins CatalogProvider without a branch here.
      const _exhaustive: never = opts.provider;
      throw new Error(`Unknown provider: ${String(_exhaustive)}`);
    }
  }
}

/** Same for embedding models. Mistral/Anthropic excluded by the type. */
export function createEmbedder(
  opts: CreateEmbedderOptions,
): EmbeddingModel<string> {
  switch (opts.provider) {
    case "openai": {
      const client = createOpenAI({
        apiKey: requireKey(opts, "OPENAI_API_KEY"),
        project: opts.openaiProject,
        organization: opts.openaiOrganization,
        fetch: preferredFetch,
      });
      return client.textEmbeddingModel(opts.model);
    }
    case "google": {
      const client = createGoogleGenerativeAI({
        apiKey: requireKey(opts, "GOOGLE_API_KEY"),
        fetch: preferredFetch,
      });
      return client.textEmbeddingModel(opts.model);
    }
    case "ollama": {
      const client = createOllama({
        baseURL: opts.baseURL ?? "http://localhost:11434/api",
        fetch: preferredFetch,
      });
      return client.textEmbeddingModel(opts.model);
    }
    default: {
      const _exhaustive: never = opts.provider;
      throw new Error(`Unknown embedder provider: ${String(_exhaustive)}`);
    }
  }
}

function requireKey(
  opts: { provider: RuntimeProvider; apiKey?: string },
  envName: string,
): string {
  if (opts.apiKey && opts.apiKey.length > 0) return opts.apiKey;
  // Last-resort: env. Backend services that wrap createLLM directly
  // can rely on this; the desktop manager always passes apiKey
  // explicitly so the env path never fires there.
  const envValue = process.env[envName];
  if (envValue && envValue.length > 0) return envValue;
  throw new Error(
    `createLLM/createEmbedder: provider=${opts.provider} requires apiKey ` +
      `(or ${envName} in env).`,
  );
}

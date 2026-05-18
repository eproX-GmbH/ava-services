import OpenAI from "openai";
import { createOpenAI } from "@ai-sdk/openai";
import { createAnthropic } from "@ai-sdk/anthropic";
import { createGoogleGenerativeAI } from "@ai-sdk/google";
import { createMistral } from "@ai-sdk/mistral";
import { createOllama } from "ollama-ai-provider-v2";
import type { EmbeddingModel, LanguageModel } from "ai";
import { makeAnthropicOAuthFetch } from "./anthropic-oauth-fetch";

// Two distinct LLM call paths in AVA — keep them straight:
//
//   1. getLLM() / getEmbedder() — provider-agnostic, user-swappable.
//      Default = Ollama (bundled with AVA Desktop). Power users can flip
//      to OpenAI/Anthropic/Google in Settings. Read the standard
//      LLM_PROVIDER / EMBED_PROVIDER env vars + their key counterparts.
//
//   2. getDeepResearchClient() — OpenAI-only. The deep-research feature
//      uses OpenAI-specific capabilities (web_search tool, the
//      o4-mini-deep-research-* model family, the Responses API) that no
//      other provider offers. Reads DEEP_RESEARCH_OPENAI_API_KEY (with a
//      fallback to OPENAI_API_KEY for backward compat during migration).
//      If no key is present, deep research is disabled and the caller
//      falls back to the cheap pipeline that runs on the generic LLM.
//
// "Self-service via Agent" plan: the renderer Settings page (and later
// the in-app AI agent) only flips the path-1 vars. Path 2 is an opt-in
// premium feature gated by the user pasting their own OpenAI key.
// Mistral added as the fourth hosted LLM provider (Phase 8.k). It has
// no first-party embedding endpoint we use today, so it's deliberately
// absent from EmbedProvider.
export type LLMProvider =
  | "openai"
  | "anthropic"
  | "google"
  | "mistral"
  | "ollama";
export type EmbedProvider = "openai" | "google" | "ollama";

function requireEnv(name: string): string {
  const value = process.env[name];
  if (!value) {
    throw new Error(`Missing required env var: ${name}`);
  }
  return value;
}

export function getLLM(): LanguageModel {
  const provider = (process.env.LLM_PROVIDER ?? "openai") as LLMProvider;
  const model = process.env.LLM_MODEL;

  switch (provider) {
    case "openai": {
      const client = createOpenAI({
        apiKey: requireEnv("OPENAI_API_KEY"),
        project: process.env.OPENAI_PROJECT_KEY,
        organization: process.env.OPENAI_ORGANIZATION_KEY,
      });
      return client(model ?? "gpt-4o-mini");
    }
    case "anthropic": {
      // v0.1.145 — Anthropic-Subscription-OAuth path for producers.
      // The desktop's ProducerSupervisor forwards the user's
      // subscription token as `ANTHROPIC_AUTH_TOKEN` (Anthropic's
      // documented CI env var) when the active auth mode is
      // "subscription". Falls back to the classic `ANTHROPIC_API_KEY`
      // path when no token is present. See `anthropic-oauth-fetch.ts`
      // for the bearer-injection + Claude-Code system-marker logic
      // shared with the desktop main path.
      const subscriptionToken = process.env.ANTHROPIC_AUTH_TOKEN;
      if (subscriptionToken && subscriptionToken.length > 0) {
        const client = createAnthropic({
          apiKey: "oauth-placeholder",
          headers: { "x-api-key": "" },
          fetch: makeAnthropicOAuthFetch(globalThis.fetch, subscriptionToken),
        });
        return client(model ?? "claude-sonnet-4-6");
      }
      const client = createAnthropic({
        apiKey: requireEnv("ANTHROPIC_API_KEY"),
      });
      return client(model ?? "claude-sonnet-4-6");
    }
    case "google": {
      const client = createGoogleGenerativeAI({
        apiKey: requireEnv("GOOGLE_API_KEY"),
      });
      return client(model ?? "gemini-2.5-pro");
    }
    case "mistral": {
      const client = createMistral({
        apiKey: requireEnv("MISTRAL_API_KEY"),
      });
      return client(model ?? "mistral-large-latest");
    }
    case "ollama": {
      const client = createOllama({
        baseURL: process.env.OLLAMA_URL ?? "http://localhost:11434/api",
      });
      // v0.1.219 — Default = qwen3:8b. Vorher qwen2.5:3b (M1-safe),
      // aber 3B-Modelle scheitern bei AVAs Tool-Call-Häufigkeit zu
      // oft (Halluzination, "<tool_call>"-Text statt echtem Call).
      // 8B braucht 16 GB RAM und ist die Untergrenze, ab der Qwen3
      // den agentischen Use-Case stabil bedient. Wer auf 8 GB RAM
      // bleibt, kommt mit Cloud-Anbietern besser weg — das Onboarding
      // führt aktiv durch diese Wahl. Siehe catalog.ts für die
      // vollständige Modell-Liste.
      return client(model ?? "qwen3:8b");
    }
    default:
      throw new Error(`Unknown LLM_PROVIDER: ${String(provider)}`);
  }
}

/**
 * v0.1.183 — null-safe embedder factory.
 *
 * Returns null when the configured EMBED_PROVIDER can't be instantiated
 * because its key is missing (or, for ollama, when the host is
 * unreachable -- not detected here, deferred to the call site). Consumers
 * MUST treat null as "embeddings unavailable" and degrade gracefully
 * (skip vector search, NACK AMQP messages with a clear reason, etc.).
 *
 * Why this is null-able instead of throwing:
 *   - Anthropic and Mistral have NO embedding models. If the user
 *     picked Anthropic as their LLM provider and no auxiliary
 *     embedder (Google API key, Ollama embeddinggemma) is configured,
 *     the producer should still boot. Pre-v0.1.183 the `requireEnv`
 *     calls below threw at process start, killing the company-
 *     evaluation producer permanently for any user without an OpenAI
 *     key. The website / company-profile / company-contact producers
 *     don't use embeddings at all but they import this same factory
 *     transitively via DI -- so the throw cascaded.
 *
 * Default EMBED_PROVIDER stays "openai" so existing OpenAI-using
 * installs see no behavior change. The producer-supervisor in the
 * desktop-app sets EMBED_PROVIDER explicitly based on the user's
 * configured LLM provider + auxiliary keys (see Phase 2 wiring).
 */
export function getEmbedder(): EmbeddingModel<string> | null {
  const provider = (process.env.EMBED_PROVIDER ?? "openai") as EmbedProvider;
  const model = process.env.EMBED_MODEL;

  switch (provider) {
    case "openai": {
      const apiKey = process.env.OPENAI_API_KEY;
      if (!apiKey || apiKey.length === 0) return null;
      const client = createOpenAI({
        apiKey,
        project: process.env.OPENAI_PROJECT_KEY,
        organization: process.env.OPENAI_ORGANIZATION_KEY,
      });
      return client.textEmbeddingModel(model ?? "text-embedding-3-large");
    }
    case "google": {
      const apiKey = process.env.GOOGLE_API_KEY;
      if (!apiKey || apiKey.length === 0) return null;
      const client = createGoogleGenerativeAI({ apiKey });
      return client.textEmbeddingModel(model ?? "text-embedding-004");
    }
    case "ollama": {
      const client = createOllama({
        baseURL: process.env.OLLAMA_URL ?? "http://localhost:11434/api",
      });
      return client.textEmbeddingModel(model ?? "embeddinggemma");
    }
    default:
      // Unknown provider: log + return null instead of crashing.
      console.warn(
        `[ai-provider] getEmbedder: unknown EMBED_PROVIDER=${String(provider)} -- returning null`,
      );
      return null;
  }
}

// Deep-research client — always OpenAI. Returns null if no key is
// configured, so callers can gate the feature off cleanly rather than
// crashing the whole producer at boot. The key is intentionally a
// separate env var from OPENAI_API_KEY: the generic-LLM path may also
// be set to "openai" with its own key (e.g. a customer who wants
// gpt-4o-mini for everything), and we don't want to conflate billing
// or access boundaries between the two roles.
export type DeepResearchClient = {
  openai: OpenAI;
  scoutModel: string; // for the cheap pipeline (web_search_preview)
  deepModel: string;  // for the expensive fallback (deep-research)
};

// Runtime-config factories (Phase 8.k). Used by the Desktop-App, where
// the user picks a provider in Settings → Agent at runtime instead of
// at process start. Backend services keep using the env-driven
// `getLLM()`/`getEmbedder()` above.
//
// Runtime-config factories (Phase 8.k). Used by the Desktop-App, where
// the user picks a provider in Settings → Agent at runtime instead of
// at process start. Backend services keep using the env-driven
// `getLLM()`/`getEmbedder()` above.
export {
  createLLM,
  createEmbedder,
  type CreateLLMOptions,
  type CreateEmbedderOptions,
  type RuntimeProvider,
} from "./runtime";

// Model catalog (Phase 8.k). The desktop provider picker reads from
// here; backend services can sanity-check user-supplied tags against
// it but don't have to.
export {
  CATALOG,
  listCatalog,
  findCatalogEntry,
  recommendedFor,
  type CatalogEntry,
  type CatalogProvider,
  type ModelRole,
  type ModelCapabilities,
  type ModelTier,
} from "./catalog";

// v0.1.210 — Modell-Preise für den Verbrauchs-Tab (Settings →
// "Verbrauch"). USD-Schätzungen pro 1 Mio. Tokens; Stand siehe
// `pricing.ts`. Tokens sind die harte Größe, USD nur Schätzung.
export {
  PRICING,
  findPricing,
  estimateUsd,
  type ModelPricing,
} from "./pricing";

// ---- Tier-aware persist (v0.1.62) ----------------------------------------
//
// The multi-tenant persist-bus needs to compare "the LLM that produced
// the incoming write" vs "the LLM that produced the existing data" —
// tier-S verdicts shouldn't be overwritten by tier-C just because tier-C
// happens to run later. Producers call `getCurrentTier()` to learn the
// tier of their own active LLM, attach it to persist events; gateway
// reads ContentFreshness to learn the existing tier; comparison logic
// lives in `tierShouldWrite()` below.
//
// See /MODEL_TIERS.md at the repo root for the rubric + classifications.
import { CATALOG, type ModelTier } from "./catalog";

/**
 * Default model id per provider — kept in sync with `getLLM()` above.
 * Surfaced as a constant (rather than duplicated string literals)
 * so `getCurrentModel()` can mirror the same fallback ladder when
 * `LLM_MODEL` is unset, instead of returning `null` and losing the
 * provenance trail for the very common "user runs with defaults" case.
 *
 * Keep entries in sync with the `model ?? "..."` fallbacks in `getLLM()`.
 */
const DEFAULT_LLM_MODEL: Record<string, string> = {
  openai: "gpt-4o-mini",
  anthropic: "claude-sonnet-4-6",
  google: "gemini-2.5-pro",
  mistral: "mistral-large-latest",
  // v0.1.219 — qwen3:8b ersetzt das alte qwen2.5:3b. Siehe Kommentar
  // in getLLM() für die Begründung (3B war für Tool-Calls zu schwach).
  ollama: "qwen3:8b",
};

/**
 * Resolve the (provider, model) tuple of the currently-active LLM.
 * Mirrors `getLLM()`'s env reads + default ladder so producers can
 * stamp persist events with the EXACT model that ran, even when the
 * operator left `LLM_MODEL` unset and got a default.
 *
 * Returns `null` only when `LLM_PROVIDER` is unset (no LLM at all).
 * In that case the producer is a non-LLM stage (Selenium-only) and
 * shouldn't be calling this in the first place.
 */
export function getCurrentModel(): { provider: string; model: string } | null {
  const provider = process.env.LLM_PROVIDER;
  if (!provider) return null;
  const model = process.env.LLM_MODEL ?? DEFAULT_LLM_MODEL[provider];
  if (!model) return null;
  return { provider, model };
}

/**
 * Resolve the tier of the currently-active LLM. Now delegates to
 * `getCurrentModel()` so the default-model case works (was previously
 * returning `null` whenever `LLM_MODEL` was unset, even if the
 * fallback default was catalogued).
 *
 * Returns `null` when:
 *   - `LLM_PROVIDER` is unset
 *   - the resolved model isn't in the catalog
 *
 * Producers treat null as "downgrade-only" — don't overwrite existing
 * data; equivalent to tier 0. The persist-bus enforces this on the
 * write side.
 */
export function getCurrentTier(): ModelTier | null {
  const active = getCurrentModel();
  if (!active) return null;
  return tierForModel(active.provider, active.model);
}

/** Tier lookup for an explicit (provider, model) tuple. Useful when
 *  the caller already knows the model id (e.g. after a default
 *  resolution in getLLM()). Returns null on unknown model. */
export function tierForModel(
  provider: string,
  modelId: string,
): ModelTier | null {
  const entry = CATALOG.find(
    (e) => e.provider === provider && e.id === modelId,
  );
  return entry ? entry.tier : null;
}

/**
 * Vision-capability lookup for an explicit (provider, model) tuple.
 *
 * Used by the LinkedIn-Beobachter image-analysis worker (Phase L4) to
 * decide whether the user's currently-active LLM can ingest images at
 * all. Catalog entries already carry `capabilities.vision`; this helper
 * is just the tier-lookup twin for callers that don't want to import
 * the catalog directly.
 *
 * Returns false when the model is unknown — defensive rather than
 * "let the provider 400 us with an opaque error".
 */
export function hasVision(provider: string, modelId: string): boolean {
  const entry = CATALOG.find(
    (e) => e.provider === provider && e.id === modelId,
  );
  return entry ? entry.capabilities.vision === true : false;
}

/**
 * Persist-bus decision: should the incoming write replace the
 * existing row?
 *
 * Inputs:
 *   incomingTier  — tier of the LLM that produced this write, or
 *                   null for non-LLM stages (structured-content,
 *                   publication, raw SERP)
 *   existingTier  — tier of the LLM that produced the existing row;
 *                   null for non-LLM stages OR if no row exists
 *   existingAgeMs — age of the existing row in ms; pass Infinity
 *                   when no row exists
 *
 * Rules (matching MODEL_TIERS.md):
 *   - No existing row              → WRITE
 *   - Non-LLM stage (both null)    → time-based: write if existing > 30 days
 *   - LLM stage: incoming > existing → WRITE (upgrade)
 *   - LLM stage: incoming = existing → time-based: write if existing > 30 days
 *   - LLM stage: incoming < existing → SKIP (would downgrade)
 *
 * Returns `{ write: boolean, reason: string }` so the caller can log
 * the decision for telemetry.
 */
const THIRTY_DAYS_MS = 30 * 24 * 60 * 60 * 1000;

export function tierShouldWrite(args: {
  incomingTier: ModelTier | null;
  existingTier: ModelTier | null;
  existingAgeMs: number;
}): { write: boolean; reason: string } {
  const { incomingTier, existingTier, existingAgeMs } = args;
  if (existingAgeMs === Infinity) {
    return { write: true, reason: "no existing row" };
  }
  // Non-LLM stage: tier is null on both sides. Time-based.
  if (incomingTier === null && existingTier === null) {
    if (existingAgeMs > THIRTY_DAYS_MS) {
      return { write: true, reason: "non-LLM stage, existing > 30 days" };
    }
    return { write: false, reason: "non-LLM stage, fresh (≤ 30 days)" };
  }
  // Mixed null/non-null is a misconfiguration. Default to "incoming
  // is downgrade-equivalent" — protect existing data.
  if (incomingTier === null) {
    return {
      write: false,
      reason:
        "incoming tier missing (producer misconfigured); refusing to overwrite",
    };
  }
  if (existingTier === null) {
    // Existing row was written by an unconfigured / pre-tier producer.
    // Treat as tier 0 — any tier wins, then 30-day rule kicks in.
    return { write: true, reason: "upgrading from untiered existing row" };
  }
  if (incomingTier > existingTier) {
    return {
      write: true,
      reason: `upgrade: tier ${incomingTier} > ${existingTier}`,
    };
  }
  if (incomingTier < existingTier) {
    return {
      write: false,
      reason: `downgrade refused: tier ${incomingTier} < ${existingTier}`,
    };
  }
  // Same tier — time-based.
  if (existingAgeMs > THIRTY_DAYS_MS) {
    return {
      write: true,
      reason: `same tier (${incomingTier}), existing > 30 days`,
    };
  }
  return {
    write: false,
    reason: `same tier (${incomingTier}), fresh (≤ 30 days)`,
  };
}

export function getDeepResearchClient(): DeepResearchClient | null {
  const apiKey =
    process.env.DEEP_RESEARCH_OPENAI_API_KEY || process.env.OPENAI_API_KEY;
  if (!apiKey) return null;

  return {
    openai: new OpenAI({
      apiKey,
      project:
        process.env.DEEP_RESEARCH_OPENAI_PROJECT_KEY ||
        process.env.OPENAI_PROJECT_KEY,
      organization:
        process.env.DEEP_RESEARCH_OPENAI_ORGANIZATION_KEY ||
        process.env.OPENAI_ORGANIZATION_KEY,
    }),
    scoutModel: process.env.DEEP_RESEARCH_SCOUT_MODEL || "gpt-5-mini",
    deepModel:
      process.env.DEEP_RESEARCH_DEEP_MODEL ||
      "o4-mini-deep-research-2025-06-26",
  };
}

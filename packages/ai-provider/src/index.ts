import OpenAI from "openai";
import { createOpenAI } from "@ai-sdk/openai";
import { createAnthropic } from "@ai-sdk/anthropic";
import { createGoogleGenerativeAI } from "@ai-sdk/google";
import { createMistral } from "@ai-sdk/mistral";
import { createOllama } from "ollama-ai-provider-v2";
import type { EmbeddingModel, LanguageModel } from "ai";

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
      // Default = qwen2.5:3b. Native tool calling, 32K context, ~1.9 GB
      // on disk, ~3 GB resident — fits 8 GB M1 alongside embedder +
      // Electron without OOM-killing the runner. See catalog.ts for the
      // full local model lineup; users with 16+ GB can upgrade to 7B.
      return client(model ?? "qwen2.5:3b");
    }
    default:
      throw new Error(`Unknown LLM_PROVIDER: ${String(provider)}`);
  }
}

export function getEmbedder(): EmbeddingModel<string> {
  const provider = (process.env.EMBED_PROVIDER ?? "openai") as EmbedProvider;
  const model = process.env.EMBED_MODEL;

  switch (provider) {
    case "openai": {
      const client = createOpenAI({
        apiKey: requireEnv("OPENAI_API_KEY"),
        project: process.env.OPENAI_PROJECT_KEY,
        organization: process.env.OPENAI_ORGANIZATION_KEY,
      });
      return client.textEmbeddingModel(model ?? "text-embedding-3-large");
    }
    case "google": {
      const client = createGoogleGenerativeAI({
        apiKey: requireEnv("GOOGLE_API_KEY"),
      });
      return client.textEmbeddingModel(model ?? "text-embedding-004");
    }
    case "ollama": {
      const client = createOllama({
        baseURL: process.env.OLLAMA_URL ?? "http://localhost:11434/api",
      });
      return client.textEmbeddingModel(model ?? "embeddinggemma");
    }
    default:
      throw new Error(`Unknown EMBED_PROVIDER: ${String(provider)}`);
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
} from "./catalog";

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

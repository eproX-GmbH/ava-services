// Model catalog (Phase 8.k).
//
// Single source of truth for "what models can the user pick in the
// Desktop-App provider picker, and what can each one do?"
//
// Why a hand-curated catalog vs. live API queries:
//   - Anthropic exposes no `/v1/models` endpoint at all.
//   - OpenAI's `/v1/models` returns a flat list with no capability metadata
//     (chat-vs-embed, tool support, vision, …) — we'd still need a
//     local mapping table.
//   - Google has `/v1beta/models` with capabilities, but model versioning
//     is messy (gemini-2.5-pro vs -pro-latest vs -pro-002 …).
//   - Ollama's `/api/tags` only lists what's *locally pulled*; the
//     registry has no JSON API.
//
// So: this file is the spine. Provider-side `listInstalled()` calls
// (live API) augment it at runtime with locally-pulled Ollama models or
// newly-released OpenAI ids the user might be ahead of us on. Anything
// the agent needs to *know about* (tool capability, context window,
// embedding-vs-chat) lives here.
//
// Update cadence: review once per quarter, or when a vendor ships a
// model that meaningfully changes the price/perf curve. A follow-up
// (Phase 8.k8) will move this catalog to a fly.io-managed Postgres
// table so all users see the same options without an app redeploy.
//
// IMPORTANT — embeddings are NOT user-switchable. Embeddings written
// by one user are queried by another (RAG, profile similarity in the
// evaluation service), so flipping the embedder per-user would shatter
// vector compatibility. The embed entries below exist only as
// reference/documentation for backend services; the desktop UI never
// renders them. Global default: `embeddinggemma` (local, no external
// dependency, dimensions match what's already on disk).

import type { LLMProvider, EmbedProvider } from "./index";

/** Provider taxonomy used by the catalog. Mistral added in 8.k. */
export type CatalogProvider = LLMProvider | "mistral";

/** Role a model fills. Drives which dropdown the entry appears in. */
export type ModelRole = "llm" | "embed";

export interface ModelCapabilities {
  /** True iff the model honours `tools[]` in chat completions. */
  tools: boolean;
  /** True iff the model accepts image inputs. */
  vision: boolean;
  /**
   * Approximate input context window (tokens). Used to warn when a long
   * conversation is about to overflow. Approximate — vendors update
   * silently and we don't repath every bump.
   */
  contextWindow: number;
  /**
   * For embedding models: vector dimensions. Used for sanity-checks when
   * comparing embeddings across providers. Omit on chat models.
   */
  embeddingDimensions?: number;
}

export interface CatalogEntry {
  provider: CatalogProvider;
  /** Tag/id passed to the AI SDK factory (e.g. "gpt-4o-mini", "llama3.2:3b"). */
  id: string;
  /** Human label rendered in the picker. */
  label: string;
  role: ModelRole;
  capabilities: ModelCapabilities;
  /**
   * Approximate cost class for the agent UI. We deliberately don't
   * publish $/token — vendors change pricing too often. The buckets are
   * stable enough to be useful in a dropdown.
   *  - free   — runs locally (Ollama)
   *  - cheap  — small / fast hosted models
   *  - mid    — flagship "default" hosted models
   *  - high   — large / reasoning / research-tier models
   */
  costClass: "free" | "cheap" | "mid" | "high";
  /** True iff this is the recommended default for the provider+role. */
  recommended?: boolean;
  /** Approximate on-disk size for Ollama models (bytes). UX hint only. */
  approxBytes?: number;
}

// ---- Ollama (local) --------------------------------------------------------
//
// Default = `gemma4:e4b` (Gemma 4 Effective-4B, released April 2026).
// Apache 2.0, native tool/function calling + structured JSON, image +
// audio + document OCR, 128K context. ~9.6 GB on disk, comfortable on
// 16 GB RAM.
//
// Why Gemma 4 over Qwen 2.5 / Llama 3.2:
//   - Tool calling is a first-class feature (we send tools[] on every
//     turn — the 8.b orchestrator depends on this working).
//   - OCR + chart/document parsing is built in. Replaces a separate
//     vision-model hop for the future "import a screenshot of a
//     spreadsheet" agent flow (8.e).
//   - 128K context (E2B/E4B) / 256K (26B/31B) — fits long company
//     dossiers without summary truncation.
//   - Apache 2.0 — no Llama-style "you can't compete with us" clause
//     and no Gemma-specific use restrictions like Gemma 2/3 had.
//
// Hardware sizing (for the 8.k9 hardware-aware picker):
//   - E2B (~7.2 GB): 8 GB RAM laptops, tight.
//   - E4B (~9.6 GB): 16 GB RAM, default — best speed/quality trade-off.
//   - 26B MoE (~18 GB on disk, ~4 B active): 24+ GB unified memory.
//   - 31B dense (~20 GB): 48+ GB or a 24 GB+ GPU.

const OLLAMA_LLM: CatalogEntry[] = [
  {
    provider: "ollama",
    id: "gemma4:e4b",
    label: "Gemma 4 E4B (local, default — multimodal + OCR)",
    role: "llm",
    capabilities: { tools: true, vision: true, contextWindow: 128_000 },
    costClass: "free",
    recommended: true,
    approxBytes: 9_600_000_000,
  },
  {
    provider: "ollama",
    id: "gemma4:e2b",
    label: "Gemma 4 E2B (local, 8 GB RAM)",
    role: "llm",
    capabilities: { tools: true, vision: true, contextWindow: 128_000 },
    costClass: "free",
    approxBytes: 7_200_000_000,
  },
  {
    provider: "ollama",
    id: "gemma4:26b",
    label: "Gemma 4 26B MoE (local, needs ≥24 GB RAM)",
    role: "llm",
    capabilities: { tools: true, vision: true, contextWindow: 256_000 },
    costClass: "free",
    approxBytes: 18_000_000_000,
  },
  {
    provider: "ollama",
    id: "gemma4:31b",
    label: "Gemma 4 31B (local, needs ≥48 GB RAM or GPU)",
    role: "llm",
    capabilities: { tools: true, vision: true, contextWindow: 256_000 },
    costClass: "free",
    approxBytes: 20_000_000_000,
  },
  {
    provider: "ollama",
    id: "llama3.2:3b",
    label: "Llama 3.2 3B (local)",
    role: "llm",
    capabilities: { tools: true, vision: false, contextWindow: 128_000 },
    costClass: "free",
    approxBytes: 2_000_000_000,
  },
  {
    provider: "ollama",
    id: "qwen2.5:3b",
    label: "Qwen 2.5 3B (local)",
    role: "llm",
    capabilities: { tools: true, vision: false, contextWindow: 32_000 },
    costClass: "free",
    approxBytes: 1_900_000_000,
  },
  {
    provider: "ollama",
    id: "qwen2.5:7b",
    label: "Qwen 2.5 7B (local)",
    role: "llm",
    capabilities: { tools: true, vision: false, contextWindow: 32_000 },
    costClass: "free",
    approxBytes: 4_700_000_000,
  },
  {
    provider: "ollama",
    id: "qwen2.5:14b",
    label: "Qwen 2.5 14B (local, needs ≥16GB RAM)",
    role: "llm",
    capabilities: { tools: true, vision: false, contextWindow: 32_000 },
    costClass: "free",
    approxBytes: 9_000_000_000,
  },
  {
    provider: "ollama",
    id: "mistral-nemo:12b",
    label: "Mistral Nemo 12B (local)",
    role: "llm",
    capabilities: { tools: true, vision: false, contextWindow: 128_000 },
    costClass: "free",
    approxBytes: 7_100_000_000,
  },
  {
    provider: "ollama",
    id: "llama3.1:8b",
    label: "Llama 3.1 8B (local)",
    role: "llm",
    capabilities: { tools: true, vision: false, contextWindow: 128_000 },
    costClass: "free",
    approxBytes: 4_700_000_000,
  },
  {
    provider: "ollama",
    id: "gemma3:4b",
    label: "Gemma 3 4B (local, no tool calls)",
    role: "llm",
    // gemma3 famously doesn't honour tools[] — keep it visible but flag
    // so the agent picker can grey it out for tool-using roles.
    capabilities: { tools: false, vision: true, contextWindow: 128_000 },
    costClass: "free",
    approxBytes: 3_300_000_000,
  },
];

const OLLAMA_EMBED: CatalogEntry[] = [
  {
    provider: "ollama",
    id: "embeddinggemma",
    label: "embedding-gemma (local, default)",
    role: "embed",
    capabilities: {
      tools: false,
      vision: false,
      contextWindow: 8_192,
      embeddingDimensions: 768,
    },
    costClass: "free",
    recommended: true,
    approxBytes: 600_000_000,
  },
  {
    provider: "ollama",
    id: "nomic-embed-text",
    label: "Nomic Embed Text (local)",
    role: "embed",
    capabilities: {
      tools: false,
      vision: false,
      contextWindow: 8_192,
      embeddingDimensions: 768,
    },
    costClass: "free",
    approxBytes: 280_000_000,
  },
];

// ---- OpenAI ----------------------------------------------------------------

const OPENAI_LLM: CatalogEntry[] = [
  {
    provider: "openai",
    id: "gpt-4o-mini",
    label: "GPT-4o mini",
    role: "llm",
    capabilities: { tools: true, vision: true, contextWindow: 128_000 },
    costClass: "cheap",
    recommended: true,
  },
  {
    provider: "openai",
    id: "gpt-4o",
    label: "GPT-4o",
    role: "llm",
    capabilities: { tools: true, vision: true, contextWindow: 128_000 },
    costClass: "mid",
  },
  {
    provider: "openai",
    id: "gpt-4.1",
    label: "GPT-4.1",
    role: "llm",
    capabilities: { tools: true, vision: true, contextWindow: 1_000_000 },
    costClass: "mid",
  },
  {
    provider: "openai",
    id: "gpt-4.1-mini",
    label: "GPT-4.1 mini",
    role: "llm",
    capabilities: { tools: true, vision: true, contextWindow: 1_000_000 },
    costClass: "cheap",
  },
  {
    provider: "openai",
    id: "o4-mini",
    label: "o4-mini (reasoning)",
    role: "llm",
    capabilities: { tools: true, vision: true, contextWindow: 200_000 },
    costClass: "mid",
  },
  {
    provider: "openai",
    id: "o3-mini",
    label: "o3-mini (reasoning)",
    role: "llm",
    capabilities: { tools: true, vision: false, contextWindow: 200_000 },
    costClass: "mid",
  },
];

const OPENAI_EMBED: CatalogEntry[] = [
  {
    provider: "openai",
    id: "text-embedding-3-large",
    label: "text-embedding-3-large",
    role: "embed",
    capabilities: {
      tools: false,
      vision: false,
      contextWindow: 8_191,
      embeddingDimensions: 3072,
    },
    costClass: "mid",
    // NOT recommended — global embed default is `embeddinggemma`
    // (local) so all users share a vector space. See header note.
  },
  {
    provider: "openai",
    id: "text-embedding-3-small",
    label: "text-embedding-3-small",
    role: "embed",
    capabilities: {
      tools: false,
      vision: false,
      contextWindow: 8_191,
      embeddingDimensions: 1536,
    },
    costClass: "cheap",
  },
];

// ---- Anthropic -------------------------------------------------------------
//
// Anthropic doesn't ship an embedding model — Voyage AI is the canonical
// pairing but isn't in our @ai-sdk lineup. Anthropic appears in the LLM
// list only.

const ANTHROPIC_LLM: CatalogEntry[] = [
  {
    provider: "anthropic",
    id: "claude-sonnet-4-6",
    label: "Claude Sonnet 4.6",
    role: "llm",
    capabilities: { tools: true, vision: true, contextWindow: 200_000 },
    costClass: "mid",
    recommended: true,
  },
  {
    provider: "anthropic",
    id: "claude-haiku-4-5",
    label: "Claude Haiku 4.5",
    role: "llm",
    capabilities: { tools: true, vision: true, contextWindow: 200_000 },
    costClass: "cheap",
  },
  {
    provider: "anthropic",
    id: "claude-opus-4-1",
    label: "Claude Opus 4.1",
    role: "llm",
    capabilities: { tools: true, vision: true, contextWindow: 200_000 },
    costClass: "high",
  },
];

// ---- Google Gemini ---------------------------------------------------------

const GOOGLE_LLM: CatalogEntry[] = [
  {
    provider: "google",
    id: "gemini-2.5-pro",
    label: "Gemini 2.5 Pro",
    role: "llm",
    capabilities: { tools: true, vision: true, contextWindow: 2_000_000 },
    costClass: "mid",
    recommended: true,
  },
  {
    provider: "google",
    id: "gemini-2.5-flash",
    label: "Gemini 2.5 Flash",
    role: "llm",
    capabilities: { tools: true, vision: true, contextWindow: 1_000_000 },
    costClass: "cheap",
  },
  {
    provider: "google",
    id: "gemini-2.0-flash",
    label: "Gemini 2.0 Flash",
    role: "llm",
    capabilities: { tools: true, vision: true, contextWindow: 1_000_000 },
    costClass: "cheap",
  },
];

const GOOGLE_EMBED: CatalogEntry[] = [
  {
    provider: "google",
    id: "text-embedding-004",
    label: "text-embedding-004",
    role: "embed",
    capabilities: {
      tools: false,
      vision: false,
      contextWindow: 2_048,
      embeddingDimensions: 768,
    },
    costClass: "cheap",
    // NOT recommended — see header note on global embed lock-in.
  },
];

// ---- Mistral ---------------------------------------------------------------

const MISTRAL_LLM: CatalogEntry[] = [
  {
    provider: "mistral",
    id: "mistral-large-latest",
    label: "Mistral Large",
    role: "llm",
    capabilities: { tools: true, vision: false, contextWindow: 128_000 },
    costClass: "mid",
    recommended: true,
  },
  {
    provider: "mistral",
    id: "mistral-small-latest",
    label: "Mistral Small",
    role: "llm",
    capabilities: { tools: true, vision: false, contextWindow: 128_000 },
    costClass: "cheap",
  },
  {
    provider: "mistral",
    id: "ministral-8b-latest",
    label: "Ministral 8B",
    role: "llm",
    capabilities: { tools: true, vision: false, contextWindow: 128_000 },
    costClass: "cheap",
  },
  {
    provider: "mistral",
    id: "pixtral-large-latest",
    label: "Pixtral Large (vision)",
    role: "llm",
    capabilities: { tools: true, vision: true, contextWindow: 128_000 },
    costClass: "mid",
  },
];

// ---- Aggregate -------------------------------------------------------------

/** Full catalog. Order = display order in pickers. */
export const CATALOG: readonly CatalogEntry[] = Object.freeze([
  ...OLLAMA_LLM,
  ...OLLAMA_EMBED,
  ...OPENAI_LLM,
  ...OPENAI_EMBED,
  ...ANTHROPIC_LLM,
  ...GOOGLE_LLM,
  ...GOOGLE_EMBED,
  ...MISTRAL_LLM,
]);

/** Convenience: filter the catalog by role and (optionally) provider. */
export function listCatalog(filter: {
  role: ModelRole;
  provider?: CatalogProvider;
  /** When true, drop entries without `tools: true`. Used by the agent picker. */
  toolsOnly?: boolean;
}): CatalogEntry[] {
  return CATALOG.filter((e) => {
    if (e.role !== filter.role) return false;
    if (filter.provider && e.provider !== filter.provider) return false;
    if (filter.toolsOnly && !e.capabilities.tools) return false;
    return true;
  });
}

/** Look up one entry by provider + id. Returns undefined on miss. */
export function findCatalogEntry(
  provider: CatalogProvider,
  id: string,
): CatalogEntry | undefined {
  return CATALOG.find((e) => e.provider === provider && e.id === id);
}

/**
 * Recommended default model for a provider+role pair. Falls back to the
 * first matching entry if no explicit `recommended: true` is set —
 * defensive against catalog edits that drop the flag.
 */
export function recommendedFor(
  provider: CatalogProvider,
  role: ModelRole,
): CatalogEntry | undefined {
  const candidates = CATALOG.filter(
    (e) => e.provider === provider && e.role === role,
  );
  return candidates.find((e) => e.recommended) ?? candidates[0];
}

// Backward-compat re-export. `EmbedProvider` doesn't currently include
// "mistral" (Mistral has no embedding endpoint we use), but consumers
// reading the catalog may still want to filter embed entries cleanly.
export type { LLMProvider, EmbedProvider };

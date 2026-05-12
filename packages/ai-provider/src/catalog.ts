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

/**
 * Quality tier — drives the multi-tenant persist-bus's "should this
 * write overwrite the existing data?" decision. Higher = better.
 *
 *   4 = "S" — premium / frontier reasoning
 *   3 = "A" — high (last-gen flagships, strong defaults, large local)
 *   2 = "B" — mid (mini / haiku / flash variants, mid-size local)
 *   1 = "C" — small / local-default (≤4 B params, free-tier baseline)
 *
 * REQUIRED on every entry. CI fails if a new entry omits it. See
 * `/MODEL_TIERS.md` at repo root for the full rubric + current
 * classifications. When you add a model, also update that doc.
 *
 * Embedding models still need a tier — set it from the chat model
 * the embedding pairs with. Embeddings don't go through the
 * persist-bus, so the value is informational only, but keeping
 * every entry typed avoids special-cases in the comparison helper.
 */
export type ModelTier = 1 | 2 | 3 | 4;

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
  /**
   * Quality tier for tier-aware persist. See ModelTier above and
   * MODEL_TIERS.md. Required on every entry — TypeScript will reject
   * a new model that omits it.
   */
  tier: ModelTier;
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
    label: "Gemma 4 E4B (local, multimodal + OCR — needs ≥24 GB RAM)",
    role: "llm",
    capabilities: { tools: true, vision: true, contextWindow: 128_000 },
    costClass: "free",
    tier: 2,
    approxBytes: 9_600_000_000,
  },
  {
    provider: "ollama",
    id: "gemma4:e2b",
    label: "Gemma 4 E2B (local, 8 GB RAM)",
    role: "llm",
    capabilities: { tools: true, vision: true, contextWindow: 128_000 },
    costClass: "free",
    tier: 1,
    approxBytes: 7_200_000_000,
  },
  {
    provider: "ollama",
    id: "gemma4:26b",
    label: "Gemma 4 26B MoE (local, needs ≥24 GB RAM)",
    role: "llm",
    capabilities: { tools: true, vision: true, contextWindow: 256_000 },
    costClass: "free",
    tier: 3,
    approxBytes: 18_000_000_000,
  },
  {
    provider: "ollama",
    id: "gemma4:31b",
    label: "Gemma 4 31B (local, needs ≥48 GB RAM or GPU)",
    role: "llm",
    capabilities: { tools: true, vision: true, contextWindow: 256_000 },
    costClass: "free",
    tier: 3,
    approxBytes: 20_000_000_000,
  },
  {
    provider: "ollama",
    id: "llama3.2:3b",
    label: "Llama 3.2 3B (local)",
    role: "llm",
    capabilities: { tools: true, vision: false, contextWindow: 128_000 },
    costClass: "free",
    tier: 1,
    approxBytes: 2_000_000_000,
  },
  {
    provider: "ollama",
    id: "qwen2.5:3b",
    label: "Qwen 2.5 3B (local, default — tool calling, 8 GB RAM)",
    role: "llm",
    capabilities: { tools: true, vision: false, contextWindow: 32_000 },
    costClass: "free",
    tier: 1,
    recommended: true,
    approxBytes: 1_900_000_000,
  },
  {
    provider: "ollama",
    id: "qwen2.5:7b",
    label: "Qwen 2.5 7B (local, tool calling — needs ≥16 GB RAM)",
    role: "llm",
    capabilities: { tools: true, vision: false, contextWindow: 32_000 },
    costClass: "free",
    tier: 2,
    approxBytes: 4_700_000_000,
  },
  {
    provider: "ollama",
    id: "qwen2.5:14b",
    label: "Qwen 2.5 14B (local, needs ≥16GB RAM)",
    role: "llm",
    capabilities: { tools: true, vision: false, contextWindow: 32_000 },
    costClass: "free",
    tier: 3,
    approxBytes: 9_000_000_000,
  },
  {
    provider: "ollama",
    id: "mistral-nemo:12b",
    label: "Mistral Nemo 12B (local)",
    role: "llm",
    capabilities: { tools: true, vision: false, contextWindow: 128_000 },
    costClass: "free",
    tier: 2,
    approxBytes: 7_100_000_000,
  },
  {
    provider: "ollama",
    id: "llama3.1:8b",
    label: "Llama 3.1 8B (local)",
    role: "llm",
    capabilities: { tools: true, vision: false, contextWindow: 128_000 },
    costClass: "free",
    tier: 2,
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
    tier: 1,
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
    tier: 1,
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
    tier: 1,
    approxBytes: 280_000_000,
  },
];

// ---- OpenAI ----------------------------------------------------------------

const OPENAI_LLM: CatalogEntry[] = [
  // GPT-5 family — current generation as of May 2026. We keep
  // `gpt-5.4-mini` as the default recommendation: it follows multi-step
  // tool plans more reliably than 4o-mini and stays cheap. Step up to
  // gpt-5.4 for tricky agent turns, gpt-5.5 / 5.5-pro for analyst-grade
  // reasoning. The 5.5 line is OpenAI's current frontier.
  {
    provider: "openai",
    id: "gpt-5.5-pro",
    label: "GPT-5.5 Pro (frontier)",
    role: "llm",
    capabilities: { tools: true, vision: true, contextWindow: 1_000_000 },
    costClass: "high",
    tier: 4,
  },
  {
    provider: "openai",
    id: "gpt-5.5",
    label: "GPT-5.5",
    role: "llm",
    capabilities: { tools: true, vision: true, contextWindow: 1_000_000 },
    costClass: "mid",
    tier: 4,
  },
  {
    provider: "openai",
    id: "gpt-5.4-pro",
    label: "GPT-5.4 Pro",
    role: "llm",
    capabilities: { tools: true, vision: true, contextWindow: 1_000_000 },
    costClass: "high",
    tier: 4,
  },
  {
    provider: "openai",
    id: "gpt-5.4",
    label: "GPT-5.4",
    role: "llm",
    capabilities: { tools: true, vision: true, contextWindow: 1_000_000 },
    costClass: "mid",
    tier: 4,
  },
  {
    provider: "openai",
    id: "gpt-5.4-mini",
    label: "GPT-5.4 mini",
    role: "llm",
    capabilities: { tools: true, vision: true, contextWindow: 400_000 },
    costClass: "cheap",
    tier: 2,
    recommended: true,
  },
  {
    provider: "openai",
    id: "gpt-5.4-nano",
    label: "GPT-5.4 nano",
    role: "llm",
    capabilities: { tools: true, vision: true, contextWindow: 400_000 },
    costClass: "cheap",
    tier: 1,
  },
  {
    provider: "openai",
    id: "gpt-5-pro",
    label: "GPT-5 Pro",
    role: "llm",
    capabilities: { tools: true, vision: true, contextWindow: 400_000 },
    costClass: "high",
    tier: 4,
  },
  {
    provider: "openai",
    id: "gpt-5",
    label: "GPT-5",
    role: "llm",
    capabilities: { tools: true, vision: true, contextWindow: 400_000 },
    costClass: "mid",
    tier: 4,
  },
  {
    provider: "openai",
    id: "gpt-5-mini",
    label: "GPT-5 mini",
    role: "llm",
    capabilities: { tools: true, vision: true, contextWindow: 400_000 },
    costClass: "cheap",
    tier: 2,
  },
  {
    provider: "openai",
    id: "gpt-5-nano",
    label: "GPT-5 nano",
    role: "llm",
    capabilities: { tools: true, vision: true, contextWindow: 400_000 },
    costClass: "cheap",
    tier: 1,
  },
  // GPT-4 family — kept for users with prior keys/quotas pinned to it.
  {
    provider: "openai",
    id: "gpt-4.1",
    label: "GPT-4.1",
    role: "llm",
    capabilities: { tools: true, vision: true, contextWindow: 1_000_000 },
    costClass: "mid",
    tier: 3,
  },
  {
    provider: "openai",
    id: "gpt-4.1-mini",
    label: "GPT-4.1 mini",
    role: "llm",
    capabilities: { tools: true, vision: true, contextWindow: 1_000_000 },
    costClass: "cheap",
    tier: 2,
  },
  {
    provider: "openai",
    id: "gpt-4.1-nano",
    label: "GPT-4.1 nano",
    role: "llm",
    capabilities: { tools: true, vision: true, contextWindow: 1_000_000 },
    costClass: "cheap",
    tier: 1,
  },
  {
    provider: "openai",
    id: "gpt-4o",
    label: "GPT-4o",
    role: "llm",
    capabilities: { tools: true, vision: true, contextWindow: 128_000 },
    costClass: "mid",
    tier: 3,
  },
  {
    provider: "openai",
    id: "gpt-4o-mini",
    label: "GPT-4o mini",
    role: "llm",
    capabilities: { tools: true, vision: true, contextWindow: 128_000 },
    costClass: "cheap",
    tier: 2,
  },
  // Reasoning-tuned models — pricier but stronger on multi-step plans.
  {
    provider: "openai",
    id: "o3",
    label: "o3 (reasoning)",
    role: "llm",
    capabilities: { tools: true, vision: false, contextWindow: 200_000 },
    costClass: "high",
    tier: 4,
  },
  {
    provider: "openai",
    id: "o4-mini",
    label: "o4-mini (reasoning)",
    role: "llm",
    capabilities: { tools: true, vision: true, contextWindow: 200_000 },
    costClass: "mid",
    tier: 3,
  },
  {
    provider: "openai",
    id: "o3-mini",
    label: "o3-mini (reasoning)",
    role: "llm",
    capabilities: { tools: true, vision: false, contextWindow: 200_000 },
    costClass: "mid",
    tier: 3,
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
    tier: 3,
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
    tier: 2,
  },
];

// ---- Anthropic -------------------------------------------------------------
//
// Anthropic doesn't ship an embedding model — Voyage AI is the canonical
// pairing but isn't in our @ai-sdk lineup. Anthropic appears in the LLM
// list only.

// Anthropic frontier as of May 2026: Opus 4.7 is the most capable
// generally-available model, with a step-change in agentic coding
// over Opus 4.6. Sonnet 4.6 stays our cost-balanced default
// (`recommended`) because Opus pricing is 5x Sonnet ($5/$25 vs $3/$15
// per MTok) and Sonnet covers most agentic workloads here. Users on
// research-grade tasks switch to Opus 4.7 explicitly.
//
// Context windows: 4.6+ models ship with a 1M-token window
// (previously 200k on Sonnet 4.5 / Opus 4.5). Haiku 4.5 stays at 200k.
//
// Order = display order in the picker. Current models first, then
// the legacy ladder (still callable; some users have keys pinned).
const ANTHROPIC_LLM: CatalogEntry[] = [
  {
    provider: "anthropic",
    id: "claude-opus-4-7",
    label: "Claude Opus 4.7 (frontier)",
    role: "llm",
    capabilities: { tools: true, vision: true, contextWindow: 1_000_000 },
    costClass: "high",
    tier: 4,
  },
  {
    provider: "anthropic",
    id: "claude-sonnet-4-6",
    label: "Claude Sonnet 4.6",
    role: "llm",
    capabilities: { tools: true, vision: true, contextWindow: 1_000_000 },
    costClass: "mid",
    tier: 3,
    recommended: true,
  },
  {
    provider: "anthropic",
    id: "claude-haiku-4-5",
    label: "Claude Haiku 4.5",
    role: "llm",
    capabilities: { tools: true, vision: true, contextWindow: 200_000 },
    costClass: "cheap",
    tier: 2,
  },
  // Legacy frontier — still listed by Anthropic, still callable.
  // Keep them so users with provisioned-throughput pinning don't lose
  // their model when we ship a release.
  {
    provider: "anthropic",
    id: "claude-opus-4-6",
    label: "Claude Opus 4.6 (legacy)",
    role: "llm",
    capabilities: { tools: true, vision: true, contextWindow: 1_000_000 },
    costClass: "high",
    tier: 4,
  },
  {
    provider: "anthropic",
    id: "claude-sonnet-4-5",
    label: "Claude Sonnet 4.5 (legacy)",
    role: "llm",
    capabilities: { tools: true, vision: true, contextWindow: 200_000 },
    costClass: "mid",
    tier: 3,
  },
  {
    provider: "anthropic",
    id: "claude-opus-4-5",
    label: "Claude Opus 4.5 (legacy)",
    role: "llm",
    capabilities: { tools: true, vision: true, contextWindow: 200_000 },
    costClass: "high",
    tier: 4,
  },
  {
    provider: "anthropic",
    id: "claude-opus-4-1",
    label: "Claude Opus 4.1 (legacy)",
    role: "llm",
    capabilities: { tools: true, vision: true, contextWindow: 200_000 },
    costClass: "high",
    tier: 4,
  },
];

// ---- Google Gemini ---------------------------------------------------------

// Gemini 3.x is Google's current frontier (May 2026). Pro variants
// are still preview-tagged in the API — we ship them as selectable
// but DO NOT recommend a preview model as the default. 2.5 Pro stays
// `recommended` because it's the stable flagship with the highest
// real-world reliability for German extraction tasks. Users who want
// the bleeding-edge can flip to a 3.x preview from the picker.
const GOOGLE_LLM: CatalogEntry[] = [
  {
    provider: "google",
    id: "gemini-3.1-pro-preview",
    label: "Gemini 3.1 Pro (preview, frontier)",
    role: "llm",
    capabilities: { tools: true, vision: true, contextWindow: 1_000_000 },
    costClass: "high",
    tier: 4,
  },
  {
    provider: "google",
    id: "gemini-3-pro-preview",
    label: "Gemini 3 Pro (preview)",
    role: "llm",
    capabilities: { tools: true, vision: true, contextWindow: 1_000_000 },
    costClass: "high",
    tier: 4,
  },
  {
    provider: "google",
    id: "gemini-3-flash-preview",
    label: "Gemini 3 Flash (preview)",
    role: "llm",
    capabilities: { tools: true, vision: true, contextWindow: 1_000_000 },
    costClass: "mid",
    tier: 3,
  },
  {
    provider: "google",
    id: "gemini-3.1-flash-lite",
    label: "Gemini 3.1 Flash-Lite",
    role: "llm",
    capabilities: { tools: true, vision: true, contextWindow: 1_000_000 },
    costClass: "cheap",
    tier: 2,
  },
  {
    provider: "google",
    id: "gemini-2.5-pro",
    label: "Gemini 2.5 Pro",
    role: "llm",
    capabilities: { tools: true, vision: true, contextWindow: 2_000_000 },
    costClass: "mid",
    tier: 4,
    recommended: true,
  },
  {
    provider: "google",
    id: "gemini-2.5-flash",
    label: "Gemini 2.5 Flash",
    role: "llm",
    capabilities: { tools: true, vision: true, contextWindow: 1_000_000 },
    costClass: "cheap",
    tier: 3,
  },
  {
    provider: "google",
    id: "gemini-2.5-flash-lite",
    label: "Gemini 2.5 Flash-Lite",
    role: "llm",
    capabilities: { tools: true, vision: true, contextWindow: 1_000_000 },
    costClass: "cheap",
    tier: 2,
  },
  {
    provider: "google",
    id: "gemini-2.0-flash",
    label: "Gemini 2.0 Flash (legacy)",
    role: "llm",
    capabilities: { tools: true, vision: true, contextWindow: 1_000_000 },
    costClass: "cheap",
    tier: 2,
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
    tier: 2,
    // NOT recommended — see header note on global embed lock-in.
  },
];

// ---- Mistral ---------------------------------------------------------------

// Mistral 2026 generation: Large 3 is the flagship open-weight
// general-purpose model; Medium 3.5 is the frontier multimodal
// optimized for agentic + coding; Small 4 is a hybrid instruct +
// reasoning model. All three got native vision in this generation
// (previously only Pixtral). Context windows expanded to 262k.
const MISTRAL_LLM: CatalogEntry[] = [
  {
    provider: "mistral",
    id: "mistral-large-latest",
    label: "Mistral Large 3",
    role: "llm",
    capabilities: { tools: true, vision: true, contextWindow: 262_000 },
    costClass: "mid",
    tier: 3,
    recommended: true,
  },
  {
    provider: "mistral",
    id: "mistral-medium-latest",
    label: "Mistral Medium 3.5 (frontier multimodal)",
    role: "llm",
    capabilities: { tools: true, vision: true, contextWindow: 262_000 },
    costClass: "mid",
    tier: 3,
  },
  {
    provider: "mistral",
    id: "mistral-small-latest",
    label: "Mistral Small 4",
    role: "llm",
    capabilities: { tools: true, vision: true, contextWindow: 262_000 },
    costClass: "cheap",
    tier: 2,
  },
  {
    provider: "mistral",
    id: "ministral-8b-latest",
    label: "Ministral 3 8B",
    role: "llm",
    capabilities: { tools: true, vision: true, contextWindow: 262_000 },
    costClass: "cheap",
    tier: 1,
  },
  {
    provider: "mistral",
    id: "ministral-3b-latest",
    label: "Ministral 3 3B",
    role: "llm",
    capabilities: { tools: true, vision: true, contextWindow: 262_000 },
    costClass: "cheap",
    tier: 1,
  },
  {
    provider: "mistral",
    id: "pixtral-large-latest",
    label: "Pixtral Large (legacy vision)",
    role: "llm",
    capabilities: { tools: true, vision: true, contextWindow: 128_000 },
    costClass: "mid",
    tier: 3,
  },
  // Code specialists. Useful for the agent's code-writing turns
  // (e.g. xlsx-transformation snippets) and for users who want to
  // route those specifically.
  {
    provider: "mistral",
    id: "codestral-latest",
    label: "Codestral (code completion)",
    role: "llm",
    capabilities: { tools: true, vision: false, contextWindow: 262_000 },
    costClass: "cheap",
    tier: 2,
  },
  {
    provider: "mistral",
    id: "devstral-medium-latest",
    label: "Devstral 2 (frontier code agent)",
    role: "llm",
    capabilities: { tools: true, vision: false, contextWindow: 262_000 },
    costClass: "mid",
    tier: 3,
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

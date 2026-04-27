import type { OllamaModelSpec, OllamaInstalledModel } from "../shared/types";

// Ollama model catalog (D7 + D8).
//
// Hard-coded for the desktop default profile. The cloud-only build (legacy
// QUIKK-style OpenAI fallback) doesn't run the supervisor at all and never
// reads this list.
//
// Tags must match what's pullable from `ollama.com` exactly — the supervisor
// passes them straight through to `/api/pull`. Sizes are approximate (taken
// from the published manifests at time of writing) and are only used for
// UI progress hints when the live `total` field isn't on a frame yet.
//
// Bumping a model: change the tag here AND the README's "First-run download"
// note. Do NOT delete the old tag from disk — the supervisor lazily ignores
// installed-but-not-required models, and users may roll back. Old tags get
// pruned by a future "Free space" UI, not silently.

// LLM choice: `qwen2.5:7b` over `gemma3:4b`.
//
// Why: the 8.b agent loop sends `tools[]` on every /api/chat call. gemma3
// has a known Ollama runner crash on Apple Silicon when tool schemas are
// attached (issue surfaces as
// `llama runner process has terminated: %!w(<nil>)` — Go's empty-error
// fallthrough on a segfaulting child). qwen2.5 has battle-tested tool
// support across Ollama versions and runs cleanly on M-series hardware.
//
// Footprint: ~4.7GB on disk, ~5–6GB resident at inference. Safe headroom
// on 16GB M1; tight on 8GB. If you need to fit 8GB, swap to `qwen2.5:3b`
// (≈2GB) — tool calling still works, just less coherent on long chains.
export const REQUIRED_MODELS: OllamaModelSpec[] = [
  {
    name: "qwen2.5:7b",
    role: "llm",
    approxBytes: 4_700_000_000,
  },
  {
    name: "embeddinggemma:latest",
    role: "embed",
    approxBytes: 600_000_000,
  },
];

/**
 * Models in `REQUIRED_MODELS` that aren't present in `installed`.
 *
 * Matching is exact on `name` — Ollama returns the full tag (`gemma3:4b`,
 * not `gemma3`), so any user-side rename to a different tag will register
 * as missing. That's deliberate: the AVA pipeline is pinned to specific
 * weights and routing on a homonym is worse than re-downloading.
 */
export function missingModels(
  installed: OllamaInstalledModel[],
): OllamaModelSpec[] {
  const have = new Set(installed.map((m) => m.name));
  return REQUIRED_MODELS.filter((m) => !have.has(m.name));
}

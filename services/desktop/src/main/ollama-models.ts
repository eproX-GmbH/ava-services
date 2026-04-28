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

// LLM choice: `gemma4:e4b` (Gemma 4 Effective-4B, April 2026 release).
//
// Why Gemma 4 E4B over the previous default (qwen2.5:7b):
//   - Native tool/function calling — first-class feature, not a
//     fine-tune retrofit. The 8.b orchestrator sends tools[] on every
//     /api/chat turn; Gemma 3 crashed Ollama's runner on Apple Silicon
//     when tool schemas were attached, Gemma 4 fixed that and made
//     tools a headline capability.
//   - Built-in OCR + chart/handwriting/document parsing. Replaces a
//     separate vision-model hop for screenshot/PDF ingest flows (8.e).
//   - 128K context vs Qwen 2.5's 32K — fits long company dossiers.
//   - 4.5B effective params (Per-Layer Embeddings architecture) at
//     ~9.6 GB on disk. ~10–11 GB resident at inference; comfortable on
//     16 GB unified-memory laptops.
//
// Hardware sizing — see catalog.ts in @ava/ai-provider. Users with
// 8 GB should switch to `gemma4:e2b` (~7.2 GB); 24+ GB users can pick
// `gemma4:26b` MoE (4 B active) for better quality at similar speed.
// The 8.k9 follow-on adds an automatic recommendation based on
// os.totalmem() — until then this list is the one-size default that
// works for the most common laptop profile (16 GB).
export const REQUIRED_MODELS: OllamaModelSpec[] = [
  {
    name: "gemma4:e4b",
    role: "llm",
    approxBytes: 9_600_000_000,
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

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

// LLM choice: `qwen2.5:3b` (Qwen 2.5 3B Instruct, ~1.9 GB on disk).
//
// Why Qwen 2.5 3B as the universal default (downgraded from 7B in
// 8.k10g after M1 OOM reports):
//   - Resource fit. The 7B variant is ~4.7 GB on disk and pushes
//     ~6 GB resident with tools[]. On 8 GB M1 / M2 MacBook Air machines
//     — the most common dev hardware — that crosses the OS swap
//     threshold and the runner gets killed mid-generation
//     ("llama runner process has terminated"). 3B is ~1.9 GB on disk,
//     ~3 GB resident, comfortably fits 8 GB unified memory alongside
//     embedder + Electron.
//   - Native tool/function calling — same first-class Qwen 2.5
//     family that the orchestrator targets, just smaller weights.
//     Quality is meaningfully lower than 7B for multi-step plans
//     but the alternative is a crashing app, which is the worse UX.
//   - 32K context — unchanged from the 7B variant.
//
// Users with 16+ GB should manually upgrade to `qwen2.5:7b` from the
// model picker (8.g Settings → Agent) or the 8.k9 hardware-aware
// recommendation (planned) for visibly better answers. Users with
// 24+ GB can pick `qwen2.5:14b` or `gemma4:e4b`. Users who want
// headline quality without local cost flip to a hosted provider via
// the FirstRunWizard skip flow.
//
// Hardware sizing — see catalog.ts in @ava/ai-provider.
export const REQUIRED_MODELS: OllamaModelSpec[] = [
  {
    name: "qwen2.5:3b",
    role: "llm",
    approxBytes: 1_900_000_000,
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
 * Matching has two distinct rules per role:
 *
 *  - `embed` — exact match on the canonical tag, after stripping any
 *    registry prefix and normalising the missing-tag-as-`:latest` case.
 *    The vector space is determined by the embedder's exact weights, so
 *    "any embedder" doesn't fit; we lock to `embeddinggemma:latest` and
 *    reject substitutes (see catalog.ts header for the lock-in
 *    rationale).
 *
 *  - `llm` — *any* tool-capable local LLM satisfies the requirement.
 *    Once a user has one usable chat model on disk we don't drag them
 *    through another multi-GB pull just because we shipped a new
 *    default. The recommended tag (currently `qwen2.5:7b`) is what we'd
 *    auto-pull on a fresh machine, but a user who already has e.g.
 *    `gemma4:e4b` or `llama3.2:3b` from a prior version is considered
 *    satisfied.
 *
 * Why both: without role-aware matching, a user with Gemma 4 on disk
 * gets re-prompted to download Qwen the moment we change the default,
 * which is the exact UX bug we're fixing here.
 */
export function missingModels(
  installed: OllamaInstalledModel[],
): OllamaModelSpec[] {
  const haveTags = new Set(installed.map((m) => normaliseTag(m.name)));
  const haveAnyLlm = installed.some((m) => looksLikeToolCapableLlm(m.name));
  return REQUIRED_MODELS.filter((m) => {
    if (m.role === "llm") {
      // Satisfied by ANY known tool-capable LLM the user already has.
      // The recommended tag is only what we'd pull from scratch.
      if (haveAnyLlm) return false;
      return !haveTags.has(normaliseTag(m.name));
    }
    // Embedding (and any other role): exact-match required.
    return !haveTags.has(normaliseTag(m.name));
  });
}

function normaliseTag(name: string): string {
  // Strip any registry/path prefix — keep only the final segment.
  const lastSlash = name.lastIndexOf("/");
  const tail = lastSlash >= 0 ? name.slice(lastSlash + 1) : name;
  // Default tag is `latest` when omitted.
  return tail.includes(":") ? tail : `${tail}:latest`;
}

/**
 * Heuristic: is this installed-model tag one of the LLM families we
 * know supports tool calling in Ollama? Kept as a regex rather than a
 * hard-coded tag list because the catalog evolves and we don't want a
 * stale enum here to cause false-negatives ("you don't have an LLM!"
 * when the user clearly does).
 *
 * False positives are bounded — at worst we'd accept a non-tool-capable
 * model and the agent would fail at its first tool call with a clear
 * error message, which the user can recover from in Whoami by picking
 * a different model. False negatives are the bug we just fixed (forced
 * re-download), so this leans permissive.
 */
function looksLikeToolCapableLlm(name: string): boolean {
  const tag = normaliseTag(name).toLowerCase();
  // Skip the embedder so a user with only embeddinggemma installed
  // doesn't accidentally satisfy the LLM requirement.
  if (tag.startsWith("embedding")) return false;
  return /^(qwen|gemma|llama|mistral|phi|deepseek|granite|command-r)/i.test(tag);
}

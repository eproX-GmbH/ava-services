import type { LoadedSkill } from "../skills";
import type { OllamaToolSpec } from "./types";
import type { ToolRegistry } from "./tool-registry";

// Tool selection for a given chat turn.
//
// Background (v0.1.186):
// Until v0.1.185 we shipped EVERY registered tool's JSON-Schema with
// every API request — roughly 12k tokens of tool descriptors per turn,
// regardless of whether the conversation was about company research
// or about settings. After enabling Anthropic prompt-caching that cost
// becomes mostly amortised, but it still bloats the first turn, every
// cache miss, and the Tier-1 rate-limit budget.
//
// Skills already declare what they need via the `allowed-tools`
// frontmatter — until now that list was only used as a hard-refusal
// gate at execution time. We now also use it to PRE-FILTER the tool
// list we send to the model: an active skill's request never carries
// tool schemas that the skill couldn't even invoke.
//
// For plain chat without an active skill, we use a curated
// "research default" set covering the everyday surface (company
// lookups, profile, memory, basic UI, transaction status). Infra
// tools — Ollama-runtime management, voice setup, updater, CRM
// connect / disconnect, raw LinkedIn scrape control, producer
// log tails — are excluded by default. They're still callable
// via the slash palette (`/tool_name`), which forces the named
// tool into the turn's selection regardless of the default.

/**
 * Tools always visible in chat, regardless of skill.
 *
 * Picked for the "I asked AVA about a company" use case: company
 * research, evaluations, profile, memory, transaction status, and
 * the minimal UI shims (`ask_user_*`, `navigate`, `notify`). CRM
 * READS stay in (so the agent can answer "what's in HubSpot for
 * Foo GmbH"); CRM management (connect / disconnect / link /
 * enrich) is left to the Settings UI.
 *
 * If you add a new tool that the agent should be able to reach
 * from a normal chat turn, add it here. If it's an infra/management
 * tool the user triggers from a UI button, leave it out — the
 * slash palette still surfaces it on demand.
 */
const DEFAULT_RESEARCH_TOOLS: ReadonlySet<string> = new Set<string>([
  // Companies (core research surface)
  "company_search",
  "company_get",
  "company_profile",
  "company_keywords",
  "company_publications",
  "company_contacts",
  "company_data_quality",
  "company_structured_content",
  "company_linkedin_signals",
  "company_website",
  "company_crm_summary",
  // Evaluations
  "evaluation_best_match_get",
  "evaluation_best_matches_list",
  "evaluation_comparison_get",
  "evaluation_offer_analysis",
  "evaluation_start_best_match",
  // Transactions (status answers)
  "transaction_get",
  "transaction_entities",
  "transaction_errors",
  "transaction_pipeline",
  "transactions_list",
  "retry_stage",
  // CRM reads
  "crm_status",
  "crm_list_links_for_company",
  // UI shims
  "ask_user_choice",
  "ask_user_text",
  "navigate",
  "notify",
  // Memory + profile
  "recall_memory",
  "remember",
  "forget_memory",
  "profile_get",
  "profile_set",
  "profile_propose_update",
  "profile_clear",
  // Chat history (the agent uses this for "what did we talk about")
  "chat_history_list",
  "chat_history_load",
  // Alerts read + dismiss (write-bell interactions)
  "alerts_list",
  "alerts_dismiss",
  "alerts_dismiss_all",
  // Watches read
  "watch_list",
]);

/**
 * Compute which tools to send to the LLM for the current turn.
 *
 * Order of precedence:
 *   1. Active skill → only that skill's `allowedTools`.
 *   2. No skill → `DEFAULT_RESEARCH_TOOLS`.
 * In BOTH cases, `extraToolNames` (e.g. a tool nudged via slash
 * palette) is force-added so the user can always reach a specific
 * tool by typing `/name`.
 *
 * If the resulting set ends up empty (skill with no allowed-tools
 * and no extras), we send `undefined` to the provider so it
 * doesn't see a zero-length tools array (some providers treat
 * `tools: []` differently from omitted `tools`).
 */
export function selectToolsForTurn(opts: {
  registry: ToolRegistry;
  activeSkill: LoadedSkill | null;
  extraToolNames?: ReadonlyArray<string>;
}): OllamaToolSpec[] | undefined {
  const { registry, activeSkill, extraToolNames } = opts;

  const allowed = new Set<string>();
  if (activeSkill) {
    for (const name of activeSkill.allowedTools) allowed.add(name);
  } else {
    for (const name of DEFAULT_RESEARCH_TOOLS) allowed.add(name);
  }
  if (extraToolNames) {
    for (const name of extraToolNames) allowed.add(name);
  }

  const all = registry.toOllamaTools();
  const filtered = all.filter((t) => allowed.has(t.function.name));
  return filtered.length > 0 ? filtered : undefined;
}

/** Exposed for tests / diagnostics. Don't mutate. */
export const DEFAULT_RESEARCH_TOOL_NAMES: ReadonlySet<string> =
  DEFAULT_RESEARCH_TOOLS;

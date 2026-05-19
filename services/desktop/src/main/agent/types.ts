// Internal agent types. Distinct from `shared/types.ts` (IPC boundary) — these
// stay inside the main process.
//
// 8.a only uses `Tool` and `ToolRegistry` as a stub. The real registry lands
// in 8.b, but defining the surface now means orchestrator + prompt builder
// don't need to be rewritten then.

import type { AgentMessage } from "../../shared/types";

/**
 * Ollama /api/chat tool descriptor (a JSON-Schema function spec). The
 * registry materialises one of these per registered tool when the
 * orchestrator builds its `tools` request body.
 */
export interface OllamaToolSpec {
  type: "function";
  function: {
    name: string;
    description: string;
    parameters: Record<string, unknown>;
  };
}

/**
 * A single registered tool. Args validation runs in `parseArgs` (yup or
 * zod, picked per-tool — defer to 8.b). For 8.a the registry is empty so
 * this interface is documentation only.
 */
export interface Tool<TArgs = unknown, TResult = unknown> {
  name: string;
  description: string;
  /**
   * Optional one-line teaser (≤ ~30 tokens) used by the `tool_search`
   * meta-tool. If unset, the tool-selector falls back to the first
   * sentence of `description`. Keep it crisp — this is what the model
   * sees when deciding "is this tool worth loading?"
   */
  summary?: string;
  /**
   * Optional bucket-tag for grouping (`notion`, `crm`, `voice`, …).
   * `tool_search` surfaces it next to the name so the model can
   * cluster related tools and decide whether to load a category-batch.
   */
  category?: string;
  /** JSON Schema, surfaced to the model via /api/chat `tools[]`. */
  parameters: Record<string, unknown>;
  /** Throw on invalid args; orchestrator catches and emits an error frame. */
  parseArgs(raw: unknown): TArgs;
  run(args: TArgs, ctx: ToolContext): Promise<TResult>;
  /** Short, model-readable preview used in tool-result frames. */
  preview(result: TResult): string;
}

export interface ToolContext {
  /** Cancels mid-tool when the orchestrator aborts a request. */
  signal: AbortSignal;
  /** Lets a tool emit out-of-band telemetry. */
  log: (msg: string) => void;
  /** Per-request UI roundtrip surface (askChoice / navigate / notify). */
  ui: import("./ui-bridge").UiBridge;
}

/**
 * In-memory orchestrator slot. One per active conversation. 8.a stores the
 * full message log here; 8.d will swap this for a markdown-on-disk store.
 */
export interface Conversation {
  id: string;
  messages: AgentMessage[];
  /**
   * Lazy-Tool-Loading (v0.1.240):
   *
   * Conversations start with only a tiny always-on core of tools
   * (tool_search, tool_load, skill_search/get, ask_user_*). Anything
   * else the agent needs has to be discovered via `tool_search` and
   * pulled in via `tool_load`. Those tool-names accumulate in this
   * set and stay loaded for the rest of the conversation — saves
   * the agent from re-searching for the same tools mid-flow.
   *
   * Skills automatically add their `allowed-tools` here on
   * activation, so a skill that promises to update Notion has the
   * Notion tools available without a separate tool_load round-trip.
   */
  loadedToolNames?: Set<string>;
}

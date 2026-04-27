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
}

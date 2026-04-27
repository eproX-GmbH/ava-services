import type { AgentMessage } from "../../../shared/types";
import type { OllamaToolSpec } from "../types";

// LlmProvider abstraction (Phase 8.j).
//
// The orchestrator was originally hard-wired to the Ollama HTTP shape
// (see ../ollama-client.ts). Adding OpenAI as a peer provider means the
// streaming + tool-calling surface needs a single interface that both
// implementations satisfy.
//
// Design notes:
//   - The frame shape is intentionally identical to OllamaChatStreamFrame
//     so the orchestrator's reduce loop is provider-agnostic. Each
//     implementation adapts its native protocol (Ollama NDJSON, OpenAI
//     SSE) into this shape.
//   - tool_calls are passed back whole (not streamed token-by-token)
//     because that's what Ollama emits and OpenAI's `tool_calls` deltas
//     are easy to coalesce in the adapter without leaking complexity up.
//   - `ready()` is a synchronous probe used by AgentStatus — the
//     orchestrator gates `send()` on it. Slow checks (network round-trip)
//     belong in `prefetch()` instead, which the supervisor calls during
//     boot.

export type LlmProviderKind = "ollama" | "openai";

export interface LlmStreamRequest {
  messages: AgentMessage[];
  tools?: OllamaToolSpec[];
  signal: AbortSignal;
}

export interface LlmStreamToolCall {
  id?: string;
  function: {
    name: string;
    arguments: Record<string, unknown> | string;
  };
}

export interface LlmStreamFrame {
  contentDelta?: string;
  toolCalls?: LlmStreamToolCall[];
  done: boolean;
  errorMessage?: string;
}

/**
 * What the orchestrator and renderer need to know about the active
 * provider. Mirrors `AgentStatus` partially — the orchestrator merges
 * this into its own status snapshot.
 */
export interface LlmProviderStatus {
  kind: LlmProviderKind;
  /** Tag/model name passed to the provider (e.g. "qwen2.5:7b", "gpt-4o-mini"). */
  model: string | null;
  /** True iff a `streamChat` call would start without throwing. */
  ready: boolean;
  /** Surfaces config errors (missing key, ollama down, …). */
  errorMessage: string | null;
}

export interface LlmProvider {
  readonly kind: LlmProviderKind;
  /** Snapshot — must be cheap, no I/O. */
  getStatus(): LlmProviderStatus;
  /** Subscribe to status transitions. Used by orchestrator → renderer fan-out. */
  onStatusChanged(listener: (s: LlmProviderStatus) => void): () => void;
  /**
   * Async-iterable streaming chat. The orchestrator drives the ReAct loop
   * over this generator — implementations MUST yield `done:true` exactly
   * once before returning.
   */
  streamChat(req: LlmStreamRequest): AsyncGenerator<LlmStreamFrame, void, void>;
  /** Optional teardown hook. */
  dispose?(): void;
}

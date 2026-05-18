import type { AgentMessage, LlmProviderKind } from "../../../shared/types";
import type { OllamaToolSpec } from "../types";

// LlmProvider abstraction.
//
// Originally introduced in 8.j to seam Ollama vs. OpenAI. In 8.k1 the
// implementation moved behind Vercel AI SDK (via `@ava/ai-provider`),
// so a single `AiSdkProvider` now satisfies this interface for all five
// supported kinds. The interface itself stayed stable on purpose — the
// orchestrator's ReAct loop is identical regardless of vendor.
//
// Frame shape: each yielded `LlmStreamFrame` is a *delta*. Tool calls
// arrive whole on the final frame (we coalesce streamed argument
// fragments inside the adapter so the orchestrator never sees partials).

export type { LlmProviderKind };

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

/**
 * v0.1.210 — Token-Usage-Snapshot eines fertigen LLM-Turns.
 *
 * Vom Provider auf der `done`-Frame emittiert. Orchestrator harvested
 * den Wert und schreibt ihn in den UsageStore (Settings → Verbrauch).
 *
 * Alle Felder optional, weil unterschiedliche Provider unterschiedlich
 * viel preisgeben:
 *   - Anthropic: alle Felder + Cache-Splits via Provider-Metadata
 *   - OpenAI: input/output, kein Cache-Split
 *   - Google: input/output
 *   - Mistral: input/output
 *   - Ollama: meist nur output, je nach Build
 *
 * `quotaSnapshot` ist der provider-agnostische Rate-Limit-/Quota-Header-
 * Schnappschuss. Anthropic-`anthropic-ratelimit-*`, OpenAI-`x-ratelimit-*`
 * usw. landen alle hier rein.
 */
export interface LlmUsageSnapshot {
  inputTokens?: number;
  outputTokens?: number;
  cacheReadTokens?: number;
  cacheWriteTokens?: number;
  quotaSnapshot?: {
    inputTokensRemaining?: number;
    outputTokensRemaining?: number;
    requestsRemaining?: number;
    resetAt?: string;
    raw?: Record<string, string>;
  };
}

export interface LlmStreamFrame {
  contentDelta?: string;
  toolCalls?: LlmStreamToolCall[];
  done: boolean;
  errorMessage?: string;
  /** v0.1.210 — gesetzt auf dem terminalen Frame (done=true), falls
   *  der Provider Usage-Daten zurückgeliefert hat. */
  usage?: LlmUsageSnapshot;
}

/**
 * What the orchestrator and renderer need to know about the active
 * provider. Mirrors `AgentStatus` partially — the orchestrator merges
 * this into its own status snapshot.
 */
export interface LlmProviderStatus {
  kind: LlmProviderKind;
  /** Tag/model name passed to the provider (e.g. "llama3.2:3b", "gpt-4o-mini"). */
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

import { EventEmitter } from "node:events";
import type { AgentMessage } from "../../../shared/types";
import type { OllamaToolSpec } from "../types";
import type {
  LlmProvider,
  LlmProviderStatus,
  LlmStreamFrame,
  LlmStreamRequest,
  LlmStreamToolCall,
} from "./types";

// OpenAIProvider (Phase 8.j).
//
// Talks to the official `https://api.openai.com/v1/chat/completions`
// endpoint with `stream:true`. The wire format is Server-Sent Events;
// each `data: {...}` line carries an OpenAI-flavoured chunk with
// `choices[0].delta` containing either content or tool-call fragments.
//
// Streaming protocol (briefly):
//   - Plain content arrives as `delta.content` strings — we forward
//     verbatim as `contentDelta`.
//   - Tool calls arrive as `delta.tool_calls[]` where each entry has an
//     `index` and a *partial* `function.name` / `function.arguments`
//     string. We coalesce by index, concatenating the arguments string
//     until `finish_reason === "tool_calls"`.
//   - The terminator `data: [DONE]` ends the stream.
//
// Only `tool_calls` and content are forwarded. Function-calling (the
// older non-tools API) is NOT supported — the tools[] schema produced
// by the registry maps cleanly onto OpenAI's `tools` parameter, so the
// orchestrator doesn't need a different code path per provider.

const OPENAI_BASE = "https://api.openai.com/v1";

export interface OpenAiProviderOptions {
  /** Returns the current API key (or null if cleared/unset). Async so the
   *  caller can decrypt safeStorage on demand and never holds the
   *  plaintext key in memory between calls. */
  getApiKey: () => Promise<string | null>;
  /** Callback that runs whenever the upstream key store changes — used
   *  so the provider can re-emit `status` without polling. */
  onKeyChanged: (cb: () => void) => () => void;
  /** Tag, e.g. "gpt-4o-mini", "gpt-4.1-mini", "o4-mini". */
  model: string;
  /** Optional override (Azure-OpenAI / proxy). Defaults to api.openai.com. */
  baseUrl?: string;
}

export class OpenAiProvider extends EventEmitter implements LlmProvider {
  readonly kind = "openai" as const;
  private readonly getApiKey: () => Promise<string | null>;
  private readonly baseUrl: string;
  private model: string;
  private hasKey = false;
  private readonly unsubscribeKey: () => void;

  constructor(opts: OpenAiProviderOptions) {
    super();
    this.getApiKey = opts.getApiKey;
    this.baseUrl = opts.baseUrl ?? OPENAI_BASE;
    this.model = opts.model;

    // Probe presence-only at construction so getStatus() is sync.
    void this.refreshKeyPresence();
    this.unsubscribeKey = opts.onKeyChanged(() => {
      void this.refreshKeyPresence();
    });
  }

  setModel(model: string): void {
    if (this.model === model) return;
    this.model = model;
    this.emit("status", this.getStatus());
  }

  private async refreshKeyPresence(): Promise<void> {
    const key = await this.getApiKey();
    const next = !!key;
    if (next === this.hasKey) return;
    this.hasKey = next;
    this.emit("status", this.getStatus());
  }

  getStatus(): LlmProviderStatus {
    return {
      kind: "openai",
      model: this.model,
      ready: this.hasKey,
      errorMessage: this.hasKey ? null : "OpenAI API key not set.",
    };
  }

  onStatusChanged(listener: (s: LlmProviderStatus) => void): () => void {
    const handler = (s: LlmProviderStatus): void => listener(s);
    this.on("status", handler);
    return () => this.off("status", handler);
  }

  dispose(): void {
    this.unsubscribeKey();
    this.removeAllListeners();
  }

  async *streamChat(
    req: LlmStreamRequest,
  ): AsyncGenerator<LlmStreamFrame, void, void> {
    const key = await this.getApiKey();
    if (!key) throw new Error("OpenAI API key not set.");

    const body: Record<string, unknown> = {
      model: this.model,
      messages: toOpenAiMessages(req.messages),
      stream: true,
    };
    if (req.tools && req.tools.length > 0) {
      body.tools = req.tools.map((t) => ({
        type: "function",
        function: {
          name: t.function.name,
          description: t.function.description,
          parameters: t.function.parameters,
        },
      }));
    }

    const res = await fetch(`${this.baseUrl}/chat/completions`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        authorization: `Bearer ${key}`,
      },
      body: JSON.stringify(body),
      signal: req.signal,
    });

    if (!res.ok || !res.body) {
      const text = await res.text().catch(() => "");
      throw new Error(
        `openai /chat/completions HTTP ${res.status}: ${text.slice(0, 300)}`,
      );
    }

    const reader = res.body.getReader();
    const decoder = new TextDecoder();
    let buf = "";
    // Coalesce tool_calls deltas keyed by their `index` field. OpenAI
    // sends one delta per partial fragment; we accumulate name + args
    // strings until finish_reason flips to "tool_calls".
    const toolBuf = new Map<
      number,
      { id?: string; name: string; args: string }
    >();

    try {
      // eslint-disable-next-line no-constant-condition
      while (true) {
        const { value, done } = await reader.read();
        if (done) break;
        buf += decoder.decode(value, { stream: true });
        let nl: number;
        while ((nl = buf.indexOf("\n")) >= 0) {
          const line = buf.slice(0, nl).replace(/\r$/, "");
          buf = buf.slice(nl + 1);
          if (!line.startsWith("data:")) continue;
          const payload = line.slice(5).trim();
          if (payload === "[DONE]") {
            // Flush any accumulated tool calls on the terminator. Most
            // streams already deliver them on a finish_reason frame, but
            // a malformed/truncated stream still surfaces something usable.
            const calls = drainToolBuf(toolBuf);
            yield {
              done: true,
              ...(calls.length > 0 ? { toolCalls: calls } : {}),
            };
            return;
          }
          if (!payload) continue;
          let frame: OpenAiStreamChunk;
          try {
            frame = JSON.parse(payload) as OpenAiStreamChunk;
          } catch {
            continue;
          }
          // OpenAI sometimes inlines an `error` object instead of a delta
          // (e.g. invalid_request_error mid-stream). Surface and stop.
          if (frame.error) {
            yield { done: true, errorMessage: frame.error.message ?? "openai error" };
            return;
          }
          const choice = frame.choices?.[0];
          if (!choice) continue;
          const delta = choice.delta ?? {};
          const out: LlmStreamFrame = { done: false };
          if (typeof delta.content === "string" && delta.content.length > 0) {
            out.contentDelta = delta.content;
          }
          if (Array.isArray(delta.tool_calls)) {
            for (const tc of delta.tool_calls) {
              const idx = tc.index ?? 0;
              const cur =
                toolBuf.get(idx) ?? { id: undefined, name: "", args: "" };
              if (tc.id) cur.id = tc.id;
              if (tc.function?.name) cur.name += tc.function.name;
              if (tc.function?.arguments) cur.args += tc.function.arguments;
              toolBuf.set(idx, cur);
            }
          }
          if (choice.finish_reason === "tool_calls") {
            out.toolCalls = drainToolBuf(toolBuf);
            out.done = true;
            yield out;
            return;
          }
          if (choice.finish_reason === "stop") {
            out.done = true;
            yield out;
            return;
          }
          if (out.contentDelta) yield out;
        }
      }
    } finally {
      reader.releaseLock?.();
    }
  }
}

// ---- Helpers ---------------------------------------------------------------

interface OpenAiStreamChunk {
  choices?: Array<{
    delta?: {
      content?: string;
      tool_calls?: Array<{
        index?: number;
        id?: string;
        function?: { name?: string; arguments?: string };
      }>;
    };
    finish_reason?: string | null;
  }>;
  error?: { message?: string; type?: string };
}

function drainToolBuf(
  buf: Map<number, { id?: string; name: string; args: string }>,
): LlmStreamToolCall[] {
  const out: LlmStreamToolCall[] = [];
  // Preserve the index ordering OpenAI assigned — the orchestrator
  // executes calls top-down and the model expects the same order.
  const sorted = [...buf.entries()].sort((a, b) => a[0] - b[0]);
  for (const [, v] of sorted) {
    if (!v.name) continue;
    out.push({
      id: v.id,
      function: { name: v.name, arguments: v.args },
    });
  }
  buf.clear();
  return out;
}

/**
 * Translate our internal AgentMessage shape into OpenAI's. The big
 * differences from Ollama are:
 *  - Tool result messages use `role: "tool"` and require `tool_call_id`.
 *  - Tool call arguments must be a STRING (JSON-stringified), not an object.
 *  - Assistant messages with tool_calls but no content still need `content: null`.
 */
function toOpenAiMessages(
  messages: AgentMessage[],
): Array<Record<string, unknown>> {
  return messages.map((m) => {
    if (m.role === "tool") {
      return {
        role: "tool",
        content: m.content,
        tool_call_id: m.toolCallId,
      };
    }
    const base: Record<string, unknown> = {
      role: m.role,
      content: m.content || (m.toolCalls && m.toolCalls.length > 0 ? null : ""),
    };
    if (m.toolCalls && m.toolCalls.length > 0) {
      base.tool_calls = m.toolCalls.map((tc) => ({
        id: tc.id,
        type: "function",
        function: {
          name: tc.name,
          arguments:
            typeof tc.args === "string" ? tc.args : JSON.stringify(tc.args ?? {}),
        },
      }));
    }
    return base;
  });
}

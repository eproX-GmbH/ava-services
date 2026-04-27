import type { AgentMessage } from "../../shared/types";
import type { OllamaToolSpec } from "./types";

// Thin wrapper around Ollama's `/api/chat` with NDJSON streaming.
//
// We bypass any HTTP client library on purpose — Node's built-in fetch +
// ReadableStream is enough, and pulling in `ollama-js` would force the
// renderer-tsconfig (which doesn't see node types) to know about it.
//
// Streaming protocol (Ollama v0.4+, native tool-calling):
//   POST /api/chat   { model, messages, tools?, stream:true, options:{...} }
//   200 OK           one JSON object per line, each carrying:
//                      { message: { role, content, tool_calls? }, done: bool }
//                    final frame has `done: true` and a usage block we ignore.
//
// We don't ask for streaming token-by-token tool_calls — Ollama emits the
// tool_calls array on the message object whole. Content tokens still stream
// per chunk; we forward those as `delta` frames upstream.

export interface OllamaChatRequest {
  host: string;
  model: string;
  messages: AgentMessage[];
  tools?: OllamaToolSpec[];
  signal: AbortSignal;
  /**
   * How long Ollama keeps the model loaded after the call. We use 10m to
   * keep latency low across consecutive turns — the supervisor itself never
   * idles the runtime.
   */
  keepAlive?: string;
}

export interface OllamaChatToolCall {
  id?: string;
  function: {
    name: string;
    arguments: Record<string, unknown> | string;
  };
}

export interface OllamaChatStreamFrame {
  /** Content delta for the assistant message being constructed. */
  contentDelta?: string;
  /** Set when Ollama emits tool calls (typically on the final frame). */
  toolCalls?: OllamaChatToolCall[];
  /** Wall-clock ms since epoch, attached for UI ordering. */
  done: boolean;
  /** Set when the upstream returns an error frame instead of a token. */
  errorMessage?: string;
}

/**
 * Maps our internal `AgentMessage[]` to Ollama's `/api/chat` body shape.
 * Strips fields Ollama doesn't accept (id, createdAt) and renames toolCalls
 * → tool_calls / toolCallId → tool_call_id to match the Ollama snake_case.
 */
function toOllamaMessages(
  messages: AgentMessage[],
): Array<Record<string, unknown>> {
  return messages.map((m) => {
    const base: Record<string, unknown> = { role: m.role, content: m.content };
    if (m.toolCalls && m.toolCalls.length > 0) {
      base.tool_calls = m.toolCalls.map((tc) => ({
        id: tc.id,
        function: { name: tc.name, arguments: tc.args ?? {} },
      }));
    }
    if (m.toolCallId) base.tool_call_id = m.toolCallId;
    return base;
  });
}

/**
 * Async-iterates over chat stream frames. Caller is responsible for
 * accumulating content deltas into the assistant message and reacting to
 * tool_calls on the final frame.
 *
 * Throws on transport errors and on abort. The orchestrator catches both
 * and emits an `error` frame to the renderer.
 */
export async function* streamChat(
  req: OllamaChatRequest,
): AsyncGenerator<OllamaChatStreamFrame, void, void> {
  const body: Record<string, unknown> = {
    model: req.model,
    messages: toOllamaMessages(req.messages),
    stream: true,
    keep_alive: req.keepAlive ?? "10m",
    // Pin the context window so the runner's working set is predictable.
    // Default Ollama ctx (varies per model, often 32k+) has caused
    // out-of-memory crashes on Apple Silicon when tools[] is also
    // attached — bounding to 8k is plenty for the agent's ReAct loop and
    // keeps resident memory under ~6GB on 7B-class models.
    options: { num_ctx: 8192 },
  };
  if (req.tools && req.tools.length > 0) body.tools = req.tools;

  const res = await fetch(`${req.host}/api/chat`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
    signal: req.signal,
  });

  if (!res.ok || !res.body) {
    const text = await res.text().catch(() => "");
    throw new Error(`ollama /api/chat HTTP ${res.status}: ${text.slice(0, 200)}`);
  }

  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  let buf = "";

  try {
    // eslint-disable-next-line no-constant-condition
    while (true) {
      const { value, done } = await reader.read();
      if (done) break;
      buf += decoder.decode(value, { stream: true });
      let nl: number;
      while ((nl = buf.indexOf("\n")) >= 0) {
        const line = buf.slice(0, nl).trim();
        buf = buf.slice(nl + 1);
        if (!line) continue;
        let frame: {
          message?: { content?: string; tool_calls?: OllamaChatToolCall[] };
          done?: boolean;
          error?: string;
        };
        try {
          frame = JSON.parse(line);
        } catch {
          continue;
        }
        if (frame.error) {
          yield { done: true, errorMessage: frame.error };
          return;
        }
        const out: OllamaChatStreamFrame = {
          contentDelta: frame.message?.content,
          toolCalls: frame.message?.tool_calls,
          done: !!frame.done,
        };
        yield out;
        if (out.done) return;
      }
    }
  } finally {
    reader.releaseLock?.();
  }
}

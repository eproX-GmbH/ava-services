import { EventEmitter } from "node:events";
import { streamText, jsonSchema, tool, stepCountIs } from "ai";
import type {
  ModelMessage,
  TextStreamPart,
  ToolSet,
} from "ai";
import { createLLM, type RuntimeProvider } from "@ava/ai-provider";
import type { OllamaSupervisor } from "../../ollama-supervisor";
import type { AgentMessage, LlmProviderKind } from "../../../shared/types";
import type { OllamaToolSpec } from "../types";
import type {
  LlmProvider,
  LlmProviderStatus,
  LlmStreamFrame,
  LlmStreamRequest,
  LlmStreamToolCall,
} from "./types";

// AiSdkProvider (Phase 8.k1).
//
// One generic provider class that wraps Vercel AI SDK's `streamText` for
// every supported vendor (ollama, openai, anthropic, google, mistral).
// Replaces the hand-rolled SSE/NDJSON parsers from 8.j.
//
// Why one class instead of one per kind:
//   - The branching in 8.j was minor (different status sources, different
//     wire formats). Wire format is now AI SDK's `fullStream`, which is
//     identical across vendors. The remaining variance is: "what does
//     'ready' mean for this provider?" — one method, three lines.
//   - New providers (anthropic, google, mistral) drop in by adding a
//     `kind` to the runtime config and a status branch. No new files.
//
// Status semantics:
//   - ollama: ready iff supervisor reports `state==='ready'` AND a model
//     id is known. The supervisor owns the child process, this provider
//     just reads its status.
//   - hosted (openai/anthropic/google/mistral): ready iff a key is
//     present in the safeStorage-backed store. Key validity (does it
//     authenticate against the API?) is verified lazily on first call —
//     reporting "ready" off mere presence keeps the picker responsive
//     and matches what 8.j shipped.
//
// Tool-call shape:
//   - Inputs: orchestrator passes `OllamaToolSpec[]` (a JSON-Schema
//     function descriptor, the legacy name predates the abstraction).
//     We wrap each `parameters` JSON Schema with AI SDK's `jsonSchema()`
//     and feed it to `tool({ inputSchema })`. No `execute` function is
//     supplied — the orchestrator runs tools and feeds results back via
//     the next `streamChat` call, exactly as it did pre-migration.
//   - Outputs: AI SDK's `tool-call` events arrive whole (they coalesce
//     argument fragments internally). We collect them and yield once on
//     the terminal frame so the orchestrator's contract — tool calls
//     visible only on the final `done:true` frame — is preserved.

export interface AiSdkProviderOptions {
  kind: LlmProviderKind;
  /** Resolves the model id for this provider. Re-read each turn so a
   *  picker change mid-session takes effect on the next send. */
  getModel: () => string;
  /**
   * Key resolver. Returns `null` for ollama (keyless) and
   * "key-not-set" / "decrypt-failed" / a plaintext key for the rest.
   * Async so the caller can hit safeStorage on demand without retaining
   * plaintext between turns.
   */
  getApiKey: () => Promise<string | null>;
  /**
   * Sync "is a key file present?" check — drives the status flag so the
   * badge matches what the API-keys panel shows ("stored"). We deliberately
   * do NOT gate status on decrypt success: a keychain that's temporarily
   * locked or rotated would otherwise silently flip the provider to "not
   * set" even though the user just saved a key. Decryption failures
   * surface at streamChat time with an actionable message instead.
   */
  hasStoredKey: () => boolean;
  /**
   * Subscribe to "the upstream key store moved" — fires for any provider
   * key change, the resolver decides if it's relevant. Returns an
   * unsubscribe handle.
   */
  onKeyChanged: (cb: () => void) => () => void;
  /**
   * Ollama-only — supervisor handle for status + base URL. Required
   * iff `kind === "ollama"`. Ignored otherwise.
   */
  supervisor?: OllamaSupervisor;
}

export class AiSdkProvider extends EventEmitter implements LlmProvider {
  readonly kind: LlmProviderKind;
  private readonly getModel: () => string;
  private readonly getApiKey: () => Promise<string | null>;
  private readonly hasStoredKey: () => boolean;
  private readonly supervisor?: OllamaSupervisor;
  private readonly unsubscribeKey: () => void;
  private readonly unsubscribeOllama?: () => void;

  constructor(opts: AiSdkProviderOptions) {
    super();
    this.kind = opts.kind;
    this.getModel = opts.getModel;
    this.getApiKey = opts.getApiKey;
    this.hasStoredKey = opts.hasStoredKey;
    this.supervisor = opts.supervisor;

    this.unsubscribeKey = opts.onKeyChanged(() => {
      // The flag is recomputed sync each time getStatus() runs, so we
      // just need to fan a status event out to subscribers when the key
      // file appears or disappears.
      this.emit("status", this.getStatus());
    });

    if (this.kind === "ollama" && opts.supervisor) {
      const handler = (): void => {
        this.emit("status", this.getStatus());
      };
      opts.supervisor.on("status", handler);
      this.unsubscribeOllama = () =>
        opts.supervisor?.removeListener("status", handler);
    }
  }

  // ---- Status --------------------------------------------------------------

  getStatus(): LlmProviderStatus {
    if (this.kind === "ollama") return this.ollamaStatus();
    return this.hostedStatus();
  }

  onStatusChanged(listener: (s: LlmProviderStatus) => void): () => void {
    const handler = (s: LlmProviderStatus): void => listener(s);
    this.on("status", handler);
    return () => this.off("status", handler);
  }

  dispose(): void {
    this.unsubscribeKey();
    this.unsubscribeOllama?.();
    this.removeAllListeners();
  }

  private ollamaStatus(): LlmProviderStatus {
    const oll = this.supervisor?.getStatus();
    if (!oll) {
      return {
        kind: "ollama",
        model: null,
        ready: false,
        errorMessage: "Ollama supervisor not attached.",
      };
    }
    const model = this.getModel() || null;
    const ready = oll.state === "ready" && model !== null;
    return {
      kind: "ollama",
      model,
      ready,
      errorMessage:
        oll.state === "error"
          ? (oll.errorMessage ?? "Ollama is not running.")
          : oll.state !== "ready"
            ? "Ollama is starting."
            : !model
              ? "No LLM-role model configured."
              : null,
    };
  }

  private hostedStatus(): LlmProviderStatus {
    const model = this.getModel() || null;
    const hasKey = this.hasStoredKey();
    return {
      kind: this.kind,
      model,
      ready: hasKey && model !== null,
      errorMessage: !hasKey
        ? `${labelFor(this.kind)} API key not set.`
        : !model
          ? `No model selected for ${labelFor(this.kind)}.`
          : null,
    };
  }

  // ---- Streaming -----------------------------------------------------------

  async *streamChat(
    req: LlmStreamRequest,
  ): AsyncGenerator<LlmStreamFrame, void, void> {
    const status = this.getStatus();
    if (!status.ready || !status.model) {
      throw new Error(status.errorMessage ?? `${this.kind} provider not ready.`);
    }

    // Build the AI SDK LanguageModel. We construct fresh per call rather
    // than caching: keys can rotate between turns and Ollama's base URL
    // can shift if the supervisor restarts on a different port.
    const apiKey = (await this.getApiKey()) ?? undefined;
    if (this.kind !== "ollama" && !apiKey && this.hasStoredKey()) {
      // The key file exists on disk (so status reports "ready") but
      // safeStorage couldn't decrypt it. The OS keychain may have been
      // rotated or the encrypted blob written by a different binary —
      // either way the user has to re-save. Surface that explicitly
      // instead of letting the SDK fail with a generic 401.
      throw new Error(
        `${labelFor(this.kind)} API key is unreadable. The OS keychain may have changed since it was saved. Open Whoami → API keys and re-enter the key.`,
      );
    }
    const baseURL =
      this.kind === "ollama"
        ? this.ollamaBaseURL()
        : undefined;
    // v0.1.7 diagnostic: log key shape (length + masked head/tail) and
    // request shape so we can tell, post-mortem in DevTools, whether
    // the key reached this layer intact and which model the SDK is
    // about to talk to. Never logs the full key.
    if (this.kind !== "ollama") {
      const k = apiKey ?? "";
      const masked =
        k.length > 8 ? `${k.slice(0, 4)}…${k.slice(-4)}` : `len=${k.length}`;
      const ascii = /^[\x20-\x7E]*$/.test(k);
      const hasWS = /\s/.test(k);
      // eslint-disable-next-line no-console
      console.log(
        `[${this.kind}] outgoing call → model=${status.model} key=${masked} keyLen=${k.length} ascii=${ascii} hasWhitespace=${hasWS}`,
      );
    }
    const model = createLLM({
      provider: this.kind as RuntimeProvider,
      model: status.model,
      apiKey,
      baseURL,
    });

    const tools = req.tools ? buildToolSet(req.tools) : undefined;

    const result = streamText({
      model,
      messages: toModelMessages(req.messages),
      ...(tools ? { tools } : {}),
      // Stop after a single assistant turn — we run the ReAct loop
      // ourselves so the orchestrator can interleave UI prompts /
      // user-confirmation flows between tool calls.
      stopWhen: stepCountIs(1),
      abortSignal: req.signal,
    });

    // Coalesce tool calls until the stream finishes. AI SDK already
    // accumulates argument fragments per tool-call into a single event,
    // so this is effectively just "collect until finish".
    const collected: LlmStreamToolCall[] = [];

    try {
      for await (const part of result.fullStream as AsyncIterable<
        TextStreamPart<ToolSet>
      >) {
        switch (part.type) {
          case "text-delta": {
            const delta = (part as { text?: string }).text ?? "";
            if (delta.length > 0) {
              yield { done: false, contentDelta: delta };
            }
            break;
          }
          case "tool-call": {
            const tc = part as {
              toolCallId: string;
              toolName: string;
              input?: unknown;
            };
            collected.push({
              id: tc.toolCallId,
              function: {
                name: tc.toolName,
                arguments:
                  tc.input == null
                    ? {}
                    : (tc.input as Record<string, unknown>),
              },
            });
            break;
          }
          case "error": {
            const err = (part as { error?: unknown }).error;
            // v0.1.7 diagnostic: dump the full error including the
            // cause chain so DevTools shows undici's underlying
            // ECONNRESET / TLS / etc., not just the SDK's wrapper.
            // eslint-disable-next-line no-console
            console.error(`[${this.kind}] stream error part:`, err, {
              cause: err instanceof Error ? (err as { cause?: unknown }).cause : undefined,
              stack: err instanceof Error ? err.stack : undefined,
            });
            const msg =
              err instanceof Error
                ? err.message
                : typeof err === "string"
                  ? err
                  : "ai-sdk stream error";
            yield { done: true, errorMessage: msg };
            return;
          }
          case "finish":
          case "abort": {
            yield {
              done: true,
              ...(collected.length > 0 ? { toolCalls: collected } : {}),
            };
            return;
          }
          default:
            // Ignore other event kinds (reasoning, sources, step-start,
            // step-finish, tool-input-* deltas) — the orchestrator
            // doesn't surface them yet. Adding visibility is a follow-up.
            break;
        }
      }
    } catch (err) {
      // streamText throws on auth errors / network failures before the
      // first frame. Translate into our terminal error frame so the
      // orchestrator's catch block treats the turn as a sticky error.
      //
      // v0.1.7 diagnostic: dump the full error + cause chain to
      // DevTools console. The wrapped message shown to the user often
      // hides the underlying network reason (e.g. SDK says
      // "Cannot connect to API: read ECONNRESET" but the cause has
      // the actual TLS or DNS detail).
      // eslint-disable-next-line no-console
      console.error(`[${this.kind}] streamText threw before first frame:`, err, {
        cause: err instanceof Error ? (err as { cause?: unknown }).cause : undefined,
        stack: err instanceof Error ? err.stack : undefined,
        name: err instanceof Error ? err.name : typeof err,
      });
      const msg = err instanceof Error ? err.message : String(err);
      yield { done: true, errorMessage: msg };
      return;
    }

    // Defensive: if the iterable ended without a `finish`/`abort` part
    // (shouldn't happen, but cheap to guard) emit a terminal anyway.
    yield {
      done: true,
      ...(collected.length > 0 ? { toolCalls: collected } : {}),
    };
  }

  private ollamaBaseURL(): string {
    const oll = this.supervisor?.getStatus();
    // ollama-ai-provider-v2 expects the `/api` suffix.
    return (oll?.host ?? "http://localhost:11434") + "/api";
  }
}

// ---- Translation helpers ---------------------------------------------------

/**
 * Translate AVA's internal `AgentMessage[]` into AI SDK's `ModelMessage[]`.
 * The shapes diverge in three ways the orchestrator is blind to:
 *  - assistant `tool_calls` become `content: [{ type: "tool-call", … }]`.
 *  - `tool` role messages become `content: [{ type: "tool-result", … }]`.
 *  - tool-call inputs are always objects, never the string-encoded JSON
 *    that some vendors (OpenAI) historically returned.
 */
function toModelMessages(messages: AgentMessage[]): ModelMessage[] {
  return messages.map((m): ModelMessage => {
    if (m.role === "tool") {
      return {
        role: "tool",
        content: [
          {
            type: "tool-result",
            toolCallId: m.toolCallId ?? "",
            toolName: extractToolNameFromContent(m.content),
            output: { type: "text", value: m.content },
          },
        ],
      };
    }
    if (m.role === "system") {
      return { role: "system", content: m.content };
    }
    if (m.role === "user") {
      return { role: "user", content: m.content };
    }
    // assistant
    if (!m.toolCalls || m.toolCalls.length === 0) {
      return { role: "assistant", content: m.content };
    }
    const parts: Array<
      | { type: "text"; text: string }
      | {
          type: "tool-call";
          toolCallId: string;
          toolName: string;
          input: Record<string, unknown>;
        }
    > = [];
    if (m.content && m.content.length > 0) {
      parts.push({ type: "text", text: m.content });
    }
    for (const tc of m.toolCalls) {
      const input =
        typeof tc.args === "string"
          ? safeJsonParseObject(tc.args)
          : ((tc.args ?? {}) as Record<string, unknown>);
      parts.push({
        type: "tool-call",
        toolCallId: tc.id,
        toolName: tc.name,
        input,
      });
    }
    return { role: "assistant", content: parts };
  });
}

function safeJsonParseObject(raw: string): Record<string, unknown> {
  try {
    const parsed = JSON.parse(raw);
    return typeof parsed === "object" && parsed !== null
      ? (parsed as Record<string, unknown>)
      : {};
  } catch {
    return {};
  }
}

/**
 * Tool-result messages don't carry the original tool name in our
 * AgentMessage shape — orchestrator pairs them by toolCallId. AI SDK's
 * tool-result part requires `toolName`, but it doesn't validate against
 * the tool registry, so an empty string would be accepted. We do the
 * minimal-effort thing: leave it blank when we can't recover it. The
 * orchestrator never reads it back.
 */
function extractToolNameFromContent(_content: string): string {
  return "";
}

/**
 * Wrap our internal `OllamaToolSpec[]` (raw JSON-Schema function
 * descriptors) into AI SDK's `ToolSet` format. Each tool becomes a
 * declaration-only entry — the orchestrator handles execution.
 */
function buildToolSet(specs: OllamaToolSpec[]): ToolSet {
  const out: ToolSet = {};
  for (const spec of specs) {
    out[spec.function.name] = tool({
      description: spec.function.description,
      inputSchema: jsonSchema(spec.function.parameters),
    });
  }
  return out;
}

function labelFor(kind: LlmProviderKind): string {
  switch (kind) {
    case "ollama":
      return "Ollama";
    case "openai":
      return "OpenAI";
    case "anthropic":
      return "Anthropic";
    case "google":
      return "Google";
    case "mistral":
      return "Mistral";
  }
}

import { EventEmitter } from "node:events";
import { randomUUID } from "node:crypto";
import type {
  AgentMessage,
  AgentSendInput,
  AgentSendResult,
  AgentStatus,
  AgentStreamFrame,
  AgentToolCall,
} from "../../shared/types";
import { ToolRegistry } from "./tool-registry";
import { buildSystemPrompt } from "./prompts";
import { UiBridge, type PendingChoice } from "./ui-bridge";
import type { LlmProviderManager, LlmStreamToolCall } from "./providers";
import type { Conversation, Tool, ToolContext } from "./types";
import type { MemoryStore } from "./memory";

// Agent orchestrator (Phase 8.a).
//
// Single in-flight slot per orchestrator: while a request is running, a
// second `send` rejects synchronously. The renderer is expected to gate
// the input field on `inFlightRequestId`, but we enforce server-side too
// so a buggy client can't double-submit.
//
// ReAct loop:
//   1. Append user message → push to conversation.
//   2. POST /api/chat with full message log + tools[].
//   3. Stream content deltas as `token` frames.
//   4. On final frame:
//        - If tool_calls present: validate args, run each, append `tool`
//          messages with results, loop back to step 2.
//        - Otherwise: emit `done`, store assistant message.
//   5. Step budget caps the loop at 12 iterations to bound runaway tool use.
//
// 8.a ships with an empty ToolRegistry so the loop only ever sees plain
// content frames — tool-calling becomes live in 8.b.

const STEP_BUDGET = 12;

export interface AgentOrchestratorOptions {
  /**
   * Provider manager — the orchestrator delegates streamChat to whatever
   * provider is currently active (Ollama or OpenAI). Lifecycle status
   * (Ollama starting, OpenAI key missing, …) bubbles through the manager
   * so AgentStatus has a single source of truth.
   */
  providers: LlmProviderManager;
  registry?: ToolRegistry;
  /**
   * On-disk transcript store (Phase 8.d). Optional — if omitted the
   * orchestrator runs in pure-memory mode (used by tests and when the
   * boot-time writability probe fails). When present, every message is
   * append-logged after it lands in the in-memory `Conversation`, and
   * unknown conversation ids lazy-load from disk on first `send`.
   */
  memory?: MemoryStore;
  /**
   * Sticky error surfaced via `AgentStatus.memoryError`. Set by main when
   * the memory probe fails so the FirstRunWizard can show the path/reason.
   * Not used to gate `send()` — we degrade silently.
   */
  memoryError?: string | null;
  /**
   * Hook invoked when the local model runtime crashes mid-turn ("llama
   * runner process has terminated", "model load failed", …). Wired in
   * main/index.ts to `ollama.restart()` so the user can hit Send again
   * and have it work without quitting the app. We deliberately keep
   * this as an opt-in callback rather than a hard import on the
   * supervisor — the orchestrator is hosted-provider-aware too, and a
   * future cloud-only build won't have a supervisor to restart.
   */
  runtimeRecover?: () => Promise<void>;
  /**
   * Phase 8.t1 — user profile store. When set, the system prompt
   * builder injects the profile block on every turn so every
   * response is biased by the user's lens. Optional so tests
   * (and a future stateless mode) can omit it.
   */
  profileStore?: { get: () => import("../../shared/types").UserProfile };
}

export interface AgentOrchestratorEvents {
  stream: (frame: AgentStreamFrame) => void;
  status: (status: AgentStatus) => void;
}

export declare interface AgentOrchestrator {
  on<E extends keyof AgentOrchestratorEvents>(
    event: E,
    listener: AgentOrchestratorEvents[E],
  ): this;
  emit<E extends keyof AgentOrchestratorEvents>(
    event: E,
    ...args: Parameters<AgentOrchestratorEvents[E]>
  ): boolean;
}

export class AgentOrchestrator extends EventEmitter {
  private readonly providers: LlmProviderManager;
  private readonly registry: ToolRegistry;
  private readonly conversations = new Map<string, Conversation>();
  private readonly memory: MemoryStore | undefined;
  private readonly memoryError: string | null;
  private readonly runtimeRecover: (() => Promise<void>) | undefined;
  private readonly profileStore:
    | { get: () => import("../../shared/types").UserProfile }
    | undefined;
  /** Coalesce concurrent recovery attempts — multiple in-flight turns
   *  hitting the same crash should only kick one restart. */
  private runtimeRecoverInFlight: Promise<void> | null = null;

  private inFlightRequestId: string | null = null;
  private currentAbort: AbortController | null = null;
  private errorMessage: string | null = null;
  /**
   * Pending `ask_user_choice` prompts. Keyed by choiceId (UUID). The
   * UiBridge writes here when emitting a choice-request frame; the
   * renderer's `answerChoice` IPC call reads it back. We hold the map at
   * orchestrator scope (not per-request) because abort cleanup needs to
   * see all in-flight choices for the dying requestId.
   */
  private readonly pendingChoices = new Map<string, PendingChoice>();

  constructor(opts: AgentOrchestratorOptions) {
    super();
    this.providers = opts.providers;
    this.registry = opts.registry ?? new ToolRegistry();
    this.memory = opts.memory;
    this.memoryError = opts.memoryError ?? null;
    this.runtimeRecover = opts.runtimeRecover;
    this.profileStore = opts.profileStore;

    // Re-emit status when the active provider moves so the renderer's
    // Chat tab can re-enable the input the moment the model is ready.
    // Covers both Ollama lifecycle transitions and OpenAI key changes.
    this.providers.onStatusChanged(() => this.emit("status", this.getStatus()));
  }

  // ---- Public surface -------------------------------------------------------

  getStatus(): AgentStatus {
    const provider = this.providers.getStatus();
    return {
      ready: provider.ready,
      model: provider.model,
      // ollamaHost is kept on AgentStatus for backwards compat with the
      // renderer's status badge, but it only carries meaning when the
      // active provider is ollama. For OpenAI we leave it null.
      ollamaHost: null,
      inFlightRequestId: this.inFlightRequestId,
      errorMessage: this.errorMessage ?? provider.errorMessage,
      memoryError: this.memoryError,
    };
  }

  /**
   * Kicks off a turn and returns its requestId synchronously. The actual
   * model interaction happens on a background promise that emits frames
   * via `stream`. Errors during streaming surface as terminal `error`
   * frames, not rejections — the renderer subscribes to frames anyway.
   */
  send(input: AgentSendInput): AgentSendResult {
    const status = this.getStatus();
    if (!status.ready) {
      throw new Error(
        status.ollamaHost === null
          ? "Ollama is not running yet."
          : "No LLM-role model is configured.",
      );
    }
    if (this.inFlightRequestId !== null) {
      throw new Error("Another request is already in flight.");
    }

    const requestId = randomUUID();
    const convo = this.getOrCreateConversation(input.conversationId);
    const userMessage: AgentMessage = {
      id: randomUUID(),
      role: "user",
      content: input.message,
      createdAt: Date.now(),
    };
    this.appendMessage(convo, userMessage);

    this.inFlightRequestId = requestId;
    this.errorMessage = null;
    this.emit("status", this.getStatus());

    const abort = new AbortController();
    this.currentAbort = abort;

    // Capture the active provider at turn start. If the user (or a tool)
    // flips the provider mid-turn we still finish on the engine that
    // booted this conversation step — the swap takes effect next turn.
    const provider = this.providers.activeProvider();

    void this.runLoop({
      requestId,
      conversation: convo,
      provider,
      signal: abort.signal,
    }).finally(() => {
      this.inFlightRequestId = null;
      this.currentAbort = null;
      this.emit("status", this.getStatus());
    });

    return { requestId };
  }

  /** Aborts the in-flight request, if any. No-op when idle. */
  abort(requestId?: string): void {
    if (this.currentAbort === null) return;
    if (requestId && requestId !== this.inFlightRequestId) return;
    this.currentAbort.abort();
    // Reject any pending choice prompts tied to this request so a tool
    // blocked on askChoice unwinds promptly. The UiBridge cleanup also
    // does this, but doing it here covers the "abort fires before the
    // tool's own signal listener runs" race.
    for (const [id, entry] of this.pendingChoices) {
      if (!requestId || entry.requestId === requestId) {
        this.pendingChoices.delete(id);
        entry.reject(new Error("aborted"));
      }
    }
  }

  /**
   * Renderer-driven resolution of an open `choice-request`. Called via
   * IPC after the user picks an option. Unknown choiceIds are silently
   * dropped — possible after an abort or a stale window.
   */
  answerChoice(choiceId: string, value: string): void {
    const entry = this.pendingChoices.get(choiceId);
    if (!entry) return;
    this.pendingChoices.delete(choiceId);
    // Emit a resolved frame so the renderer can collapse the ChoiceCard
    // into a static "you picked X" message, even on a different window.
    const conv = this.findConversationForRequest(entry.requestId);
    this.emitFrame({
      kind: "choice-resolved",
      requestId: entry.requestId,
      conversationId: conv,
      choiceId,
      value,
    });
    entry.resolve(value);
  }

  private findConversationForRequest(_requestId: string): string {
    // We don't currently index by requestId. The renderer doesn't strictly
    // need conversationId on the resolved frame (it filters by requestId),
    // so an empty string is fine. Kept as a function so a future
    // multi-request orchestrator can fill it in.
    return "";
  }

  dispose(): void {
    this.abort();
    this.removeAllListeners();
  }

  // ---- Internal: ReAct loop -------------------------------------------------

  private async runLoop(args: {
    requestId: string;
    conversation: Conversation;
    provider: import("./providers").LlmProvider;
    signal: AbortSignal;
  }): Promise<void> {
    const { requestId, conversation, provider, signal } = args;

    try {
      for (let step = 0; step < STEP_BUDGET; step++) {
        // Build the message log we'll send. The system prompt is rebuilt
        // every turn so a tool registered mid-session would show up — cheap
        // because the registry is small.
        const systemMessage: AgentMessage = {
          id: "__system__",
          role: "system",
          content: buildSystemPrompt(
            this.registry,
            this.profileStore?.get() ?? null,
          ),
          createdAt: 0,
        };
        const messages = [systemMessage, ...conversation.messages];

        const assistantId = randomUUID();
        let assistantContent = "";
        let collectedToolCalls: LlmStreamToolCall[] | undefined;

        for await (const frame of provider.streamChat({
          messages,
          tools:
            this.registry.size() > 0 ? this.registry.toOllamaTools() : undefined,
          signal,
        })) {
          if (frame.errorMessage) {
            throw new Error(frame.errorMessage);
          }
          if (frame.contentDelta && frame.contentDelta.length > 0) {
            assistantContent += frame.contentDelta;
            this.emitFrame({
              kind: "token",
              requestId,
              conversationId: conversation.id,
              messageId: assistantId,
              delta: frame.contentDelta,
            });
          }
          if (frame.toolCalls && frame.toolCalls.length > 0) {
            collectedToolCalls = frame.toolCalls;
          }
        }

        // Persist whatever the assistant produced this step (content +
        // optional tool_calls) so subsequent /api/chat calls have the full
        // ReAct trace.
        const toolCalls = collectedToolCalls
          ? this.normaliseToolCalls(collectedToolCalls)
          : undefined;
        const assistantMessage: AgentMessage = {
          id: assistantId,
          role: "assistant",
          content: assistantContent,
          toolCalls,
          createdAt: Date.now(),
        };
        this.appendMessage(conversation, assistantMessage);

        // No tool calls → assistant turn is complete.
        if (!toolCalls || toolCalls.length === 0) {
          this.emitFrame({
            kind: "done",
            requestId,
            conversationId: conversation.id,
            messageId: assistantId,
          });
          return;
        }

        // Otherwise: run each tool, append `tool` messages, loop.
        for (const call of toolCalls) {
          this.emitFrame({
            kind: "tool-call",
            requestId,
            conversationId: conversation.id,
            toolCall: call,
          });
          const result = await this.runTool(
            call,
            signal,
            requestId,
            conversation.id,
          );
          this.appendMessage(conversation, {
            id: randomUUID(),
            role: "tool",
            content: result.content,
            toolCallId: call.id,
            createdAt: Date.now(),
          });
          this.emitFrame({
            kind: "tool-result",
            requestId,
            conversationId: conversation.id,
            toolCallId: call.id,
            ok: result.ok,
            preview: result.preview,
          });
        }
      }

      // Step budget exhausted — emit a terminal error so the renderer
      // releases its in-flight gate.
      throw new Error(`agent step budget exhausted (${STEP_BUDGET})`);
    } catch (err) {
      const raw =
        err instanceof Error
          ? err.name === "AbortError"
            ? "request aborted"
            : err.message
          : String(err);
      let message = humaniseRunnerError(raw);
      // Local-runtime crashes leave `ollama serve` alive but its
      // internal runner state wedged. Kick a supervisor restart so the
      // next Send works without the user quitting the app — and tell
      // them so they don't think the app is broken.
      if (isRuntimeCrash(raw) && this.runtimeRecover) {
        this.kickRuntimeRecover();
        message =
          message +
          " (The local runtime is being restarted automatically — try sending again in a few seconds.)";
      }
      this.errorMessage = message;
      this.emitFrame({
        kind: "error",
        requestId,
        conversationId: conversation.id,
        message,
      });
    }
  }

  private kickRuntimeRecover(): void {
    if (!this.runtimeRecover || this.runtimeRecoverInFlight) return;
    const p = (async () => {
      try {
        await this.runtimeRecover!();
      } catch (err) {
        console.warn("[agent] runtime recover failed:", err);
      } finally {
        this.runtimeRecoverInFlight = null;
        // Bubble the post-restart status so the renderer's Chat tab
        // can re-enable the input as soon as the supervisor is ready.
        this.emit("status", this.getStatus());
      }
    })();
    this.runtimeRecoverInFlight = p;
  }

  private emitFrame(frame: AgentStreamFrame): void {
    this.emit("stream", frame);
  }

  private getOrCreateConversation(id: string): Conversation {
    const existing = this.conversations.get(id);
    if (existing) return existing;
    // Lazy-load from disk on first touch in this process (Phase 8.d).
    // Returns [] on miss / parse failure / non-writable — the user just
    // gets a fresh conversation under the same id.
    const restored = this.memory?.load(id) ?? [];
    const fresh: Conversation = { id, messages: restored };
    this.conversations.set(id, fresh);
    if (this.memory && restored.length === 0) {
      // First write — drop the frontmatter so the file shows up on disk
      // even before any messages have been appended (lets the user spot
      // an empty conversation, and `list()` picks it up).
      this.memory.ensureConversation(id);
    }
    return fresh;
  }

  /**
   * Push a message into the in-memory conversation AND mirror it to disk.
   * Centralised so we don't forget the append on a future code path.
   */
  private appendMessage(convo: Conversation, message: AgentMessage): void {
    convo.messages.push(message);
    this.memory?.append(convo.id, message);
  }

  /**
   * Map Ollama's tool_call shape onto our internal `AgentToolCall`. Ollama
   * sometimes returns `arguments` as a JSON string and sometimes as an
   * object — the small models can be inconsistent. We accept both.
   */
  private normaliseToolCalls(raw: LlmStreamToolCall[]): AgentToolCall[] {
    return raw.map((rc) => {
      const rawArgs = rc.function.arguments;
      let args: unknown = rawArgs;
      if (typeof rawArgs === "string") {
        try {
          args = JSON.parse(rawArgs);
        } catch {
          args = rawArgs;
        }
      }
      return {
        id: rc.id ?? randomUUID(),
        name: rc.function.name,
        args,
      };
    });
  }

  /**
   * Looks up the tool, validates its args, runs it. Errors are caught and
   * folded into a non-ok result so the loop can surface the failure to
   * the model — the model often recovers by trying a different approach.
   */
  private async runTool(
    call: AgentToolCall,
    signal: AbortSignal,
    requestId: string,
    conversationId: string,
  ): Promise<{ ok: boolean; content: string; preview: string }> {
    const tool: Tool | undefined = this.registry.get(call.name);
    if (!tool) {
      const msg = `unknown tool: ${call.name}`;
      return { ok: false, content: JSON.stringify({ error: msg }), preview: msg };
    }
    const ui = new UiBridge(
      { emit: (f) => this.emitFrame(f), pending: this.pendingChoices },
      requestId,
      conversationId,
    );
    const ctx: ToolContext = {
      signal,
      log: (m) => console.log(`[agent:tool:${call.name}] ${m}`),
      ui,
    };
    try {
      const parsed = tool.parseArgs(call.args);
      const result = await tool.run(parsed, ctx);
      return {
        ok: true,
        content: JSON.stringify(result),
        preview: tool.preview(result),
      };
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      return {
        ok: false,
        content: JSON.stringify({ error: msg }),
        preview: `error: ${msg}`,
      };
    }
  }
}

/**
 * Map low-level Ollama errors to messages the user can act on. Pure
 * function so tests can pin the mapping without spinning a fake server.
 */
/**
 * Does this error look like Ollama's local runner crashed (as opposed
 * to e.g. a network failure to a hosted provider, or a tool-validation
 * miss)? If so the orchestrator kicks a supervisor restart. Match by
 * substring rather than parsing JSON because the AI SDK wraps the body
 * in its own RetryError before we see it.
 */
function isRuntimeCrash(raw: string): boolean {
  return (
    /llama runner process has terminated/i.test(raw) ||
    /llama runner process no longer running/i.test(raw) ||
    /model load failed/i.test(raw)
  );
}

function humaniseRunnerError(raw: string): string {
  // Llama runner crash. On the Mac M1 / M2 8 GB tier this is almost
  // always OOM (the runner gets SIGKILLed by the OS). Less commonly:
  // model file corruption from an interrupted pull (pre-8.k10d, where
  // a half-streamed pull would falsely report success), or a model
  // that doesn't support tools[] in Ollama (gemma3 family).
  if (/llama runner process has terminated/i.test(raw)) {
    return [
      "The local model crashed mid-generation.",
      "Likely causes: not enough RAM for the current model, a corrupt",
      "model file from an interrupted earlier download, or the model",
      "doesn't support tool calls.",
      "Fix: open the Whoami tab, click 'repair' next to the model to",
      "wipe + re-download cleanly, or 'delete' and pull a smaller tag",
      "(qwen2.5:3b is the M1-safe default).",
      "You can also add a hosted provider key (OpenAI / Anthropic / …)",
      "to bypass local inference entirely.",
    ].join(" ");
  }
  // Model not loaded yet — distinct, friendlier message.
  if (/model.*not found|no such file/i.test(raw)) {
    return "The configured model isn't installed. Open the first-run wizard or run `ollama pull <model>`.";
  }
  return raw;
}

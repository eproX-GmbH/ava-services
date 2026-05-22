import { EventEmitter } from "node:events";
import { randomUUID } from "node:crypto";
import { hasVision } from "@ava/ai-provider";
import type {
  AgentMessage,
  AgentPendingPrompt,
  AgentSendInput,
  AgentSendResult,
  AgentStatus,
  AgentStreamFrame,
  AgentToolCall,
} from "../../shared/types";
import { ToolRegistry } from "./tool-registry";
import { selectToolsForTurn } from "./tool-selection";
import { buildMetaTools, ALWAYS_ON_CORE_TOOL_NAMES } from "./tools/meta";
import type { ConversationToolLoadState } from "./tools/meta";
import { buildSystemPrompt } from "./prompts";
import { UiBridge, type PendingChoice } from "./ui-bridge";
import type { LlmProviderManager, LlmStreamToolCall } from "./providers";
import type { Conversation, Tool, ToolContext } from "./types";
import type { MemoryStore } from "./memory";
import type { LoadedSkill, SkillStore, SkillsPrefsStore } from "../skills";
import {
  autoActivateSkill,
  checkSkillAllowlist,
  parseSlashInvocation,
  renderSkillBody,
} from "../skills";

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
  /**
   * v0.1.161 — General-memory store. When set, the orchestrator injects
   * the most recent N entries into the system prompt under
   * "Langzeitgedächtnis" so the agent ALWAYS sees them, not only when
   * it remembers to call `recall_memory`. The tool stays available for
   * targeted lookups, but the auto-inject closes the failure mode
   * where the agent answers "Ich weiß nichts über dich" despite the
   * store containing entries.
   */
  generalMemoryStore?: {
    list: () => import("./general-memory").GeneralMemoryEntry[];
  };
  /**
   * S2 — User-authored skills store. When set, the orchestrator:
   *   - appends a "Verfügbare Skills" block to the system prompt
   *   - resolves `/skill-name [args]` on the first line of a user
   *     message into an injected user-role message with the body
   *   - auto-activates one skill per turn via crude keyword match
   *     against the description; with or without explicit invocation,
   *     the active skill's `allowedTools` is hard-enforced in runTool.
   */
  skillStore?: SkillStore;
  /**
   * S3 — per-user enabled/disabled state for skills. The orchestrator
   * filters the SkillStore output through this before exposing skills
   * to system-prompt assembly, `/name` resolution, or auto-activation.
   * Optional so test harnesses can skip it entirely.
   */
  skillsPrefs?: SkillsPrefsStore;
  /**
   * v0.1.210 — Callback, das nach jedem fertigen LLM-Turn die
   * Token-Usage in den lokalen UsageStore schreibt. Fire-and-forget;
   * Fehler werden vom Callback selbst verschluckt. `conversationId`
   * wird durchgereicht, damit der Store den Call der richtigen
   * Conversation zuordnet (Drill-down im Verbrauchs-Tab später).
   */
  onUsage?: (args: {
    provider: import("../../shared/types").LlmProviderKind;
    model: string;
    conversationId: string;
    usage: import("./providers/types").LlmUsageSnapshot;
  }) => void;
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
  // v0.1.161 — see AgentOrchestratorOptions.generalMemoryStore.
  private readonly generalMemoryStore:
    | { list: () => import("./general-memory").GeneralMemoryEntry[] }
    | undefined;
  private skillStore: SkillStore | undefined;
  private skillsPrefs: SkillsPrefsStore | undefined;
  /** v0.1.210 — Usage-Sink. Wird vom Provider-Wrapper aufgerufen,
   *  sobald ein Turn beendet ist und der Provider Token-Counts
   *  geliefert hat. */
  private readonly onUsage?: AgentOrchestratorOptions["onUsage"];
  /** Active skill for the in-flight turn (set in send(), read in
   *  runTool() for the allowlist gate + in buildSystemPrompt() for
   *  the active-skill hint). null when no skill is active. */
  private activeSkill: LoadedSkill | null = null;
  /** Coalesce concurrent recovery attempts — multiple in-flight turns
   *  hitting the same crash should only kick one restart. */
  private runtimeRecoverInFlight: Promise<void> | null = null;

  private inFlightRequestId: string | null = null;
  // v0.1.151 — paired with inFlightRequestId so the renderer can ask
  // "is the busy turn for THIS conversation?" after a route remount.
  // Set in send(), cleared in the runLoop().finally so it never lingers
  // past the actual stream lifetime.
  private inFlightConversationId: string | null = null;
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
    this.generalMemoryStore = opts.generalMemoryStore;
    this.skillStore = opts.skillStore;
    this.skillsPrefs = opts.skillsPrefs;
    this.onUsage = opts.onUsage;

    // v0.1.240 — Register the meta-tools (tool_search + tool_load).
    // We do this here (not in tools/index.ts) because the meta-tools
    // need access to the active conversation's load-state, which only
    // the orchestrator tracks. The closure captured below resolves at
    // call-time via `currentLoadState()`.
    for (const t of buildMetaTools({
      registry: this.registry,
      coreToolNames: ALWAYS_ON_CORE_TOOL_NAMES,
      currentLoadState: () => this.currentLoadState(),
    })) {
      this.registry.register(t);
    }

    // Re-emit status when the active provider moves so the renderer's
    // Chat tab can re-enable the input the moment the model is ready.
    // Covers both Ollama lifecycle transitions and OpenAI key changes.
    this.providers.onStatusChanged(() => this.emit("status", this.getStatus()));
  }

  /**
   * Snapshot accessor for the meta-tools (`tool_search` / `tool_load`).
   * Reads/writes go straight against the currently-processed
   * conversation's `loadedToolNames` set. We assume the orchestrator
   * handles one input at a time — the in-flight conversation id is
   * set in `send()` and cleared in the runLoop's finally, so any
   * meta-tool call between those points hits the right convo.
   *
   * If a meta-tool is somehow invoked outside an in-flight turn (race
   * condition during shutdown, future test harness), we return a
   * no-op state instead of throwing — the meta-tool's response will
   * say "nothing happened" and the agent can recover.
   */
  private currentLoadState(): ConversationToolLoadState {
    const noop: ConversationToolLoadState = {
      getLoaded: () => new Set<string>(),
      load: (names) => ({
        loaded: [],
        alreadyLoaded: [],
        unknown: names.slice(),
      }),
    };
    const convoId = this.inFlightConversationId;
    if (!convoId) return noop;
    const convo = this.conversations.get(convoId);
    if (!convo) return noop;
    return {
      getLoaded: () => convo.loadedToolNames ?? new Set<string>(),
      load: (names) => {
        if (!convo.loadedToolNames) convo.loadedToolNames = new Set<string>();
        const loaded: string[] = [];
        const alreadyLoaded: string[] = [];
        const unknown: string[] = [];
        for (const name of names) {
          if (!this.registry.get(name)) {
            unknown.push(name);
            continue;
          }
          if (ALWAYS_ON_CORE_TOOL_NAMES.has(name)) {
            // It's already in the context — treat as "alreadyLoaded"
            // so the agent doesn't get a misleading "loaded" signal.
            alreadyLoaded.push(name);
            continue;
          }
          if (convo.loadedToolNames.has(name)) {
            alreadyLoaded.push(name);
            continue;
          }
          convo.loadedToolNames.add(name);
          loaded.push(name);
        }
        if (loaded.length > 0) {
          console.log(
            `[agent] tool_load: convo=${convoId} loaded=${loaded.join(",")}`,
          );
        }
        return { loaded, alreadyLoaded, unknown };
      },
    };
  }

  /** S2 — late-binding for the SkillStore, because `initSkills(app)` can
   *  only run after `app.whenReady()` while the orchestrator is
   *  constructed eagerly at module top. */
  setSkillStore(store: SkillStore): void {
    this.skillStore = store;
  }

  /** S3 — late-binding for the SkillsPrefsStore (same lifecycle reason
   *  as `setSkillStore`: the store reads userData which isn't valid
   *  until `app.whenReady()`). */
  setSkillsPrefs(prefs: SkillsPrefsStore): void {
    this.skillsPrefs = prefs;
  }

  /** S3 — Skills available to the orchestrator this turn: loaded,
   *  gate-satisfied, and not user-disabled. Used for system-prompt
   *  assembly, `/name` resolution, and auto-activation. */
  private availableSkills(): LoadedSkill[] {
    const all = this.skillStore?.list() ?? [];
    return all.filter((s) => {
      if (!s.gateSatisfied) return false;
      // S4 — only trusted skills fire. Untrusted/modified ones stay
      // in the list so the Settings UI can prompt for re-confirm,
      // but they're invisible to the agent.
      if (s.trust !== "trusted") return false;
      if (this.skillsPrefs && !this.skillsPrefs.isEnabled(s.name)) {
        return false;
      }
      return true;
    });
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
      inFlightConversationId: this.inFlightConversationId,
      errorMessage: this.errorMessage ?? provider.errorMessage,
      memoryError: this.memoryError,
      // v0.1.257 — Vision-Capability für Bild-Anhänge im Chat. False wenn
      // kein Modell konfiguriert oder das Modell laut Catalog keine
      // Bilder kann (z. B. Ollama-llama3.1, Anthropic Haiku-Text-only).
      supportsImages:
        provider.ready && provider.model
          ? hasVision(provider.kind, provider.model)
          : false,
    };
  }

  /**
   * v0.1.151 — list still-open prompts for a conversation. The
   * orchestrator holds pending prompts in `pendingChoices` as long as
   * the originating tool is awaiting an answer; when the Chat
   * component remounts (e.g. after navigating away during a turn) it
   * reads this and re-injects the cards into its message list.
   *
   * Without it: stream frames fire once, the unmounted renderer
   * misses them, and the user comes back to a chat that's still
   * "busy" but with no actionable prompt on screen — a soft hang.
   */
  getPendingPrompts(conversationId: string): AgentPendingPrompt[] {
    const out: AgentPendingPrompt[] = [];
    for (const [choiceId, entry] of this.pendingChoices) {
      if (entry.conversationId !== conversationId) continue;
      if (entry.prompt.kind === "choice-request") {
        out.push({
          kind: "choice-request",
          conversationId: entry.conversationId,
          requestId: entry.requestId,
          choiceId,
          prompt: entry.prompt.prompt,
          options: entry.prompt.options,
        });
      } else {
        out.push({
          kind: "text-request",
          conversationId: entry.conversationId,
          requestId: entry.requestId,
          choiceId,
          prompt: entry.prompt.prompt,
          ...(entry.prompt.placeholder !== undefined
            ? { placeholder: entry.prompt.placeholder }
            : {}),
          ...(entry.prompt.defaultValue !== undefined
            ? { defaultValue: entry.prompt.defaultValue }
            : {}),
          ...(entry.prompt.optional ? { optional: true } : {}),
        });
      }
    }
    return out;
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
      ...(input.images && input.images.length > 0
        ? { images: input.images }
        : {}),
    };
    this.appendMessage(convo, userMessage);

    // S2 — resolve the active skill for this turn. Explicit /name wins
    // (and injects the rendered body as an additional user-role
    // message); otherwise we try the crude description-keyword
    // auto-activation against the last user message.
    this.activeSkill = null;
    // v0.1.186 — tool-slimming. When a slash invocation names a
    // registered TOOL (not a skill), we force it into this turn's
    // tool selection even if it isn't in DEFAULT_RESEARCH_TOOLS.
    // This keeps the slash palette as the universal escape-hatch
    // for tools we hid behind the default to save tokens.
    let slashNudgedTool: string | null = null;
    const skills = this.availableSkills();
    const slash = parseSlashInvocation(input.message);
    if (slash) {
      const target = skills.find((s) => s.name === slash.name);
      if (target && target.userInvocable !== false) {
        this.activeSkill = target;
        // v0.1.240 — Skills bring their declared tool surface with
        // them. We push allowed-tools into the conversation's
        // loaded-set so future turns retain them even after the
        // skill stops being "active".
        this.markToolsLoaded(convo, target.allowedTools);
        const rendered = renderSkillBody(target, slash.rawArgs);
        const injected: AgentMessage = {
          id: randomUUID(),
          role: "user",
          content: `### Skill: ${target.name}\n\n${rendered}`,
          createdAt: Date.now(),
        };
        this.appendMessage(convo, injected);
        console.log(
          `[agent] skill invoked: ${target.name} (allowed-tools: [${target.allowedTools.join(", ")}])`,
        );
      } else if (this.registry.get(slash.name)) {
        // No matching skill, but the slash names a REGISTERED TOOL.
        // Nudge the model to invoke that tool instead of treating the
        // slash like an unknown CLI command. The user's message stays as
        // is so the tool still sees any args it might need.
        slashNudgedTool = slash.name;
        const argsHint = slash.rawArgs.trim()
          ? ` mit den Argumenten: ${slash.rawArgs.trim()}`
          : "";
        const injected: AgentMessage = {
          id: randomUUID(),
          role: "user",
          content:
            `Hinweis: Der Nutzer hat per Slash-Palette das Tool ` +
            `\`${slash.name}\`${argsHint} ausgewählt. Rufe dieses Tool als ` +
            `nächsten Schritt auf. Frag den Nutzer kurz nach fehlenden ` +
            `Pflicht-Argumenten, bevor du das Tool aufrufst, falls die ` +
            `nicht aus dem bisherigen Verlauf hervorgehen. Antworte NICHT ` +
            `mit "Unbekannter Befehl" oder ähnlichem.`,
          createdAt: Date.now(),
        };
        this.appendMessage(convo, injected);
        console.log(`[agent] tool nudged via slash: ${slash.name}`);
      }
    }
    if (!this.activeSkill && skills.length > 0) {
      const auto = autoActivateSkill(skills, input.message);
      if (auto) {
        this.activeSkill = auto;
        // v0.1.240 — same auto-load behaviour as explicit /skill invocations.
        this.markToolsLoaded(convo, auto.allowedTools);
        console.log(
          `[agent] skill auto-activated: ${auto.name} (allowed-tools: [${auto.allowedTools.join(", ")}])`,
        );
      }
    }

    this.inFlightRequestId = requestId;
    this.inFlightConversationId = convo.id;
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
      slashNudgedTool,
    }).finally(() => {
      this.inFlightRequestId = null;
      this.inFlightConversationId = null;
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
    /** v0.1.186 — tool name nudged via slash palette (`/tool_name`)
     *  on the user's last message. Forced into the turn's tool
     *  selection so the slash palette remains an escape-hatch for
     *  tools we hid behind the research default. */
    slashNudgedTool?: string | null;
  }): Promise<void> {
    const { requestId, conversation, provider, signal, slashNudgedTool } = args;

    // v0.1.227 — Tracking pro Turn für den Anti-Loop-Wächter unten:
    // wie oft kam dieselbe (Tool-Name + serialisierte Args)-Kombi vor,
    // und wie oft davon endete sie mit Fehler. Reset bei jedem
    // neuen runLoop-Aufruf, damit Wiederholungen zwischen Turns
    // erlaubt sind, aber innerhalb eines Turns nicht entgleiten.
    const toolCallSignatures = new Map<
      string,
      { count: number; failures: number }
    >();

    try {
      for (let step = 0; step < STEP_BUDGET; step++) {
        // v0.1.241 — Compute the available-tool-name set ONCE here so
        // both buildSystemPrompt() (for the text "Verfügbare Tools"
        // block) and selectToolsForTurn() (for the structured tools[]
        // array) operate on the same scope. Until v0.1.240 the system
        // prompt silently included ALL 120 registered tools as plain
        // text, even though only ~6 were exposed structurally — a
        // ~10k-token leak per turn.
        const availableToolNames = new Set<string>(ALWAYS_ON_CORE_TOOL_NAMES);
        if (conversation.loadedToolNames) {
          for (const n of conversation.loadedToolNames) availableToolNames.add(n);
        }
        if (this.activeSkill) {
          for (const n of this.activeSkill.allowedTools) availableToolNames.add(n);
        }
        if (slashNudgedTool) availableToolNames.add(slashNudgedTool);

        // Build the message log we'll send. The system prompt is rebuilt
        // every turn so a tool registered mid-session would show up — cheap
        // because the registry is small.
        const systemMessage: AgentMessage = {
          id: "__system__",
          role: "system",
          content: buildSystemPrompt(
            this.registry,
            this.profileStore?.get() ?? null,
            {
              skills: this.availableSkills(),
              activeSkill: this.activeSkill,
              // v0.1.161 — fold the long-term memory entries into the
              // system prompt so the agent ALWAYS sees them, not only
              // when it remembers to call `recall_memory`. Capped at
              // 30 entries to keep the prompt manageable; the tool
              // stays available for targeted lookups beyond the cap.
              rememberedFacts: this.generalMemoryStore
                ? this.generalMemoryStore.list().slice(0, 30)
                : [],
              availableToolNames,
            },
          ),
          createdAt: 0,
        };
        const messages = [systemMessage, ...conversation.messages];

        const assistantId = randomUUID();
        let assistantContent = "";
        let collectedToolCalls: LlmStreamToolCall[] | undefined;

        // v0.1.186 — tool-slimming. Skill-bound when a skill is
        // active; curated research default otherwise. Slash-nudged
        // tool (when user typed /tool_name and it matched a tool
        // rather than a skill) is force-added so the palette stays
        // an escape-hatch for hidden tools.
        const turnTools =
          this.registry.size() > 0
            ? selectToolsForTurn({
                registry: this.registry,
                activeSkill: this.activeSkill,
                // v0.1.240 — accumulated lazy-loaded tools from
                // tool_load + skill auto-loads. Survives across turns
                // within the same conversation.
                loadedToolNames: conversation.loadedToolNames,
                extraToolNames: slashNudgedTool ? [slashNudgedTool] : undefined,
              })
            : undefined;
        for await (const frame of provider.streamChat({
          messages,
          tools: turnTools,
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
          // v0.1.210 — Usage einer fertigen Turn (kommt nur auf done-Frame).
          // Fire-and-forget — schluckt Fehler intern, der Chat-Loop läuft
          // weiter, egal ob der Store gerade aufnimmt oder nicht.
          if (frame.usage && this.onUsage) {
            try {
              const status = provider.getStatus();
              this.onUsage({
                provider: status.kind,
                model: status.model ?? "",
                conversationId: conversation.id,
                usage: frame.usage,
              });
            } catch (err) {
              console.warn("[usage] forward to store failed:", err);
            }
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

          // v0.1.227 — Anti-Loop-Wächter. Wenn das LLM denselben
          // Tool-Call mit denselben Args dreimal hintereinander
          // schickt UND mindestens zweimal davon mit Validation- oder
          // Tool-Fehler endete, brechen wir hart ab. Verhindert den
          // klassischen „LLM dreht im Kreis, weil es seinen Misformat
          // nicht erkennt"-Fall, der das Step-Budget aufressen würde.
          const callSignature = `${call.name}::${stableStringify(call.args)}`;
          const sigState = toolCallSignatures.get(callSignature) ?? {
            count: 0,
            failures: 0,
          };
          sigState.count += 1;
          if (sigState.count >= 3 && sigState.failures >= 2) {
            const refusal = {
              ok: false,
              content: JSON.stringify({
                error:
                  `Tool '${call.name}' wurde dreimal mit identischen Argumenten ` +
                  `aufgerufen und ist mindestens zweimal gescheitert. Ich breche ` +
                  `den Versuch ab. Bitte ändere die Argumente oder frag den Nutzer ` +
                  `um Hilfe statt es erneut mit derselben Variante zu versuchen.`,
              }),
              preview: "anti-loop: 3× identical failing tool call",
            };
            this.appendMessage(conversation, {
              id: randomUUID(),
              role: "tool",
              content: refusal.content,
              toolCallId: call.id,
              createdAt: Date.now(),
            });
            this.emitFrame({
              kind: "tool-result",
              requestId,
              conversationId: conversation.id,
              toolCallId: call.id,
              ok: false,
              preview: refusal.preview,
            });
            toolCallSignatures.set(callSignature, sigState);
            continue;
          }

          const result = await this.runTool(
            call,
            signal,
            requestId,
            conversation.id,
          );
          if (!result.ok) sigState.failures += 1;
          toolCallSignatures.set(callSignature, sigState);

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
          " (The local runtime is being restarted automatically. Try sending again in a few seconds.)";
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

  /** v0.1.240 — Add tool names to a conversation's lazy-load set.
   *  Used by skill activation (sync, before the turn). The meta-tool
   *  load path goes through `currentLoadState()` instead. */
  private markToolsLoaded(
    convo: Conversation,
    names: readonly string[],
  ): void {
    if (names.length === 0) return;
    if (!convo.loadedToolNames) convo.loadedToolNames = new Set<string>();
    for (const name of names) {
      // Filter to actually-registered tools to avoid silently keeping
      // ghosts in the set if a skill declares a typo'd tool.
      if (this.registry.get(name)) convo.loadedToolNames.add(name);
    }
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
    // v0.1.293 — Singular-Hallu Auto-Repair. LLMs erfinden gerne
    // naive Singulare wie `companie` (von `companies`), `notese`
    // (von `notes`) etc. Wenn der Tool-Name nicht existiert, aber
    // ein offensichtlich-gemeinter Name existiert, nutzen wir den
    // stattdessen — und loggen den Repair, damit der Agent es bei
    // der nächsten Erwähnung selbst lernt.
    const repaired = this.maybeRepairToolName(call.name);
    if (repaired && repaired !== call.name) {
      console.warn(
        `[orchestrator] tool-name auto-repaired: '${call.name}' → '${repaired}' ` +
          `(LLM-Singular-Hallu)`,
      );
      call = { ...call, name: repaired };
    }
    // S2 — enforced skill tool-allowlist. Runs BEFORE the registry
    // lookup so a refusal message is consistent regardless of whether
    // the tool name is real.
    const guard = checkSkillAllowlist(this.activeSkill, call.name);
    if (!guard.ok) {
      console.warn(
        `[skills] tool-call refused: skill=${this.activeSkill?.name} tool=${call.name}`,
      );
      return {
        ok: false,
        content: JSON.stringify({ error: guard.message }),
        preview: guard.message,
      };
    }

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

  /**
   * v0.1.293 — Auto-Repair für naive LLM-Singular-Hallus auf
   * Tool-Namen. Real-Run (conventic, Mai 2026): LLM ruft
   * `crm_delete_hubspot_companie` weil es `companies` naiv durch
   * "drop trailing s" singularisiert. Korrekter Tool-Name ist
   * `crm_delete_hubspot_company` (siehe SINGULAR-Map in tools/crm.ts).
   *
   * Strategie: simple Suffix-Substitutionen probieren; wenn das
   * Ergebnis in der Registry liegt, returnen wir den repairten
   * Namen. Sonst null (= keine Reparatur möglich, original wird
   * unverändert weitergereicht).
   */
  private maybeRepairToolName(name: string): string | null {
    if (this.registry.get(name)) return null; // existiert bereits
    // Bekannte LLM-Pluralization-Falten. Suffix-basiert, damit es
    // sowohl auf `crm_delete_hubspot_companie` als auch auf
    // hypothetische künftige Tool-Familien greift.
    const REPAIRS: Array<[RegExp, string]> = [
      [/companie$/, "company"], // companies → companie statt company
      [/notese$/, "note"], // notes → notese (selten, aber gesehen)
      [/deale$/, "deal"], // deals → deale
      [/taske$/, "task"], // tasks → taske
      [/contacte$/, "contact"], // contacts → contacte
    ];
    for (const [pattern, replacement] of REPAIRS) {
      if (pattern.test(name)) {
        const candidate = name.replace(pattern, replacement);
        if (this.registry.get(candidate)) {
          return candidate;
        }
      }
    }
    return null;
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
      "(Qwen 3 8B is the entry-level default; needs 16 GB RAM).",
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

/**
 * v0.1.227 — Deterministischer JSON-Stringify für den Anti-Loop-
 * Wächter. Object-Keys werden sortiert, damit `{a:1, b:2}` und
 * `{b:2, a:1}` denselben Hash haben. Sonst würde das LLM mit
 * neu-sortierten Argumenten den Wächter umgehen.
 */
function stableStringify(v: unknown): string {
  if (v === null || typeof v !== "object") return JSON.stringify(v);
  if (Array.isArray(v)) {
    return "[" + v.map(stableStringify).join(",") + "]";
  }
  const obj = v as Record<string, unknown>;
  const keys = Object.keys(obj).sort();
  return (
    "{" +
    keys
      .map((k) => JSON.stringify(k) + ":" + stableStringify(obj[k]))
      .join(",") +
    "}"
  );
}

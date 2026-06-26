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
import { isUserDeclined } from "./define-tool";
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

// v0.1.346 — pro Antwort erlaubte ReAct-Schritte (LLM-Runden mit
// Tool-Calls). War lange 12, was echte Mehrschritt-Aufgaben (CRM-
// Anreicherung über viele Firmen, längere Recherche) hart abwürgte
// („agent step budget exhausted"). Deutlich angehoben; Pathologien
// fängt der Anti-Loop-Wächter (3× identischer fehlschlagender Call) ab,
// und bei Erreichen des Budgets gibt es jetzt einen Graceful Wrap-up
// (Abschluss-Antwort + „weitermachen?") statt eines Fehlers.
const STEP_BUDGET = 80;

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
  /**
   * v0.1.405 — Tages-Token-Limit-Gate. Vor jedem Turn (Chat UND Agent)
   * aufgerufen; liefert den aktuellen Tagesstand. Ist `exceeded === true`,
   * blockt der Orchestrator den Turn und sendet ein Fehler-Frame mit
   * Hinweis auf die Einstellungen. `null` ⇒ Gate übersprungen (z. B. kein
   * Limit gesetzt oder Usage-Store nicht verfügbar).
   */
  checkDailyLimit?: () => Promise<
    import("../../shared/types").DailyTokenLimitStatus | null
  >;
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
  /** v0.1.405 — Tages-Token-Limit-Gate (siehe Options-Doc). */
  private readonly checkDailyLimit?: AgentOrchestratorOptions["checkDailyLimit"];
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
    this.checkDailyLimit = opts.checkDailyLimit;

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
      } else if (entry.prompt.kind === "match-request") {
        out.push({
          kind: "match-request",
          conversationId: entry.conversationId,
          requestId: entry.requestId,
          choiceId,
          prompt: entry.prompt.prompt,
          rows: entry.prompt.rows,
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

  /**
   * v0.1.299 — Externer Trigger für eine Auto-Triage-Conversation
   * (z. B. von MailAgentBridge bei eingehender trusted Mail).
   *
   * Unterscheidet sich von `send()` durch:
   *   - eigene Conversation pro Trigger (kein Re-Use vorhandener IDs)
   *   - kein User-Message-Append; die Mail wird als initialMessage
   *     gesetzt
   *   - autonomousMode=true im Conversation-Meta → System-Prompt
   *     bekommt den Auto-Triage-Block
   *   - skill wird FORCE-aktiviert (kein keyword-auto-activate)
   *
   * Returnt null wenn LLM nicht ready ist. Wenn der Orchestrator
   * gerade einen anderen Request abarbeitet, wird der Trigger gequeuet
   * und nach Beendigung sequenziell abgearbeitet.
   */
  startAutonomousConversation(input: {
    skillName: string;
    initialMessage: string;
    sourceMailId: string;
  }): { conversationId: string; requestId: string } | null {
    const status = this.getStatus();
    if (!status.ready) {
      console.warn(
        "[orchestrator] autonomous trigger refused: LLM not ready",
      );
      return null;
    }
    // Queue wenn busy. Drain im finally-Block des aktuellen runLoop.
    if (this.inFlightRequestId !== null) {
      this.pendingAutonomousQueue.push(input);
      // Cap die Queue auf 20 — falls 100 Mails reinkommen während AVA
      // aus ist, wollen wir nicht ewig nachholen. Älteste verwerfen.
      if (this.pendingAutonomousQueue.length > 20) {
        this.pendingAutonomousQueue.shift();
      }
      console.log(
        `[orchestrator] queued autonomous trigger (was busy, queue=${this.pendingAutonomousQueue.length})`,
      );
      return null;
    }
    return this.runAutonomousNow(input);
  }

  private pendingAutonomousQueue: Array<{
    skillName: string;
    initialMessage: string;
    sourceMailId: string;
  }> = [];

  private runAutonomousNow(input: {
    skillName: string;
    initialMessage: string;
    sourceMailId: string;
  }): { conversationId: string; requestId: string } {
    const conversationId = randomUUID();
    const convo: Conversation = {
      id: conversationId,
      messages: [],
      autonomousMode: true,
      sourceMailId: input.sourceMailId,
      loadedToolNames: new Set(),
    };
    this.conversations.set(conversationId, convo);
    this.memory?.ensureConversation(conversationId);

    // Force-activate skill — kein auto-activate-Heuristik, weil die
    // initialMessage ein roher Mail-Body ist, der die Keyword-Matcher
    // unzuverlässig macht.
    const skills = this.availableSkills();
    const skill = skills.find((s) => s.name === input.skillName);
    if (skill) {
      this.activeSkill = skill;
      this.markToolsLoaded(convo, skill.allowedTools);
      console.log(
        `[orchestrator] autonomous: skill force-activated '${skill.name}' for conv ${conversationId}`,
      );
    } else {
      this.activeSkill = null;
      console.warn(
        `[orchestrator] autonomous: skill '${input.skillName}' not found — running without skill`,
      );
    }

    // Mail-Content als user-role-Message (so sieht der Agent das wie
    // einen User-Prompt). Im System-Prompt steht zusätzlich, dass das
    // ein Auto-Trigger ist.
    const initial: AgentMessage = {
      id: randomUUID(),
      role: "user",
      content: input.initialMessage,
      createdAt: Date.now(),
    };
    this.appendMessage(convo, initial);

    const requestId = randomUUID();
    this.inFlightRequestId = requestId;
    this.inFlightConversationId = convo.id;
    this.errorMessage = null;
    this.emit("status", this.getStatus());

    const abort = new AbortController();
    this.currentAbort = abort;
    const provider = this.providers.activeProvider();

    void this.runLoop({
      requestId,
      conversation: convo,
      provider,
      signal: abort.signal,
      slashNudgedTool: null,
    }).finally(() => {
      this.inFlightRequestId = null;
      this.inFlightConversationId = null;
      this.currentAbort = null;
      this.emit("status", this.getStatus());
      // v0.1.321 — User-Follow-ups ("Sonstiges"-Pfad) haben Vorrang vor
      // autonomen Triggern. Wenn der User waehrend eines Tool-Confirms
      // "Sonstiges" + Freitext gewaehlt hat, ist sein Wunsch der naechste
      // Sprechakt — nicht ein eventuell wartender Cron/Mail-Trigger.
      const followUp = this.pendingFollowUpQueue.shift();
      if (followUp) {
        setTimeout(() => {
          if (this.inFlightRequestId === null) {
            try {
              this.send({
                conversationId: followUp.conversationId,
                message: followUp.message,
              });
            } catch (err) {
              console.warn(
                "[orchestrator] follow-up send failed:",
                err instanceof Error ? err.message : String(err),
              );
            }
          } else {
            this.pendingFollowUpQueue.unshift(followUp);
          }
        }, 250);
        return;
      }
      // Drain Queue: wenn weitere Trigger anstehen, sequenziell starten.
      // Kleine Pause damit User-Input dazwischen-greifen kann.
      const next = this.pendingAutonomousQueue.shift();
      if (next) {
        setTimeout(() => {
          if (this.inFlightRequestId === null) {
            this.runAutonomousNow(next);
          } else {
            // User hat in der Zwischenzeit einen send() gestartet —
            // wieder vorne in die Queue, wird beim nächsten finally
            // erneut versucht.
            this.pendingAutonomousQueue.unshift(next);
          }
        }, 250);
      }
    });

    return { conversationId, requestId };
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
    // v0.1.321 — "Sonstiges"-Pfad: User hat eine eigene Antwort getippt
    // statt einer der Tool-Optionen. Sentinel-Prefix `__user_other__:`
    // signalisiert das. Tool-side bekommt nur den nackten Sentinel
    // ohne Freitext zurueck — die meisten Tools haben `value !== "apply"`-
    // Checks, fallen also brav in den "verworfen"-Branch. Den Freitext
    // selbst injizieren wir als naechste User-Message in die Conversation
    // (queue-basiert, weil das aktuelle inFlightRequest noch laeuft).
    const USER_OTHER_PREFIX = "__user_other__:";
    let resolvedValue = value;
    let followUpText: string | null = null;
    if (value.startsWith(USER_OTHER_PREFIX)) {
      const text = value.slice(USER_OTHER_PREFIX.length).trim();
      if (text.length > 0) followUpText = text;
      resolvedValue = "__user_other__";
    }
    // Emit a resolved frame so the renderer can collapse the ChoiceCard
    // into a static "you picked X" message, even on a different window.
    // Wir senden den ECHTEN Wert (inkl. Freitext) damit das UI das
    // "Du hast geantwortet: ..."-Label richtig anzeigen kann.
    const conv = this.findConversationForRequest(entry.requestId);
    this.emitFrame({
      kind: "choice-resolved",
      requestId: entry.requestId,
      conversationId: conv,
      choiceId,
      value: followUpText ?? resolvedValue,
    });
    entry.resolve(resolvedValue);
    if (followUpText) {
      this.pendingFollowUpQueue.push({
        conversationId: entry.conversationId,
        message: followUpText,
      });
    }
  }

  /**
   * v0.1.321 — Queue fuer User-Sonstiges-Follow-ups. Wird im
   * runLoop-finally gedraint, gleiche Mechanik wie pendingAutonomousQueue.
   * Liegt separat damit User-Inputs Vorrang vor autonomen Triggern haben.
   */
  private pendingFollowUpQueue: Array<{
    conversationId: string;
    message: string;
  }> = [];

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

    // v0.1.375 — Pro Turn: Tools, deren Aktion der Nutzer im Confirm-Dialog
    // bereits ABGELEHNT hat. Lehnt der Nutzer z. B. „Company anlegen" ab,
    // versuchte der Agent es vorher 2–3× erneut (auch mit leicht anderen
    // Args) und interpretierte das nackte `{ applied: false }` als stillen
    // Fehler. Jetzt sperren wir Wiederholungen desselben Tools im selben
    // Turn hart — eine Ablehnung muss beim ersten Mal greifen. Reset bei
    // jedem neuen Turn (= neue User-Nachricht), damit ein späteres „doch,
    // leg sie an" wieder erlaubt ist.
    const declinedTools = new Set<string>();

    // v0.1.346 — last system message built in the loop, reused for the
    // graceful wrap-up turn if the step budget is reached.
    let lastSystemMessage: AgentMessage | null = null;

    try {
      // v0.1.405 — Tages-Token-Limit-Gate. Gilt für Chat UND Agent (beide
      // laufen durch runLoop). Die Anfrage, die das Limit überschreitet,
      // lief bereits (Usage lag bei ihrem Start noch darunter) und wurde
      // voll zu Ende gebracht; HIER wird die NÄCHSTE Anfrage geblockt,
      // sobald der Tagesverbrauch das Limit erreicht hat — mit klarer
      // Meldung + Verweis auf die Einstellungen.
      if (this.checkDailyLimit) {
        let limitStatus: import("../../shared/types").DailyTokenLimitStatus | null =
          null;
        try {
          limitStatus = await this.checkDailyLimit();
        } catch (err) {
          // Limit-Abfrage darf den Chat nie blockieren, wenn sie selbst
          // scheitert (z. B. Usage-Store noch nicht hochgefahren).
          console.warn("[agent] daily-limit check failed:", err);
        }
        if (limitStatus && limitStatus.exceeded && limitStatus.limit !== null) {
          this.errorMessage =
            `Tägliches Token-Limit aufgebraucht ` +
            `(${limitStatus.usedToday.toLocaleString("de-DE")} von ` +
            `${limitStatus.limit.toLocaleString("de-DE")} Tokens heute). ` +
            `Neue Anfragen sind pausiert, bis du das Limit unter ` +
            `Einstellungen → Verbrauch erhöhst oder entfernst.`;
          this.emitFrame({
            kind: "error",
            requestId,
            conversationId: conversation.id,
            message: this.errorMessage,
          });
          this.emit("status", this.getStatus());
          return;
        }
      }

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
              // v0.1.299 — Auto-Triage-Modus aktiviert ein zusätzliches
              // Verhaltens-Block im System-Prompt (kein ask_user_*,
              // direkt handeln, Reply-Loop-Schutz).
              autonomousMode: conversation.autonomousMode === true,
            },
          ),
          createdAt: 0,
        };
        lastSystemMessage = systemMessage;
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

          // v0.1.375 — Decline-Wächter. Hat der Nutzer die Aktion dieses
          // Tools in diesem Turn schon im Confirm-Dialog abgelehnt, führen
          // wir es NICHT erneut aus (auch nicht mit veränderten Args).
          // Eine Ablehnung muss beim ERSTEN Mal greifen — vorher hakte der
          // Agent 2–3× nach.
          if (declinedTools.has(call.name)) {
            const msg =
              `Der Nutzer hat die Aktion von '${call.name}' in diesem ` +
              `Verlauf bereits im Bestätigungsdialog ABGELEHNT. Ich führe ` +
              `sie nicht erneut aus. Frag NICHT noch einmal nach demselben ` +
              `und versuche es nicht mit veränderten Argumenten. Bestätige ` +
              `die Ablehnung und mach mit dem Rest der Aufgabe weiter oder ` +
              `frag, was der Nutzer stattdessen möchte.`;
            this.appendMessage(conversation, {
              id: randomUUID(),
              role: "tool",
              content: JSON.stringify({ error: msg, userDeclined: true }),
              toolCallId: call.id,
              createdAt: Date.now(),
            });
            this.emitFrame({
              kind: "tool-result",
              requestId,
              conversationId: conversation.id,
              toolCallId: call.id,
              ok: false,
              preview: `${call.name}: vom Nutzer bereits abgelehnt`,
            });
            continue;
          }

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
            conversation.autonomousMode === true,
          );
          if (!result.ok) sigState.failures += 1;
          toolCallSignatures.set(callSignature, sigState);
          // v0.1.375 — Ablehnung merken, damit ein erneuter Aufruf desselben
          // Tools in diesem Turn oben hart abgefangen wird.
          if (result.declined) declinedTools.add(call.name);

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

      // v0.1.346 — Step-Budget erreicht. Statt zu werfen (was die ganze
      // bisherige Arbeit dieses Turns verwerfen würde) machen wir EINEN
      // finalen Turn OHNE Tools: das Modell wird gezwungen, eine echte
      // Abschluss-Antwort zu geben — was erledigt wurde, was offen ist,
      // und ob es weitermachen soll. Der Nutzer kann einfach „weiter"
      // sagen; der nächste Turn setzt mit frischem Budget auf der vollen
      // Tool-Historie fort. So wird das Limit zum Checkpoint, nicht zur
      // Wand.
      const wrapUpId = randomUUID();
      let wrapUpContent = "";
      const wrapUpNudge: AgentMessage = {
        id: "__wrapup__",
        role: "user",
        content:
          `[System: Du hast das Schritt-Limit für diese Antwort erreicht ` +
          `(${STEP_BUDGET} Schritte). Rufe KEINE weiteren Tools auf. Fasse ` +
          `jetzt knapp zusammen, was du in diesem Durchgang erledigt hast ` +
          `und was noch offen ist, und biete an weiterzumachen (z. B. „Sag ` +
          `‚weiter', dann mache ich dort weiter."). Antworte normal auf ` +
          `Deutsch.]`,
        createdAt: Date.now(),
      };
      const wrapUpMessages = lastSystemMessage
        ? [lastSystemMessage, ...conversation.messages, wrapUpNudge]
        : [...conversation.messages, wrapUpNudge];
      for await (const frame of provider.streamChat({
        messages: wrapUpMessages,
        tools: undefined, // keine Tools → erzwingt eine Text-Antwort
        signal,
      })) {
        if (frame.errorMessage) throw new Error(frame.errorMessage);
        if (frame.contentDelta && frame.contentDelta.length > 0) {
          wrapUpContent += frame.contentDelta;
          this.emitFrame({
            kind: "token",
            requestId,
            conversationId: conversation.id,
            messageId: wrapUpId,
            delta: frame.contentDelta,
          });
        }
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
      // Sicherheitsnetz: hat das Modell nichts geliefert, eine
      // verständliche Standard-Antwort senden (statt Leer-Bubble).
      if (!wrapUpContent.trim()) {
        wrapUpContent =
          `Ich habe das Schritt-Limit (${STEP_BUDGET}) für diese Antwort ` +
          `erreicht und mehrere Schritte ausgeführt, die Aufgabe ist aber ` +
          `noch nicht ganz fertig. Sag „weiter", dann mache ich dort ` +
          `weiter, wo ich aufgehört habe.`;
        this.emitFrame({
          kind: "token",
          requestId,
          conversationId: conversation.id,
          messageId: wrapUpId,
          delta: wrapUpContent,
        });
      }
      this.appendMessage(conversation, {
        id: wrapUpId,
        role: "assistant",
        content: wrapUpContent,
        createdAt: Date.now(),
      });
      this.emitFrame({
        kind: "done",
        requestId,
        conversationId: conversation.id,
        messageId: wrapUpId,
      });
      return;
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
    autonomousMode: boolean = false,
  ): Promise<{
    ok: boolean;
    content: string;
    preview: string;
    /** v0.1.375 — true, wenn der Nutzer die Aktion im Confirm-Dialog ablehnte. */
    declined?: boolean;
  }> {
    // v0.1.299 — Im Auto-Triage-Modus die ask_user_*-Tools hart
    // sperren BEVOR wir in Allowlist/Repair-Logik einsteigen. Sonst
    // würde der Agent in pendingChoices warten und nie zurückkehren
    // (kein User da, der antwortet).
    if (
      autonomousMode &&
      (call.name === "ask_user_choice" || call.name === "ask_user_text")
    ) {
      const msg =
        `Du bist im Auto-Triage-Modus (eingehende trusted Mail). ` +
        `${call.name} ist in diesem Modus NICHT erlaubt — es gibt keinen ` +
        `User, der antworten könnte. Triff die Entscheidung selbst anhand ` +
        `der vorliegenden Daten und Tool-Outputs. Wenn dir wirklich Infos ` +
        `fehlen, antworte trotzdem mit dem was du weißt und merk an, was ` +
        `unklar war — der User kann später nachjustieren.`;
      console.warn(
        `[orchestrator] auto-triage: blocked '${call.name}' (no user available)`,
      );
      return {
        ok: false,
        content: JSON.stringify({ error: msg }),
        preview: `${call.name} blockiert (Auto-Modus)`,
      };
    }
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
    // S2 — skill tool-allowlist. Ursprünglich hart erzwungen, seit
    // v0.1.312 NUR noch im autonomen Modus (Cron / Auto-Triage). In
    // interaktiven Chat-Sessions ist der User anwesend und kann jede
    // Aktion explizit verantworten — eine Skill-Sandbox, die selbst
    // nach User-Confirm noch blockt, ist dort kafkaesk (real beobachtet
    // bei `scheduled-mail-loop` der `mail_send`/`mail_reply`
    // blockierte, obwohl der User explizit "send anyway" geklickt
    // hatte). Allowed-tools bleiben relevant für:
    //   - Anthropic-Tool-Surface-Pruning (siehe markToolsLoaded oben),
    //     damit der Skill ein fokussiertes Tool-Set sieht.
    //   - Autonome Sessions, wo niemand "send anyway" klicken kann.
    if (autonomousMode) {
      const guard = checkSkillAllowlist(this.activeSkill, call.name);
      if (!guard.ok) {
        console.warn(
          `[skills] tool-call refused (autonomous): skill=${this.activeSkill?.name} tool=${call.name}`,
        );
        return {
          ok: false,
          content: JSON.stringify({ error: guard.message }),
          preview: guard.message,
        };
      }
    } else if (this.activeSkill) {
      const guard = checkSkillAllowlist(this.activeSkill, call.name);
      if (!guard.ok) {
        // Nicht blocken — nur loggen, damit wir im Telemetry sehen
        // welche Skills regelmäßig "leaken". Wenn ein Skill in
        // interaktiven Sessions ständig out-of-scope-Tools braucht,
        // ist die allowed-tools-Liste zu eng.
        console.info(
          `[skills] tool-call allowed despite allowlist (interactive): skill=${this.activeSkill.name} tool=${call.name}`,
        );
      }
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
      autonomousMode,
    );
    const ctx: ToolContext = {
      signal,
      log: (m) => console.log(`[agent:tool:${call.name}] ${m}`),
      ui,
      // v0.1.299 — Tools können den Flag prüfen, z. B. um Confirm-Gates
      // zu skippen (mail_send sendet im Auto-Modus direkt auch an
      // nicht-trusted Empfänger NICHT — sondern wirft hart) oder um
      // ihren Default-Pfad zu wählen.
      autonomousMode,
    };
    try {
      const parsed = tool.parseArgs(call.args);
      const result = await tool.run(parsed, ctx);
      return {
        ok: true,
        content: JSON.stringify(result),
        preview: tool.preview(result),
        ...(isUserDeclined(result) ? { declined: true } : {}),
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

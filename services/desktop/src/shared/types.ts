// Types shared across the main / preload / renderer boundaries.
//
// Each tsconfig project (node vs web) is sealed off from the other, so
// any type that crosses the boundary lives here and gets imported via
// type-only imports on both sides.

export interface AppConfig {
  gatewayUrl: string;
  /** OIDC issuer URL — surfaced for the Settings panel "About" view. */
  authIssuer: string;
  /** OIDC public client id — bundled in plain text by design. */
  authClientId: string;
  /** Auto-update channel ("latest" | "beta" | "alpha"). */
  updateChannel: "latest" | "beta" | "alpha";
  /** Build version stamped from package.json at runtime. */
  appVersion: string;
  /** True when the build is running under electron-vite dev (never in .dmg/.exe). */
  isDev: boolean;
}

export interface AuthStatus {
  signedIn: boolean;
  accessToken: string | null;
  expiresAt: number | null;
  // Decoded for UI display only; gateway re-verifies the JWT signature.
  actorId: string | null;
  tenantId: string | null;
  scopes: string[];
}

// ---- Postgres (8.v1.0 — bundled local DB) ---------------------------------
//
// The desktop app spawns a portable PostgreSQL 17 binary as a child
// process bound to 127.0.0.1:<port>. The producer services that join in
// 8.v1.2+ each get their own database in this single instance and
// connect via DATABASE_URL=postgres://postgres@127.0.0.1:port/<db>. The
// renderer never talks SQL — it only reads supervisor state via IPC
// to drive the "Local DB" status row in Settings.

/**
 * Lifecycle of the bundled Postgres child process.
 *  - `idle`: not started yet
 *  - `initializing`: first-launch initdb running (creates data dir
 *    layout, the system catalog, etc. — takes ~5s on a Mac)
 *  - `starting`: postgres spawned, waiting for the loopback port to
 *    answer pg_isready
 *  - `ready`: pg_isready returned `accepting connections`
 *  - `error`: initdb / spawn / health-check failed
 *  - `stopping`: graceful shutdown in flight (SIGTERM → wait)
 */
export type PostgresSupervisorState =
  | "idle"
  | "initializing"
  | "starting"
  | "ready"
  | "error"
  | "stopping";

export interface PostgresStatus {
  state: PostgresSupervisorState;
  /** Loopback URL once `ready`, e.g. "postgres://postgres@127.0.0.1:54329". */
  host: string | null;
  /** Bound port — null until `ready`. */
  port: number | null;
  /** Absolute path to the data directory under userData. */
  dataDir: string | null;
  /** Server version string from `postgres --version`, e.g. "17.5". */
  version: string | null;
  /** Last error message (only set when state === "error"). */
  errorMessage: string | null;
}

// ---- Ollama (D7 — bundled runtime) -----------------------------------------
//
// The desktop app spawns Ollama as a child process. The renderer never talks
// to Ollama directly — it only reads supervisor state via IPC and triggers
// model pulls through IPC. Local LLM/embedding calls go through the
// db-gateway, which itself hits the supervisor's loopback port.

/** Role a model fills in the AVA pipeline (D8 ai-provider factory). */
export type OllamaModelRole = "llm" | "embed";

export interface OllamaModelSpec {
  /** Tag passed to `ollama pull` and used in API calls. */
  name: string;
  role: OllamaModelRole;
  /** Approximate on-disk size for UX progress hints. */
  approxBytes: number;
}

export interface OllamaInstalledModel {
  name: string;
  size: number;
  digest: string;
  modifiedAt: string;
}

/**
 * Lifecycle of the bundled child process.
 *  - `idle`: not started yet (pre-app.whenReady)
 *  - `starting`: spawn in flight, waiting for `/api/tags` 200
 *  - `ready`: server responding, model list fetched at least once
 *  - `error`: spawn failed or health-check timed out (renderer should
 *    show a recovery screen — not a fatal exit, the rest of the app still
 *    works against any cloud-only fallback the gateway permits)
 *  - `stopping`: graceful shutdown in progress
 */
export type OllamaSupervisorState =
  | "idle"
  | "starting"
  | "ready"
  | "error"
  | "stopping";

export interface OllamaStatus {
  state: OllamaSupervisorState;
  /** http URL the child process is listening on, e.g. "http://127.0.0.1:11434". */
  host: string | null;
  /** Required models the supervisor knows about (catalog, not what's installed). */
  required: OllamaModelSpec[];
  /** What Ollama reports as installed. Empty array until first `ready`. */
  installed: OllamaInstalledModel[];
  /** Subset of `required` that is missing from `installed`. */
  missing: OllamaModelSpec[];
  /** Last error message (only set when state === "error"). */
  errorMessage: string | null;
}

/**
 * One frame of pull progress, mirroring the Ollama `/api/pull` stream
 * shape. The supervisor coalesces frames at ~5 Hz before forwarding to
 * renderer to keep IPC traffic bounded.
 */
export interface OllamaPullProgress {
  modelName: string;
  status: string;
  /** When known (during the actual download), bytes pulled so far. */
  completed?: number;
  /** When known, total bytes to pull. */
  total?: number;
  /** True on the final frame for this model. */
  done: boolean;
  /** Set on the final frame iff the pull failed. */
  errorMessage?: string;
  /**
   * Retry telemetry (Phase 8.k10d). When the supervisor's retry harness
   * is between attempts (sleeping a backoff window), it emits a frame
   * with `retrying: true` so the dock can render "Reconnecting (attempt
   * 2/5)…" instead of "Failed". `attempt` / `maxAttempts` are also set
   * on regular progress frames once the second attempt or later starts,
   * so the user can see e.g. "(attempt 3/5)" alongside the bytes line
   * even when the stream is making forward progress again.
   */
  retrying?: boolean;
  attempt?: number;
  maxAttempts?: number;
}

// ---- Agent (Phase 8) -------------------------------------------------------
//
// The local research agent. Lives in the main process; renderer only sends
// user turns and receives streamed frames over IPC. Memory persists to
// markdown files under `app.getPath("userData")/memory/` (8.d).
//
// Multi-turn conversations are addressed by a `conversationId` (opaque
// string, generated client-side). 8.a only supports one in-flight request
// at a time per orchestrator — a second `send` while one is running rejects.

/** Status snapshot, queried on app boot and after model/Ollama transitions. */
export interface AgentStatus {
  /** True iff the orchestrator can accept a new send (Ollama ready, model picked). */
  ready: boolean;
  /** The Ollama tag the agent will send to /api/chat. Null if no llm-role model. */
  model: string | null;
  /** Mirrors OllamaSupervisor.host — null while the supervisor isn't ready. */
  ollamaHost: string | null;
  /** Set while a send is being processed (single-slot in 8.a). */
  inFlightRequestId: string | null;
  /** Last error message, if the orchestrator is in a sticky-error state. */
  errorMessage: string | null;
  /**
   * Set when the on-disk memory dir (`userData/agent/memory`) failed its
   * boot-time writability probe (Phase 8.d). The agent still functions
   * (in-memory only) but the FirstRunWizard surfaces this so the user
   * knows transcripts won't survive a restart.
   */
  memoryError: string | null;
}

/**
 * One chat turn. Mirrors Ollama /api/chat's role taxonomy plus a `tool`
 * role for tool-call results that the orchestrator feeds back into the
 * model on the next loop iteration.
 *
 * `id` is generated by the orchestrator so the renderer can de-dupe and
 * the markdown log (8.d) can reference messages stably.
 */
export interface AgentMessage {
  id: string;
  role: "system" | "user" | "assistant" | "tool";
  content: string;
  /** Tool calls the assistant decided to make (if any). 8.b+ populates this. */
  toolCalls?: AgentToolCall[];
  /** When role==="tool", which tool call this message answers. */
  toolCallId?: string;
  /** Wall-clock ms since epoch — for log ordering and UI timestamps. */
  createdAt: number;
}

export interface AgentToolCall {
  id: string;
  name: string;
  /** Already-validated arguments. The orchestrator runs yup on the raw args
   *  before populating this; if validation fails the orchestrator emits an
   *  error frame instead of executing. */
  args: unknown;
}

export interface AgentSendInput {
  conversationId: string;
  /** User-typed text. */
  message: string;
}

export interface AgentSendResult {
  requestId: string;
}

/**
 * One option in an `ask_user_choice` prompt (8.c). `value` is the stable
 * machine-readable token the agent gets back; `label` is what the user
 * sees on the button.
 */
export interface AgentChoiceOption {
  value: string;
  label: string;
  /** Optional secondary text rendered under the label. */
  description?: string;
}

/**
 * Streaming frame multiplexed over a single IPC channel. The renderer
 * filters by `requestId` (8.a uses one request at a time, but the protocol
 * is future-proof for parallel runs).
 *
 * Frame types:
 *  - `token`           — content delta from the assistant. Concatenate to render.
 *  - `tool-call`       — assistant decided to call a tool (preview before run).
 *  - `tool-result`     — tool finished; carries the result preview.
 *  - `choice-request`  — UI tool asks the user to pick an option (8.c).
 *                        Renderer answers via `window.api.agent.answerChoice`.
 *  - `choice-resolved` — emitted after the user picked, so other windows /
 *                        replays know the prompt is closed.
 *  - `text-request`    — UI tool asks for free-form text (e.g. transaction
 *                        name during Excel import). Same answer channel as
 *                        `choice-request` — `value` is the typed string,
 *                        empty when the user skipped an `optional` prompt.
 *  - `navigate`        — UI tool tells the renderer to route somewhere (8.c).
 *  - `error`           — terminal; the request is aborted.
 *  - `done`            — terminal; the assistant finished its turn cleanly.
 */
export type AgentStreamFrame =
  | { kind: "token"; requestId: string; conversationId: string; messageId: string; delta: string }
  | { kind: "tool-call"; requestId: string; conversationId: string; toolCall: AgentToolCall }
  | { kind: "tool-result"; requestId: string; conversationId: string; toolCallId: string; ok: boolean; preview: string }
  | {
      kind: "choice-request";
      requestId: string;
      conversationId: string;
      choiceId: string;
      prompt: string;
      options: AgentChoiceOption[];
    }
  | {
      kind: "choice-resolved";
      requestId: string;
      conversationId: string;
      choiceId: string;
      value: string;
    }
  | {
      kind: "text-request";
      requestId: string;
      conversationId: string;
      choiceId: string;
      prompt: string;
      placeholder?: string;
      defaultValue?: string;
      optional?: boolean;
    }
  | { kind: "navigate"; requestId: string; conversationId: string; path: string }
  | { kind: "error"; requestId: string; conversationId: string; message: string }
  | { kind: "done"; requestId: string; conversationId: string; messageId: string };

/** Renderer → main. Resolves a pending `choice-request`. */
export interface AgentChoiceAnswer {
  choiceId: string;
  value: string;
}

// ---- Provider switch (Phase 8.j + 8.k) -------------------------------------
//
// The agent runs against one of five providers, three of which require an
// API key. The selection persists in `userData/agent/provider.json`; each
// hosted provider's key is encrypted via Electron's `safeStorage` and
// lives in `userData/agent/<provider>.enc`.
//
// Providers wrapped via Vercel AI SDK through `@ava/ai-provider` (Phase
// 8.k1). Adding a sixth provider means: pick its model from the shared
// catalog, add a kind below, add a `runtime.ts` branch in ai-provider —
// no orchestrator or UI changes.

export type LlmProviderKind =
  | "ollama"
  | "openai"
  | "anthropic"
  | "google"
  | "mistral";

/** Subset that requires an API key — used by the key-storage UIs. */
export type HostedProviderKind = Exclude<LlmProviderKind, "ollama">;

export interface ProviderConfig {
  /** Currently active provider for new turns. */
  kind: LlmProviderKind;
  /**
   * Selected model id per provider. Always present so flipping providers
   * doesn't drop the user's prior model choice. Empty string for a kind
   * means "use catalog recommendation".
   */
  models: Record<LlmProviderKind, string>;
}

export interface ProviderStatusSnapshot {
  kind: LlmProviderKind;
  model: string | null;
  ready: boolean;
  errorMessage: string | null;
}

export interface ProviderConfigBundle {
  config: ProviderConfig;
  status: ProviderStatusSnapshot;
  /** Per-provider key presence. ollama is always `true` (no key needed). */
  hasKey: Record<LlmProviderKind, boolean>;
  encryptionAvailable: boolean;
}

/**
 * Catalog entry projected over IPC for the renderer's model picker.
 * Mirrors `CatalogEntry` from `@ava/ai-provider/catalog` but stays a
 * plain JSON shape so the renderer doesn't import the package directly.
 */
export interface ProviderCatalogEntry {
  provider: LlmProviderKind;
  id: string;
  label: string;
  /**
   * Capabilities the agent picker filters on. The shared catalog tracks
   * more (vision, embedding dimensions, …) but the desktop only needs
   * "can I use this for the chat agent".
   */
  tools: boolean;
  vision: boolean;
  contextWindow: number;
  costClass: "free" | "cheap" | "mid" | "high";
  recommended: boolean;
  /** Approximate on-disk size for Ollama tags — UX hint only. */
  approxBytes?: number;
}

/**
 * Result of an API-key probe (Phase 8.k10b). The validator hits the
 * provider's cheapest auth-checked endpoint and reports whether the key
 * works. `reason` is a short user-facing string for the failure case
 * (e.g. "OpenAI rejected the key (invalid).") — distinct enough that
 * the UI can decide between "wrong key" and "you're offline" without
 * parsing it. See validate-key.ts for the per-provider probes.
 */
export type ApiKeyValidation =
  | { ok: true }
  | { ok: false; reason: string };

// ---- Heartbeat alerts (Phase 8.f1) -----------------------------------------
//
// The agent runs a background sweep every few minutes and decides whether
// any newly-processed company data is worth alerting the user about. Each
// surviving signal is persisted as an `Alert` row; the renderer reads
// them via `window.api.alerts.*` and surfaces them in the `/alerts` route
// (8.f1) plus a topbar bell + popover (8.f2) and native OS push (8.f3).

export type AlertSeverity = "info" | "warn" | "urgent";

/**
 * Source-of-truth taxonomy for alert kinds. Keeps the renderer's
 * severity-icon and route-deep-link logic finite. New upstreams plug in
 * by adding a kind here + a renderer mapping.
 */
export type AlertKind =
  | "publication"      // company press / news item
  | "financial-delta"  // YoY revenue / profit swing
  | "profile-change"   // master-data fact changed (address, leadership, …)
  | "evaluation-flag"; // an LLM evaluation flagged something noteworthy

export interface Alert {
  id: string;
  tenantId: string | null;
  companyId: string;
  /** Denormalised so the list view works even when offline. */
  companyName: string;
  kind: AlertKind;
  severity: AlertSeverity;
  /** German, ≤120 chars. The one-liner the bell + list show. */
  headline: string;
  /** German, ≤500 chars. Why the agent thought it was worth surfacing. */
  rationale: string;
  /**
   * Stable dedup key built from (kind, companyId, source-specific hash).
   * The store refuses to insert a second row with the same value.
   */
  sourceRef: string;
  /** ISO-8601. */
  createdAt: string;
  /** ISO-8601 when the user marked it as read; null = unread. */
  seenAt: string | null;
  /** ISO-8601 when the user dismissed it; dismissed rows are hidden. */
  dismissedAt: string | null;
}

/**
 * Heartbeat cadence options (Phase 8.f3). Minutes; 0 = aus (heartbeat
 * paused; user can still trigger manually). Constrained to a finite set
 * so the Settings UI can render a radio group without free-form input.
 */
export type AlertCadenceMinutes = 0 | 5 | 15 | 30 | 60;

/**
 * Local-time window during which native OS push notifications are
 * suppressed. Both ends are minutes-since-midnight in the local
 * timezone. A wrap-around window (e.g. 19:00–07:00) is supported and
 * treated as "any time outside [end, start)".
 */
export interface QuietHoursConfig {
  enabled: boolean;
  /** Inclusive start; minutes since local-midnight. Default 19:00 = 1140. */
  startMinute: number;
  /** Exclusive end; minutes since local-midnight. Default 07:00 = 420. */
  endMinute: number;
  /** When true, push is silenced for the entire weekend regardless of the
   *  start/end window. */
  silenceWeekends: boolean;
}

/**
 * User-configurable preferences for the heartbeat + native push (8.f3).
 * Persisted to `userData/agent/alert-prefs.json` with atomic writes.
 */
export interface AlertPrefs {
  cadenceMinutes: AlertCadenceMinutes;
  pushEnabled: boolean;
  /** Push only fires when alert.severity >= this threshold. */
  pushSeverityThreshold: AlertSeverity;
  quietHours: QuietHoursConfig;
}

/**
 * Permission status for OS-native notifications. macOS gates push behind
 * a system prompt the user can deny; Windows / Linux generally allow it
 * once the app is granted notification rights via OS settings. The
 * renderer reads this to disable the toggle when push is blocked.
 */
export interface NotificationPermissionStatus {
  /** True iff `new Notification(…)` would actually display something. */
  available: boolean;
  /** Free-form German reason when unavailable; rendered as a hint. */
  reason: string | null;
}

/**
 * Per-candidate outcome captured during a heartbeat tick (Phase 8.f3).
 * Mirrors the same-named type in `src/main/agent/heartbeat.ts` — kept in
 * shared so the preload bridge and renderer can consume it without
 * reaching into main-only code.
 */
export type AlertDecisionOutcome =
  | "alerted"
  | "duplicate"
  | "not-worth"
  | "judge-error";

export interface AlertCandidateDecision {
  kind: AlertKind;
  companyId: string;
  companyName: string;
  sourceRef: string;
  /** ISO-8601 of the underlying event ("when did this happen?"). */
  occurredAt: string;
  summary: string;
  outcome: AlertDecisionOutcome;
  /** Severity is only meaningful when outcome === "alerted". */
  severity?: AlertSeverity;
  /** German one-liner; ≤280 chars. The LLM's reasoning when reachable,
   *  otherwise an internal explanation ("bereits gemeldet" etc.). */
  rationale: string;
}

export interface AlertTickInfo {
  startedAt: string;
  finishedAt: string;
  candidatesSeen: number;
  alertsCreated: number;
  duplicates: number;
  skipped: boolean;
  reason?: string;
  decisions: AlertCandidateDecision[];
}

// ---- Freshness scheduler (Phase 8.r) ---------------------------------------
//
// Periodic scan that walks the pipeline matrices for each transaction
// and identifies (companyId, stage) cells that have aged past their
// configured cadence. 8.r1 logs candidates only (dry-run); 8.r2 turns
// on actual dispatches via `/transactions/:id/entities/:cid/retry`.

/**
 * Pipeline stages the scheduler considers. `masterData` is excluded
 * intentionally — it's the canonical record the rest are derived from,
 * not a refreshable derivative. `companyEvaluation` is a derived view
 * that benefits from a cadence longer than its inputs.
 */
export type FreshnessStage =
  | "structuredContent"
  | "companyPublication"
  | "website"
  | "companyProfile"
  | "companyContact"
  | "companyEvaluation";

/**
 * Per-stage cadence in days. `0` = never auto-refresh (manual retries
 * still work). The defaults in `freshness-prefs-store.ts` reflect the
 * user-anchored values from §8.r: weekly for contact / profile /
 * website, monthly for structured content, ~quarterly for publications.
 */
export type FreshnessCadenceDays = number;

export interface FreshnessPrefs {
  /** Master toggle. When false, ticks short-circuit; manual triggers still work. */
  enabled: boolean;
  /** Days between refreshes per stage. 0 = aus. */
  cadenceDays: Record<FreshnessStage, FreshnessCadenceDays>;
  /** Hard ceilings to avoid blasting producers. */
  throttle: {
    perStagePerHour: number;
    globalPerHour: number;
  };
  /** Number of rows the scheduler dispatches per tick (cap; the throttle
   *  may shrink this further). 8.r1 still respects it for the dry-run
   *  log — keeps the surface tight when there are 200+ stale cells. */
  topKPerTick: number;
  /** companyIds whose stale cells skip the score and float to the top. */
  pinned: string[];
}

/**
 * One row of the staleness queue. Scored, sorted, and (in 8.r2) acted on.
 * Surfaced in `FreshnessTickInfo.candidates` for the dry-run log.
 */
export interface StalenessRow {
  companyId: string;
  companyName: string | null;
  /** Originating transactionId — needed by the future retry call. The
   *  same companyId may appear in multiple transactions; we pick the
   *  most recent one so re-dispatch hits a transaction the user
   *  actually still cares about. */
  transactionId: string;
  stage: FreshnessStage;
  /** Cell `updatedAt` last seen on the pipeline matrix. `null` when
   *  the producer never ran (state == "pending" with no timestamp). */
  lastUpdatedAt: string | null;
  /** Days between `lastUpdatedAt` (or "never" → very large) and now. */
  daysSinceLastRun: number;
  /** Configured cadence for this stage at the time of the scan. */
  cadenceDays: number;
  /** Final priority score; higher = more overdue. Sorted desc. */
  score: number;
  /** Truthy when the company is in the prefs `pinned` list — pinned
   *  rows always sort to the top regardless of score. */
  pinned: boolean;
}

/** Per-tick diagnostic info, mirrors `AlertTickInfo` for transparency. */
export interface FreshnessTickInfo {
  startedAt: string;
  finishedAt: string;
  /** True when the loop short-circuited (toggle off, throttle ceiling,
   *  no transactions, …). `reason` carries the why. */
  skipped: boolean;
  reason?: string;
  /** Total cells inspected across every transaction this tick. */
  cellsInspected: number;
  /** How many of those cells were over their cadence threshold. */
  staleFound: number;
  /** Top-K candidates sorted by score (desc). The dry-run log surfaces
   *  this; 8.r2 calls `retry_stage` for the head of the list under
   *  the throttle. */
  candidates: StalenessRow[];
  /** Stages that would have dispatched if 8.r2 were enabled.
   *  Always empty in 8.r1 (dry-run). */
  dispatched: Array<{ companyId: string; stage: FreshnessStage }>;
}

// ---- Voice mode (Phase 8.n) ------------------------------------------------
//
// Local STT via a bundled whisper.cpp sidecar + Distil-Whisper-DE GGUF
// (per the §8.n research). The renderer never spawns the child
// process — main/voice/whisper-sidecar.ts owns it, and the renderer
// drives audio capture + UI off this status snapshot.
//
// 8.n1 ships the bundling pipeline + model-download UX with the
// transcription path stubbed. 8.n2 wires real audio capture +
// the actual `whisper.cpp` invocation; 8.n3 adds opt-in auto-VAD.

/** Lifecycle of the bundled sidecar / GGUF on disk. */
export type VoiceState =
  /** Pre-app.whenReady. */
  | "idle"
  /** Sidecar binary is missing from `resources/whisper/<platform>/`. */
  | "binary-missing"
  /** Binary present, model GGUF not yet downloaded. */
  | "model-missing"
  /** Model download in flight; `progress` carries the byte counters. */
  | "downloading"
  /** Binary + model present and the sidecar passed its smoke test. */
  | "ready"
  /** Probe / spawn / download failed. `errorMessage` says why. */
  | "error";

export interface VoiceModelDownloadProgress {
  /** Total bytes of the model file (from Content-Length when present). */
  total: number | null;
  /** Bytes streamed to disk so far. */
  completed: number;
  /** Smoothed bytes/second, computed renderer-side from coalesced
   *  progress frames. Set by the store, not by main. */
  bytesPerSec?: number;
}

export interface VoiceModelInfo {
  /** Stable id we render in the Settings panel ("distil-large-v3-de"). */
  id: string;
  /** Pretty label for the picker / status line. */
  label: string;
  /** Where the binary expects the GGUF on disk. Read-only — useful for
   *  the "not writable" error path. */
  diskPath: string;
  /** Bytes on disk. 0 when not yet downloaded. */
  sizeBytes: number;
  /** True iff the file exists, has a non-zero size, and matches the
   *  expected magic / header. (8.n1 only checks size > 0; 8.n2 hardens
   *  with a header probe before trusting the model.) */
  installed: boolean;
}

export interface VoiceStatus {
  state: VoiceState;
  /** Where the bundled binary lives at runtime. Null when not bundled
   *  (dev-mode without a fetch-whisper run). */
  binaryPath: string | null;
  /** Per-platform bundled model spec — typically one entry. */
  model: VoiceModelInfo | null;
  /** Active download (state === "downloading"); null otherwise. */
  download: VoiceModelDownloadProgress | null;
  /** Last error, sticky until a successful state transition clears it. */
  errorMessage: string | null;
}

// ---- User profile (Phase 8.t1) --------------------------------------------
//
// Stable per-tenant lens the agent uses to bias every response: bio +
// role + interests, woven into the system prompt verbatim so every
// turn benefits without an explicit lookup. See §8.t1 for the full
// design rationale and the propose-and-confirm flow.

/** Conversation tone shapes how knapp / detailed the agent answers. */
export type UserProfileTone = "neutral" | "knapp" | "ausführlich";

export interface UserProfile {
  /** Free-text bio (~300 chars cap). The primary signal — woven into
   *  the system prompt verbatim. Empty string = no bio. */
  bio: string;
  /** Optional structured fields the user (or the agent on confirm)
   *  has set. Used as tie-breakers + by 8.t4 ranking. */
  role: string | null;
  industries: string[];
  geographies: string[];
  topics: string[];
  tone: UserProfileTone | null;
  /** True iff the user explicitly skipped the first-run nudge. The
   *  agent must NOT re-prompt unless the user says "lass uns mein
   *  Profil mal aktualisieren" or similar. */
  profileSkipped: boolean;
  /** ISO-8601 of the most recent successful write. Useful for "Profil
   *  zuletzt aktualisiert am …" surfaces. */
  updatedAt: string | null;
}

// ---- Standing watches (Phase 8.t2) -----------------------------------------
//
// Watches are user-registered recurring rubrics: the agent evaluates each
// against the heartbeat's fresh candidate set on a configurable cadence,
// and a positive verdict creates a regular `Alert` row tagged with the
// watch's id. See §8.t2 for the design rationale (single-shape trigger
// + cadence-respecting evaluation + 20-watch cap).

export type WatchCadence = "daily" | "weekly" | "monthly";

export interface WatchTrigger {
  /** German rubric phrased like an alert-judge criterion. */
  rubric: string;
  /** Optional scope: only candidates for these companyIds are eval'd. */
  companyIds?: string[];
  /** Optional scope: only candidates whose `kind` is in this list. */
  topics?: AlertKind[];
}

export interface WatchHit {
  /** The Alert row this watch produced. */
  alertId: string;
  at: string;
}

export interface Watch {
  id: string;
  /** German one-liner the user originally said. Display + audit. */
  prompt: string;
  trigger: WatchTrigger;
  cadence: WatchCadence;
  createdAt: string;
  /** When the executor last evaluated this watch (regardless of hit). */
  lastCheckedAt: string | null;
  /** Hits accumulated so the user can see history. Capped to most recent 20. */
  hits: WatchHit[];
  /** User-toggleable; when false the executor skips this row. */
  enabled: boolean;
}

/** Hard cap: the executor refuses `register` past this number, surfacing
 *  the limit message the user can see. Stays small in v1 (8.t2) to keep
 *  the cost ceiling governable; 8.t3 raises it per-tenant if the data
 *  warrants it. */
export const WATCH_CAP_DEFAULT = 20;

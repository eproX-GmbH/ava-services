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

// ---- Auto-updater (8.u4 / 8.v1.5) -----------------------------------------
//
// Background OTA flow via electron-updater talking to GitHub
// Releases. The `Updater` class in main owns the state machine;
// the renderer mirrors via IPC and surfaces a Settings affordance
// + an in-app banner once an update is downloaded.

export type UpdateState =
  | "idle"        // not started yet
  | "checking"    // GET /releases/latest in flight
  | "up-to-date"  // installed version is the newest tag
  | "available"   // newer version exists; awaiting user `download`
  | "downloading" // user accepted; download in progress
  | "ready"       // downloaded, awaiting `install` confirmation
  | "installing"  // user clicked install; quitAndInstall() in flight
  | "error";

export interface UpdateProgress {
  bytesPerSec: number;
  percent: number;
  transferred: number;
  total: number;
}

export interface UpdateStatus {
  state: UpdateState;
  /** Version string from package.json — always present. */
  currentVersion: string;
  /** Latest tag GitHub reports. Null until a check completes. */
  latestVersion: string | null;
  /** Download progress; only populated while state === "downloading". */
  progress: UpdateProgress | null;
  /** Set when state === "error". */
  errorMessage: string | null;
  /**
   * v0.1.155 — Set when the previous boot tried to install an update
   * but the running version on this boot is unchanged. Carries the
   * version that DID NOT install, so the renderer can show
   *   "Update auf vX.Y.Z konnte nicht installiert werden — Logs ansehen?"
   * The flag is cleared after the user dismisses it or once the
   * update successfully lands. See Updater.detectSilentInstallFailure.
   */
  silentInstallFailedFromVersion: string | null;
}

/**
 * v0.1.155 — File paths the user can share with us when an OTA install
 * fails silently. Squirrel.Mac writes to its own log files which
 * neither electron-updater nor we can intercept post-quitAndInstall —
 * surfacing the paths from the Settings panel ("Update-Logs zeigen")
 * is the most reliable way to get an actionable error out of the user.
 */
export interface UpdateDiagnostics {
  /** Active platform — only `darwin` has Squirrel logs. */
  platform: NodeJS.Platform;
  /** Existing log files we can find. Empty when nothing's been logged
   *  yet (no install attempt) or on platforms without Squirrel. */
  logs: { path: string; sizeBytes: number; mtimeMs: number }[];
  /** Persistent "install attempted" marker, if any. The renderer can
   *  surface this for "your last install attempt targeted vX.Y.Z". */
  lastInstallAttempt: { version: string; at: string } | null;
}

// ---- Local producers (8.v1.1) ---------------------------------------------
//
// Producer services (company-profile, structured-content, …) that
// previously lived as fly.io apps now run as Node subprocesses
// spawned by the desktop main process. The `ProducerSupervisor`
// manages each one; the renderer mirrors the status array via IPC
// for the Settings panel. State pushes happen via
// `producers:status-changed` for any producer transition.

export type ProducerSupervisorState =
  | "idle"
  | "migrating"
  | "starting"
  | "ready"
  | "error"
  | "stopping"
  /** v0.1.99 — producer registered in PRODUCER_REGISTRY but its
   *  vendored bundle is missing on disk. Used to surface "X: nicht
   *  installiert" in Settings instead of the producer being invisible. */
  | "not_installed";

export interface ProducerStatus {
  /** Stable name — matches resources/producers/<name>/. */
  name: string;
  state: ProducerSupervisorState;
  /** TCP port once `ready`, else null. */
  port: number | null;
  /** PGlite database the producer is bound to. */
  databaseName: string;
  /** OS process id while running. */
  pid: number | null;
  /** Last error message (set when state === "error"). */
  errorMessage: string | null;
  /** Most recent exit code observed; null if never exited. */
  lastExitCode: number | null;
  /**
   * v0.1.170 — soft warnings about reduced functionality even though
   * the producer itself is `ready`. Example: `website` boots without
   * an OpenAI-Key but Deep Research / Google-Maps-Entity-Resolution
   * stay unavailable at call time. The Settings panel renders these
   * as small "feature deaktiviert"-tags next to the status dot.
   * Empty when the producer is at full capacity.
   */
  featureWarnings: string[];
}

// ---- Producer logs (v0.1.50) ----------------------------------------------
// Mirrored from main/producer-log-buffer.ts. Defined here in shared types so
// both preload and renderer can refer to the same shape without circular
// imports between the two TS projects (tsconfig.web vs tsconfig.node).

export interface ProducerLogLine {
  /** Process-monotonic id; renderer dedupes/seeks on this. */
  id: number;
  /** Wallclock ms when the line was emitted. */
  ts: number;
  stream: "stdout" | "stderr";
  text: string;
}

export interface ProducerLogEvent {
  /** Producer name (matches ProducerStatus.name). */
  producer: string;
  line: ProducerLogLine;
}

// ---- Producer screenshots (v0.1.50) ---------------------------------------
// Mirrored from main/producer-screenshots.ts.

// ---- External service reachability (v0.1.52) ------------------------------
// v0.1.105 — multi-source. Used by main/external-service-monitor.ts to
// surface upstream reachability for both unternehmensregister.de and
// handelsregister.de. The renderer banner + producer auto-pause / picker
// in main/structured-content-source.ts all consume the aggregate.

export type ExternalServiceState = "unknown" | "reachable" | "unreachable";

export type ExternalServiceId = "unternehmensregister" | "handelsregister";

export interface ExternalServiceStatus {
  service: ExternalServiceId;
  state: ExternalServiceState;
  url: string;
  lastCheckedAt: number | null;
  lastReachableAt: number | null;
  latencyMs: number | null;
  errorMessage: string | null;
  consecutiveFailures: number;
}

export interface ExternalServicesStatus {
  services: Record<ExternalServiceId, ExternalServiceStatus>;
  anyReachable: boolean;
  allReachable: boolean;
}

export interface ProducerScreenshotEntry {
  /** Filename within <userData>/screenshots/<producer>/<runId>/.
   *  Use window.api.producers.screenshots.urlFor() to get a renderable
   *  ava-screenshot:// URL. */
  filename: string;
  /** Capture timestamp (ms since epoch), parsed from filename prefix. */
  ts: number;
  /** Step label parsed from filename suffix — "click_search",
   *  "before_iframe_sweep", "failure", etc. */
  label: string;
  /** PNG size in bytes. */
  size: number;
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
  /**
   * v0.1.151 — conversationId of the currently-streaming turn. Pairs
   * with `inFlightRequestId` so the renderer can tell "is the busy turn
   * MINE?" after a route remount. Without this, navigating away during
   * a stream and back leaves the Send/Stop button confused: status says
   * "something is in flight" but the renderer can't tell whether it's
   * for the conversation currently on screen.
   */
  inFlightConversationId: string | null;
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

/**
 * v0.1.85 — one hit returned by `agent:searchConversations`. Coordinates
 * are excerpt-relative; the renderer wraps each [start,end) in <mark>.
 */
export interface ConversationSearchHit {
  conversationId: string;
  conversationLabel: string;
  conversationModifiedAt: number;
  messageIndex: number;
  messageId: string;
  messageRole: "user" | "assistant" | "tool" | "system";
  excerpt: string;
  matchOffsets: Array<[number, number]>;
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

/**
 * v0.1.151 — A still-open prompt (choice or text) for a given
 * conversation. Returned by `agent:getPendingPrompts` so the renderer
 * can replay the prompt cards after a route remount; the original
 * `choice-request` / `text-request` stream frame fires once and is
 * lost if the Chat component wasn't mounted at the time.
 *
 * Shape is intentionally close to the matching stream frames so the
 * renderer's existing card-rendering branch can consume both
 * uniformly.
 */
export type AgentPendingPrompt =
  | {
      kind: "choice-request";
      conversationId: string;
      requestId: string;
      choiceId: string;
      prompt: string;
      options: AgentChoiceOption[];
    }
  | {
      kind: "text-request";
      conversationId: string;
      requestId: string;
      choiceId: string;
      prompt: string;
      placeholder?: string;
      defaultValue?: string;
      optional?: boolean;
    };

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

/**
 * Authentication mode for the Anthropic provider.
 *
 *   - "api-key":      x-api-key header, classic API-Credits billing.
 *   - "subscription": Authorization: Bearer <oauth-token>, consumes the
 *                     user's Claude Pro/Max-Abo quota instead of API
 *                     credits. Token is generated outside AVA via
 *                     Anthropic's `claude setup-token` CLI. The token
 *                     is keychain-stored separately from the API key so
 *                     both auth modes can coexist on disk; only the one
 *                     selected here is actually sent.
 *
 * Only meaningful when `kind === "anthropic"`. For all other providers
 * this field is ignored by the runtime.
 */
export type AnthropicAuthMode = "api-key" | "subscription";

export interface ProviderConfig {
  /** Currently active provider for new turns. */
  kind: LlmProviderKind;
  /**
   * Selected model id per provider. Always present so flipping providers
   * doesn't drop the user's prior model choice. Empty string for a kind
   * means "use catalog recommendation".
   */
  models: Record<LlmProviderKind, string>;
  /**
   * Which credential AVA uses when `kind === "anthropic"`. Default
   * "api-key" keeps existing installs unchanged. Persisted next to
   * `kind` + `models` in `provider.json`.
   */
  anthropicAuthMode?: AnthropicAuthMode;
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
  /**
   * Separate from `hasKey.anthropic` because the subscription OAuth
   * token is keychain-stored in its own `.enc` blob (so both auth modes
   * can coexist on disk). True iff `anthropic-subscription.enc` exists.
   */
  hasAnthropicSubscriptionToken: boolean;
  encryptionAvailable: boolean;
  /**
   * v0.1.209 — Letzter bekannter Tier-Schnappschuss aus den Anthropic-
   * Rate-Limit-Headern. Wird beim Key-Eintragen erfasst und persistiert,
   * damit Renderer den Tier-Stand auch ohne aktiven Probe-Call kennt
   * (Banner unter ApiKeyCard, Onboarding-Wizard). Null wenn nie ermittelt
   * (z. B. weil der Probe-Call netzwerkbedingt scheiterte) oder wenn der
   * Anthropic-Key nicht gesetzt ist.
   */
  anthropicTierInfo?: AnthropicTierInfo | null;
}

/**
 * v0.1.209 — TPM/RPM-Schnappschuss aus den Anthropic-`/v1/messages`-
 * Rate-Limit-Headern. Wird beim Key-Validate erfasst und im
 * Provider-Store persistiert. Renderer zeigt einen Hinweis-Banner bei
 * Tier 1, damit Nicht-Tech-Nutzer den Upgrade-Pfad finden, bevor sie
 * im ersten Chat in eine 429 laufen.
 */
export interface AnthropicTierInfo {
  /** Maximum Input-Tokens pro Minute aus dem
   *  `anthropic-ratelimit-input-tokens-limit`-Header. */
  inputTokensPerMinute: number;
  /** Maximum Output-Tokens pro Minute aus dem
   *  `anthropic-ratelimit-output-tokens-limit`-Header. */
  outputTokensPerMinute: number;
  /** Maximum Requests pro Minute aus dem
   *  `anthropic-ratelimit-requests-limit`-Header. */
  requestsPerMinute: number;
  /**
   * Heuristische Tier-Klassifikation auf Basis der TPM-Werte. Anthropic
   * dokumentiert die genauen Schwellen nicht offiziell — wir nutzen
   * Industrie-Beobachtungen (Stand 2026-05):
   *   - tier-1   bei input TPM ≤ 50 000 (Default für neue Accounts)
   *   - tier-2   bei input TPM ≤ 100 000
   *   - tier-3+  darüber
   *
   * Banner wird NUR für tier-1 angezeigt; tier-2 / tier-3+ gelten als
   * komfortabel für typische AVA-Recherchen.
   */
  tierLabel: "tier-1" | "tier-2" | "tier-3+";
  /** epoch ms — letzter Probe-Zeitpunkt. */
  detectedAt: number;
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
  /** v0.1.209 — Anthropic-Probe hängt einen `tierInfo`-Schnappschuss
   *  mit dran, sobald die TPM/RPM-Limits aus `/v1/messages`-Antwort
   *  ablesbar waren. Andere Provider liefern das Feld nie. */
  | { ok: true; tierInfo?: AnthropicTierInfo }
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
  | "evaluation-flag"  // an LLM evaluation flagged something noteworthy
  | "linkedin-signal"; // L6: LinkedIn-Beobachter strong signal

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
  /** v0.1.118 — auto-retry failed producer cells in the background.
   *  Defaults to `true`. Gated behind the heartbeat: if cadence is 0
   *  the auto-retry tick doesn't run either. */
  autoRetryEnabled: boolean;
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

// ---- CRM integration (v0.1.54) ---------------------------------------------
//
// User-owned OAuth links to a CRM. Tokens live in the OS keychain
// (Electron safeStorage); only metadata crosses the IPC boundary.
// The renderer surfaces a card per provider in Settings; the chat
// agent invokes connect_crm / disconnect_crm / crm_status tools to
// drive the same flow.

export type CrmProviderKind = "salesforce" | "hubspot" | "dynamics";

export const CRM_PROVIDER_KINDS: ReadonlyArray<CrmProviderKind> = [
  "salesforce",
  "hubspot",
  "dynamics",
];

export interface CrmProviderStatus {
  provider: CrmProviderKind;
  connected: boolean;
  account: string | null;
  lastRefreshedAt: string | null;
  lastError: string | null;
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

// ---- LinkedIn-Beobachter (Phase L0 — compliance scaffolding) -----------
//
// User-facing master switch + consent state for the upcoming LinkedIn
// feed scanner. L0 ships UI + persisted state ONLY; no scraper code.
// All data referenced here lives on the user's device — the gateway
// never receives any of it. See services/desktop/src/main/linkedin/.

export interface LinkedInSettings {
  /** Master switch. Refuses to flip true unless consentAcceptedAt is set. */
  enabled: boolean;
  /** ms epoch the user accepted the consent modal. Cleared on revoke. */
  consentAcceptedAt: number | null;
  /** Pipeline lookahead (L4). "off" = no image analysis, "local" = local
   *  vision model, "cloud" = forward to user's configured LLM provider.
   *  "cloud" requires `imageAnalysisCloudOptIn === true`. */
  imageAnalysis: "off" | "local" | "cloud";
  /** Sticky opt-in for sending images to a cloud LLM. Distinct from
   *  imageAnalysis so toggling local-only off then back on doesn't
   *  silently re-enable cloud. */
  imageAnalysisCloudOptIn: boolean;
  /** When true the scraper will run on the schedule below. */
  automaticScans: boolean;
  /** 1..24 (clamped at the IPC validator). */
  scanIntervalHours: number;
  /** ms epoch of the last completed scan. L0: always null. */
  lastScanAt: number | null;
  /** Stable per-install fingerprint (Phase L1). Generated once main-side
   *  on first run and reused by the L2 Playwright context so we don't
   *  fluctuate across Chrome major versions / random viewport sizes
   *  every visit. Null when not yet generated. */
  fingerprint?: LinkedInFingerprint | null;
  /** Phase L7 anti-detection opt-in. When true, scans dwell longer on
   *  the feed before scrolling, take a multi-stage path through the
   *  homepage, scroll more slowly, and pull fewer posts per run.
   *  Default false. */
  aggressiveMode?: boolean;
}

/** Stable per-install fingerprint used to seed the Playwright context
 *  in L2. Written once main-side; never changes thereafter unless the
 *  user wipes via the kill-switch. */
export interface LinkedInFingerprint {
  userAgent: string;
  viewport: { width: number; height: number };
  /** IANA timezone, e.g. "Europe/Berlin". */
  timezone: string;
  /** BCP-47 locale tag, e.g. "de-DE". */
  locale: string;
}

/** Metadata stored alongside the encrypted cookie blob (Phase L1).
 *  Lives unencrypted at userData/linkedin/session.meta.json so the
 *  renderer can show "Verbunden seit …" without crossing through
 *  safeStorage (which is sync-only and main-only). */
export interface LinkedInSessionMeta {
  /** ms epoch when the cookies were captured. */
  capturedAt: number;
  /** ms epoch of the latest cookie's `expires`; null if all cookies
   *  are session-only. li_at typically lives ~1 year. */
  earliestExpiresAt: number | null;
  /** Decoded best-effort from the `li_at` cookie payload — null when
   *  decode fails. Surfaced as "Verbunden als …" in the UI. */
  memberUrn: string | null;
}

/** Result of `linkedin.auth.openLogin`. */
export type LinkedInLoginResult =
  | { ok: true; meta: LinkedInSessionMeta }
  | { ok: false; reason: "user_cancelled" | "no_cookies" | "timeout" };

/** Result of `linkedin.auth.status`. */
export interface LinkedInAuthStatus {
  connected: boolean;
  meta: LinkedInSessionMeta | null;
}

// ---- LinkedIn-Beobachter Phase L2: scan + feed surface -------------------

/** Outcome of one scan attempt. Matches the `outcome` column on
 *  `linkedin_scan_run`. */
export type LinkedInScanOutcome =
  | "success"
  | "login_required"
  | "network_error"
  | "cancelled"
  | "error";

/** Result returned from main when a scan finishes. */
export interface LinkedInScanResult {
  runId: string;
  outcome: LinkedInScanOutcome;
  postsSeen: number;
  postsNew: number;
  interactionsNew: number;
  mediaNew: number;
  errorMessage?: string;
  /** ms epoch; null while running. */
  finishedAt: number | null;
}

/** v0.1.109 — sidecar metadata written alongside per-run screenshots.
 *  Surfaced by `linkedin:runs:list` for the "Letzte Läufe" panel. */
export interface LinkedInRunMeta {
  startedAt: string;
  finishedAt: string | null;
  outcome:
    | LinkedInScanOutcome
    | "no_posts"
    | "running";
  postsSeen: number;
  signalsLinked: number;
  errorMessage: string | null;
  userAgent: string | null;
  url: string | null;
  /** v0.1.112 — per-run extractor diagnostic. Records the per-candidate
   *  match counts for the post wrapper selectors plus the final dedup
   *  size, so we can tell offline which selector hit (or that all
   *  selectors missed) after a 0-posts run. */
  extractionDiagnostic?: {
    candidateCounts: Record<string, number>;
    finalCount: number;
  } | null;
}

/** One row in the "Letzte Läufe" list. `meta` is null when `run.json`
 *  is missing or unparseable (an older run, or a run that crashed
 *  before it could write the sidecar). */
export interface LinkedInRunListEntry {
  dir: string;
  startedAt: string;
  meta: LinkedInRunMeta | null;
}

/** Status of the scan engine. Cheap to poll from the renderer. */
export interface LinkedInScanStatus {
  running: boolean;
  /** Last finalised run, regardless of outcome. */
  lastRun: LinkedInScanResult | null;
  /** ms epoch convenience (mirrors lastRun?.finishedAt). */
  lastRunAt: number | null;
}

/** Aggregate counts surfaced in Settings. */
export interface LinkedInFeedCounts {
  posts: number;
  interactions: number;
  actors: number;
  media: number;
  /** Total bytes of stored media. */
  mediaBytes: number;
  /** Phase L3: signal-extraction queue counts. */
  signalsExtracted: number;
  signalsPending: number;
  signalsFailed: number;
  signalsSkipped: number;
  /** Phase L4: vision-LLM image-analysis queue counts. */
  imageAnalyses: {
    pending: number;
    analyzed: number;
    failed: number;
    skipped: number;
  };
  /** Phase L5: entity-link counts. */
  links: {
    pendingPosts: number;
    linkedPosts: number;
    matched: number;
    ambiguous: number;
    unmatched: number;
    knownCompanies: number;
  };
}

/** Phase L3: extraction worker status, polled by Settings. */
export interface LinkedInSignalStatus {
  running: boolean;
  pending: number;
  extracted: number;
  failed: number;
  skipped: number;
  lastRunAt: number | null;
  lastError: string | null;
}

/** Phase L5: entity-linker worker status, polled by Settings. */
export interface LinkedInLinkerStatus {
  running: boolean;
  pendingPosts: number;
  linkedPosts: number;
  knownCompanies: number;
  matched: number;
  ambiguous: number;
  unmatched: number;
  lastRunAt: number | null;
  lastError: string | null;
}

/** Phase L5/L6: a signal joined with its matched master companies.
 *  Used by `linkedin:linker:signalsForCompany`. */
export interface LinkedInLinkedSignal {
  postUrn: string;
  postedAt: number | null;
  scrapedAt: number;
  text: string;
  permalink: string | null;
  authorDisplayName: string;
  signalKind: string | null;
  signalStrength: number | null;
  summary: string | null;
  matchedCompanies: Array<{ companyId: string; name: string }>;
}

/** Phase L6: filter shape for the /linkedin route + agent tool. */
export interface LinkedInSignalListFilter {
  kind?:
    | "any"
    | "personnel_change"
    | "company_event"
    | "factory_visit"
    | "new_product"
    | "partnership"
    | "event_attendance"
    | "hiring"
    | "award"
    | "press_mention"
    | "none";
  strengthMin?: number;
  knownCompaniesOnly?: boolean;
  includeDismissed?: boolean;
  sinceDays?: number;
  limit?: number;
  offset?: number;
}

/** Phase L6: row shape for the filterable signal list. */
export interface LinkedInSignalListRow {
  postUrn: string;
  postedAt: number | null;
  scrapedAt: number;
  text: string;
  permalink: string | null;
  externalUrl: string | null;
  author: {
    actorUrn: string;
    displayName: string;
    headline: string | null;
    profileUrl: string | null;
  };
  signalKind: string | null;
  signalStrength: number | null;
  summary: string | null;
  llmTier: number | null;
  llmModel: string | null;
  matchedCompanies: Array<{
    companyId: string;
    name: string;
    sourceValue: string;
  }>;
  matchedContacts: Array<{
    contactId: string;
    display: string;
    sourceValue: string;
  }>;
  detectedLogos: string[];
  images: Array<{
    mediaId: string;
    relPath: string;
    description: string | null;
  }>;
  dismissed: boolean;
}

/** Phase L6: full detail payload for the expanded card view. */
export interface LinkedInSignalDetail extends LinkedInSignalListRow {
  topics: string[];
  entitiesRaw: { companies: string[]; people: string[]; locations?: string[] };
  allLinks: Array<{
    sourceKind: string;
    sourceValue: string;
    resolution: string;
    masterCompanyId: string | null;
    masterCompanyName: string | null;
    contactId: string | null;
    contactDisplay: string | null;
    matchScore: number | null;
    matchReason: string | null;
  }>;
  imageAnalyses: Array<{
    mediaId: string;
    description: string | null;
    visibleText: string | null;
    environment: string | null;
    detectedLogos: string[];
    detectedProducts: string[];
  }>;
  interactions: Array<{
    actorUrn: string;
    displayName: string;
    headline: string | null;
    kind: string;
    commentText: string | null;
  }>;
}

/** Phase L4: image-analysis worker status, polled by Settings. */
export interface LinkedInImageAnalysisStatus {
  running: boolean;
  pending: number;
  analyzed: number;
  failed: number;
  skipped: number;
  lastRunAt: number | null;
  lastError: string | null;
}

/** Joined post + author shape returned by `feed:recent`. L6 surfaces
 *  this in the /linkedin route; L2 only ships it. */
export interface LinkedInRecentPost {
  postUrn: string;
  postKind: string;
  text: string;
  permalink: string | null;
  externalUrl: string | null;
  postedAt: number | null;
  scrapedAt: number;
  author: {
    actorUrn: string;
    displayName: string;
    headline: string | null;
    profileUrl: string | null;
  };
  mediaCount: number;
  interactionCount: number;
}

// ---- Skills (PLAN §2, S3) -------------------------------------------------
//
// `SkillRow` is the renderer-facing projection of a `LoadedSkill` plus
// per-user enabled-state and gate-evaluation results. Surfaced via
// `window.api.skills.list()`. Gate-failing skills are still listed so
// the Settings UI can show "Voraussetzung fehlt: …" instead of hiding
// the skill silently.

export type SkillB2bScope =
  | "outreach"
  | "qualifying"
  | "competitive"
  | "data-extraction"
  | "internal";

export type SkillLanguage = "de" | "en";

export type SkillScope = "user" | "workspace";

export interface SkillRow {
  name: string;
  description: string;
  language: SkillLanguage;
  b2bScope: SkillB2bScope;
  allowedTools: string[];
  requiresUserConfirm: boolean;
  disableModelInvocation: boolean;
  userInvocable: boolean;
  scope: SkillScope;
  sourcePath: string;
  hash: string;
  enabled: boolean;
  gateSatisfied: boolean;
  /** German one-liner explaining a failed gate. Null when satisfied. */
  gateReason: string | null;
  /** S4 — trust state. Skills that aren't `"trusted"` stay in the
   *  list but don't fire; the Settings UI prompts for re-confirm. */
  trust: "trusted" | "untrusted" | "modified";
  /** S4 — for `trust === "modified"`, the allowed-tools the user
   *  previously approved. Empty array for `"trusted"`/`"untrusted"`. */
  previouslyTrustedAllowedTools: string[];
}

export interface SkillBody {
  body: string;
  sourcePath: string;
  hash: string;
}

// ---- Skills S4 — editor + trust ------------------------------------------

export interface SkillArgumentPayload {
  name: string;
  description: string;
  required: boolean;
}

export interface SkillFrontmatterPayload {
  name: string;
  description: string;
  language: SkillLanguage;
  "b2b-scope": SkillB2bScope;
  "allowed-tools": string[];
  "requires-user-confirm": boolean;
  "disable-model-invocation": boolean;
  "user-invocable": boolean;
  arguments: SkillArgumentPayload[];
}

export interface SkillSavePayload {
  frontmatter: SkillFrontmatterPayload;
  body: string;
}

export type SkillSaveResult =
  | { ok: true; name: string }
  | { ok: false; error: string };

export type SkillDeleteResult =
  | { ok: true }
  | { ok: false; error: string };

// ---- Skills S5 — import / export -----------------------------------------
//
// PLAN §2.6 + §2.7. Single-skill export writes a one-file zip; the
// "Alle exportieren" path bundles every user-scope skill + a top-level
// MANIFEST.json. Import is a two-step flow: staging (parse + validate
// + diff against trust store) and commit (copy from temp dir into
// `<userData>/skills/<name>/` + optional auto-trust).

/** What an import would do to a given skill name on disk. Used by the
 *  staging UI to label each row + drive the default opt-in / opt-out. */
export type SkillImportAction =
  | "create"
  | "overwrite-trusted"
  | "overwrite-modified"
  | "overwrite-untrusted";

export interface SkillImportStagedEntry {
  name: string;
  description: string;
  language: SkillLanguage;
  b2bScope: SkillB2bScope;
  allowedTools: string[];
  requiresUserConfirm: boolean;
  disableModelInvocation: boolean;
  userInvocable: boolean;
  body: string;
  bodyLength: number;
  bodyLines: number;
  /** New hash that will end up on disk after the commit step. */
  hash: string;
  action: SkillImportAction;
  /** Populated when `action !== "create"`: the allowed-tools the user
   *  had previously approved for this skill, so the dialog can diff
   *  added/removed tools. Undefined when no prior trust entry exists. */
  previousAllowedTools?: string[];
}

export interface SkillImportConflict {
  /** Name (or original filename / temp-dir entry) the importer tried
   *  to parse. Empty when the file was malformed enough that no name
   *  could be extracted. */
  name: string;
  /** German one-liner explaining why the entry was rejected. */
  reason: string;
}

export type SkillImportResult =
  | {
      ok: true;
      /** Opaque handle for the temp dir holding the staged SKILL.md
       *  files. Pass back to `commitImport`. */
      stagingId: string;
      staged: SkillImportStagedEntry[];
      conflicts: SkillImportConflict[];
    }
  | { ok: false; error: string };

export interface SkillImportCommitEntry {
  name: string;
  /** "auto" = write file AND auto-trust with the new allowed-tools.
   *  "deferred" = write file but leave trust untouched; the row stays
   *  in `trust: "untrusted"` until the user opens the trust dialog. */
  trust: "auto" | "deferred";
}

export interface SkillImportCommit {
  stagingId: string;
  staged: SkillImportCommitEntry[];
}

export type SkillImportCommitResult =
  | { ok: true; written: string[] }
  | { ok: false; error: string };

export type SkillExportResult =
  | { ok: true; path: string }
  | { ok: false; error: string }
  /** User cancelled the save dialog — UI surface treats it as a no-op,
   *  no error toast. */
  | { ok: false; cancelled: true };

export type SkillExportAllResult =
  | { ok: true; path: string; count: number }
  | { ok: false; error: string }
  | { ok: false; cancelled: true };

// ---- Research Features (v0.1.172, Settings Phase A) ------------------------
//
// Per-feature configuration for the two cloud-LLM enrichment pipelines in
// the `website` producer (Deep Research / Tenders+Expansion+Procurement,
// and Job-Postings). Each feature is independent: separate tier, separate
// provider, separate API key. The factory in `website/src/infrastructure/
// research/index.ts` reads its 6 RESEARCH_* env vars from these settings.
//
// Decision recorded with user 2026-05-14:
//   - Strict tiers (no cascade): deep means deep, never the standard
//     model as a cheap pre-pass. Predictable per-firma cost.
//   - Default: both features OFF. Activation requires explicit user
//     action in Settings (since the costs are visible — €0.10 to €5/firma).
//   - Anthropic must be API-Key (sk-ant-api03-...), NOT OAuth subscription
//     -- ToS-confirmed (only Claude Code may use OAuth tokens).

export type ResearchTier = "off" | "standard" | "deep";
export type ResearchProvider = "openai" | "anthropic";
export type ResearchFeature = "expansionTenders" | "jobPostings";

/**
 * Reference to an API key. Can be:
 *   • `"global:openai"` / `"global:anthropic"` — pointer to the existing
 *     ProviderConfigStore key (the "Allgemeine Modell-Konfiguration"
 *     key from the chat-agent settings). When the user picks "Übernehmen
 *     aus Allgemeine Modell-Konfiguration", the feature stays bound to
 *     that key by reference -- updates there propagate here.
 *   • `"<uuid>"` — a research-store-owned key, stored encrypted at
 *     userData/research/keys/<uuid>.enc with metadata in keys/<uuid>.meta.json.
 *   • `null` — feature has no key bound yet (tier must be "off" in this case).
 */
export type ResearchKeyId = string;

export interface ResearchFeatureConfig {
  tier: ResearchTier;
  provider: ResearchProvider | null;
  keyId: ResearchKeyId | null;
}

export interface ResearchFeaturesConfig {
  expansionTenders: ResearchFeatureConfig;
  jobPostings: ResearchFeatureConfig;
}

export interface ResearchKeyMeta {
  id: string;
  provider: ResearchProvider;
  label: string;
  createdAt: number;
  lastUsedAt: number | null;
  lastProbeOk: boolean | null;
  lastProbeAt: number | null;
  /** Last 4 chars of the key for UI display ("sk-ant-…aB9c"). Plaintext
   *  beyond this never leaves the main process. */
  keyHint: string;
}

/** Pseudo-meta for the two "global:*" pointer ids -- synthesized on the
 *  fly from ProviderConfigStore state so the renderer can render them in
 *  the same Übernehmen-Dropdown as research-store-owned keys. */
export interface ResearchGlobalKeyAvailability {
  openai: boolean;
  anthropic: boolean;
}

/**
 * Single bundle the renderer asks for on Settings-section mount. Avoids
 * a fan-out of 4-5 IPCs; mirrors the `agent:getProviderConfig` pattern.
 */
export interface ResearchSettingsBundle {
  config: ResearchFeaturesConfig;
  keys: ResearchKeyMeta[];
  globals: ResearchGlobalKeyAvailability;
  /** True iff safeStorage.isEncryptionAvailable(). Renderer shows a
   *  warning chip if false (basic cipher fallback on Linux without
   *  libsecret/kwallet). */
  encryptionAvailable: boolean;
}

/** Probe-result shape for the Settings "Test"-button (Phase G). */
export type ResearchKeyProbeResult =
  | { ok: true; latencyMs: number }
  | { ok: false; error: string };


// v0.1.200 — Audit-Trail (local-first, privacy-first). The renderer
// reads via IPC; main writes to embedded PGlite. Types declared here
// so preload + renderer share the contract without importing main-
// only code (which would pull electron into the renderer bundle).
//
// Main-side `audit-store.ts` re-imports these from this file so
// there is only one source of truth.
export type AuditActorType = "user" | "producer" | "scheduler" | "system";
export type AuditCategory =
  | "producer"
  | "linkedin"
  | "crm"
  | "auth"
  | "import"
  | "watch"
  | "scheduler"
  | "billing"
  | "update"
  | "agent";
export type AuditSeverity = "info" | "warning" | "error";
export type AuditSubjectType =
  | "company"
  | "transaction"
  | "person"
  | "credential"
  | null;
export interface AuditEvent {
  id: string;
  timestamp: string;
  actorType: AuditActorType;
  actorId: string | null;
  category: AuditCategory;
  action: string;
  severity: AuditSeverity;
  subjectType: AuditSubjectType;
  subjectId: string | null;
  summary: string;
  metadata: Record<string, unknown>;
}
export type AuditEventInput = Omit<AuditEvent, "id" | "timestamp"> & {
  timestamp?: string;
};
export interface AuditListQuery {
  since?: string;
  until?: string;
  categories?: AuditCategory[];
  severities?: AuditSeverity[];
  actorTypes?: AuditActorType[];
  search?: string;
  subjectType?: AuditSubjectType;
  subjectId?: string | null;
  pageSize?: number;
  pageToken?: string | null;
}
export interface AuditListResponse {
  events: AuditEvent[];
  nextPageToken: string | null;
  totalEstimate: number;
}

// ---- v0.1.210 Token-Verbrauch (lokal, PGlite) ------------------------------
//
// Lokaler Audit für LLM-Calls: Wie viele Tokens hat welcher Provider in
// welchem Modell für welche Quelle gekostet? Daten verlassen die Maschine
// nicht (eigene PGlite-DB unter <userData>/pglite/usage/). UI: Settings
// → "Verbrauch"-Tab. Pricing ist eine Schätzung (Anbieter ändern Preise);
// Tokens sind die harte Größe.

/** Wer hat den Call gemacht? Source ist ein gelabelter Diskriminator,
 *  damit Filter/Aggregation per "kind" gehen, statt String-Matching. */
export type UsageSource =
  | { kind: "chat"; conversationId: string | null }
  | { kind: "producer"; name: string }    // "profile" | "contact" | "website" | …
  | { kind: "watch" }
  | { kind: "alert-judge" }
  | { kind: "other"; label: string };

/** Provider-agnostischer Rate-Limit-/Quota-Schnappschuss. Jeder Provider
 *  liefert andere Header — wir parken alles in dieser typisierten Box
 *  und die UI rendert nur, was tatsächlich befüllt ist.
 *
 *  Anthropic-API-Key: nutzt die `anthropic-ratelimit-*-tokens-remaining`-
 *  Header. Anthropic-OAuth-Abo: zusätzlich (wenn Anthropic die surfacet)
 *  die priority-window-Felder. OpenAI: `x-ratelimit-remaining-tokens` /
 *  `-requests` / `-reset`. Mistral: ähnliches Pattern. Google: liefert
 *  meist nichts → Snapshot bleibt leer. */
export interface QuotaSnapshot {
  inputTokensRemaining?: number;
  outputTokensRemaining?: number;
  requestsRemaining?: number;
  /** ISO-8601 — wann das Bucket zurückgesetzt wird. */
  resetAt?: string;
  /** Provider-spezifisches Rohmaterial (Header-Werte als Strings),
   *  falls die UI später noch was zeigen will, was wir oben nicht
   *  typisiert haben. */
  raw?: Record<string, string>;
}

/** Eine Zeile pro LLM-Call. */
export interface UsageEvent {
  id: string;
  /** ISO-8601 */
  timestamp: string;
  provider: LlmProviderKind;
  model: string;
  source: UsageSource;
  inputTokens: number;
  outputTokens: number;
  /** Anthropic-Prompt-Caching: Cache-Read = günstigster Pfad, Cache-Write
   *  = teurster Pfad (auch teurer als normales Input). Andere Provider
   *  haben oft keine Caching-Buchhaltung → bleibt 0. */
  cacheReadTokens: number;
  cacheWriteTokens: number;
  /** Schätzung in USD. NULL bei Anthropic-OAuth-Abo (keine API-Kosten,
   *  Abo-Quota), bei Ollama (lokal, $0) und wenn das Modell nicht in
   *  der Preistabelle steht. */
  estimatedUsd: number | null;
  /** Provider-agnostischer Rate-Limit-/Quota-Schnappschuss. Optional;
   *  fehlt z. B. bei Producer-Markern (die haben den Header nie gesehen). */
  quotaSnapshot?: QuotaSnapshot;
  /** Freitext-Metadaten für Diagnose (z. B. finish_reason). */
  metadata?: Record<string, unknown>;
}

/** Eingabe-Variante: id + timestamp werden vom Store gesetzt. */
export type UsageEventInput = Omit<UsageEvent, "id" | "timestamp"> & {
  timestamp?: string;
};

export interface UsageListQuery {
  since?: string;
  until?: string;
  providers?: LlmProviderKind[];
  models?: string[];
  /** kind-Filter — z. B. `["chat"]` oder `["producer"]`. */
  sourceKinds?: UsageSource["kind"][];
  pageSize?: number;
  pageToken?: string | null;
}

export interface UsageListResponse {
  events: UsageEvent[];
  nextPageToken: string | null;
  totalEstimate: number;
}

/** Aggregat pro Tag, gruppiert nach Modell UND nach Quelle.
 *  `day` ist UTC-`YYYY-MM-DD`. */
export interface UsageDailyBucket {
  day: string;
  byModel: Array<{
    provider: LlmProviderKind;
    model: string;
    inputTokens: number;
    outputTokens: number;
    cacheReadTokens: number;
    cacheWriteTokens: number;
    estimatedUsd: number | null;
    calls: number;
  }>;
  bySource: Array<{
    sourceKey: string;             // serialisiert: "chat" | "producer:profile" | …
    inputTokens: number;
    outputTokens: number;
    cacheReadTokens: number;
    cacheWriteTokens: number;
    estimatedUsd: number | null;
    calls: number;
  }>;
}

import { contextBridge, ipcRenderer } from "electron";
import type {
  AgentChoiceAnswer,
  AgentMessage,
  AgentSendInput,
  AgentSendResult,
  AgentStatus,
  AgentStreamFrame,
  Alert,
  AlertPrefs,
  AlertTickInfo,
  ApiKeyValidation,
  FreshnessPrefs,
  FreshnessTickInfo,
  UserProfile,
  Watch,
  VoiceModelDownloadProgress,
  VoiceStatus,
  AuthStatus,
  AppConfig,
  HostedProviderKind,
  LlmProviderKind,
  NotificationPermissionStatus,
  OllamaPullProgress,
  OllamaStatus,
  PostgresStatus,
  ProducerStatus,
  ProviderCatalogEntry,
  ProviderConfig,
  ProviderConfigBundle,
} from "../shared/types";
export type {
  AgentChoiceAnswer,
  AgentChoiceOption,
  AgentMessage,
  AgentSendInput,
  AgentSendResult,
  AgentStatus,
  AgentStreamFrame,
  Alert,
  AlertCadenceMinutes,
  AlertCandidateDecision,
  AlertDecisionOutcome,
  AlertKind,
  AlertPrefs,
  AlertSeverity,
  AlertTickInfo,
  ApiKeyValidation,
  FreshnessCadenceDays,
  FreshnessPrefs,
  FreshnessStage,
  FreshnessTickInfo,
  StalenessRow,
  UserProfile,
  UserProfileTone,
  Watch,
  WatchCadence,
  WatchHit,
  WatchTrigger,
  VoiceModelDownloadProgress,
  VoiceModelInfo,
  VoiceState,
  VoiceStatus,
  AppConfig,
  AuthStatus,
  HostedProviderKind,
  LlmProviderKind,
  NotificationPermissionStatus,
  OllamaPullProgress,
  OllamaStatus,
  PostgresStatus,
  ProducerStatus,
  ProviderCatalogEntry,
  ProviderConfig,
  ProviderConfigBundle,
  ProviderStatusSnapshot,
  QuietHoursConfig,
} from "../shared/types";

// Preload bridge.
//
// Runs in an isolated context with access to a small slice of Node API
// (just `electron`'s ipcRenderer). Anything we expose on `window.api` is
// the only thing the renderer can call into the main process — we keep
// the surface tiny on purpose.
//
// Channels match `ipcMain.handle(...)` calls in main/index.ts. Adding a
// capability means adding the channel name in both places.

const api = {
  getConfig: (): Promise<AppConfig> => ipcRenderer.invoke("app:getConfig"),

  // Auth.
  auth: {
    getStatus: (): Promise<AuthStatus> => ipcRenderer.invoke("auth:getStatus"),
    /** Returns a fresh-enough access token, or null if signed out. */
    getAccessToken: (): Promise<string | null> =>
      ipcRenderer.invoke("auth:getAccessToken"),
    signIn: (): Promise<void> => ipcRenderer.invoke("auth:signIn"),
    signOut: (): Promise<void> => ipcRenderer.invoke("auth:signOut"),
    /** Subscribe to status changes (login / logout / silent refresh). */
    onStatusChanged: (cb: (status: AuthStatus) => void): (() => void) => {
      const handler = (_e: Electron.IpcRendererEvent, status: AuthStatus) =>
        cb(status);
      ipcRenderer.on("auth-status:changed", handler);
      return () => ipcRenderer.removeListener("auth-status:changed", handler);
    },
  },

  // Ollama (D7) — bundled local LLM/embedding runtime.
  // Renderer never sees the child process directly; everything is mediated
  // by the supervisor in the main process.
  ollama: {
    getStatus: (): Promise<OllamaStatus> =>
      ipcRenderer.invoke("ollama:getStatus"),
    /**
     * Pull a model by tag. Resolves on the final frame; per-frame progress
     * arrives via `onPullProgress`. The same call used by the FirstRunWizard
     * to download missing models.
     */
    pullModel: (modelName: string): Promise<OllamaPullProgress> =>
      ipcRenderer.invoke("ollama:pullModel", modelName),
    /**
     * Phase 8.k10e — delete a model from disk. Used by the Whoami
     * installed-models list to free space. Resolves once Ollama
     * confirmed the deletion AND the supervisor refreshed its
     * installed list, so a subsequent `getStatus` reflects the change.
     */
    deleteModel: (modelName: string): Promise<void> =>
      ipcRenderer.invoke("ollama:deleteModel", modelName),
    /**
     * Phase 8.k10f — stop + start the supervisor. The agent
     * auto-invokes this on a runner crash, but we expose it here so
     * the user has an explicit recovery affordance for the cases
     * where the auto-recover didn't fire (e.g. supervisor wedged
     * before any /api/chat request).
     */
    restart: (): Promise<void> =>
      ipcRenderer.invoke("ollama:restart"),
    onStatusChanged: (cb: (status: OllamaStatus) => void): (() => void) => {
      const handler = (_e: Electron.IpcRendererEvent, status: OllamaStatus) =>
        cb(status);
      ipcRenderer.on("ollama-status:changed", handler);
      return () => ipcRenderer.removeListener("ollama-status:changed", handler);
    },
    /** Coalesced ~5Hz progress frames during a pull. */
    onPullProgress: (
      cb: (progress: OllamaPullProgress) => void,
    ): (() => void) => {
      const handler = (
        _e: Electron.IpcRendererEvent,
        progress: OllamaPullProgress,
      ) => cb(progress);
      ipcRenderer.on("ollama-pull:progress", handler);
      return () => ipcRenderer.removeListener("ollama-pull:progress", handler);
    },
  },

  // Postgres (Phase 8.v1.0) — bundled local DB substrate. Same shape
  // as `ollama` but read-only at this stage; the renderer uses it
  // exclusively for the Settings status row. Producer subprocesses
  // (8.v1.2+) will get their connection strings from the main process
  // directly, not via the renderer.
  postgres: {
    getStatus: (): Promise<PostgresStatus> =>
      ipcRenderer.invoke("postgres:getStatus"),
    onStatusChanged: (cb: (status: PostgresStatus) => void): (() => void) => {
      const handler = (
        _e: Electron.IpcRendererEvent,
        status: PostgresStatus,
      ) => cb(status);
      ipcRenderer.on("postgres-status:changed", handler);
      return () =>
        ipcRenderer.removeListener("postgres-status:changed", handler);
    },
  },

  // Local producer subprocesses (Phase 8.v1.1). The renderer reads
  // the full list once on mount via `list()` and updates entries
  // individually as `onStatusChanged` fires per-producer diffs.
  producers: {
    list: (): Promise<ProducerStatus[]> =>
      ipcRenderer.invoke("producers:list"),
    onStatusChanged: (cb: (status: ProducerStatus) => void): (() => void) => {
      const handler = (
        _e: Electron.IpcRendererEvent,
        status: ProducerStatus,
      ) => cb(status);
      ipcRenderer.on("producer-status:changed", handler);
      return () =>
        ipcRenderer.removeListener("producer-status:changed", handler);
    },
  },

  // Agent (Phase 8). Renderer initiates a turn with `send`, then watches
  // `onStream` for token / tool-call / tool-result / done / error frames.
  // Status changes (Ollama up, model picked, in-flight) push via
  // `onStatusChanged`, mirroring the auth/ollama channels above.
  agent: {
    getStatus: (): Promise<AgentStatus> =>
      ipcRenderer.invoke("agent:getStatus"),
    send: (input: AgentSendInput): Promise<AgentSendResult> =>
      ipcRenderer.invoke("agent:send", input),
    abort: (requestId?: string): Promise<void> =>
      ipcRenderer.invoke("agent:abort", requestId),
    /** Resolves an open `choice-request` frame. */
    answerChoice: (answer: AgentChoiceAnswer): Promise<void> =>
      ipcRenderer.invoke("agent:answerChoice", answer),
    onStatusChanged: (cb: (status: AgentStatus) => void): (() => void) => {
      const handler = (_e: Electron.IpcRendererEvent, status: AgentStatus) =>
        cb(status);
      ipcRenderer.on("agent-status:changed", handler);
      return () =>
        ipcRenderer.removeListener("agent-status:changed", handler);
    },
    onStream: (cb: (frame: AgentStreamFrame) => void): (() => void) => {
      const handler = (
        _e: Electron.IpcRendererEvent,
        frame: AgentStreamFrame,
      ) => cb(frame);
      ipcRenderer.on("agent:stream", handler);
      return () => ipcRenderer.removeListener("agent:stream", handler);
    },

    // Provider switch (Phase 8.j). Same surface as the in-chat
    // settings_* tools, exposed for the Settings → Agent panel (8.g).
    getProviderConfig: (): Promise<ProviderConfigBundle> =>
      ipcRenderer.invoke("agent:getProviderConfig"),
    /**
     * Phase 8.k2 — catalog of pickable models. Always LLM-role +
     * tool-capable; embeddings are intentionally hidden (vector
     * compatibility lock-in across users).
     */
    listModels: (): Promise<ProviderCatalogEntry[]> =>
      ipcRenderer.invoke("agent:listModels"),
    setProvider: (args: {
      kind: LlmProviderKind;
      model?: string;
    }): Promise<ProviderConfig> =>
      ipcRenderer.invoke("agent:setProvider", args),
    setModel: (args: {
      kind: LlmProviderKind;
      model: string;
    }): Promise<ProviderConfig> =>
      ipcRenderer.invoke("agent:setModel", args),
    setApiKey: (args: {
      kind: HostedProviderKind;
      apiKey: string;
    }): Promise<void> => ipcRenderer.invoke("agent:setApiKey", args),
    /**
     * Phase 8.k10b — verify a hosted-provider key against its cheapest
     * auth-checked endpoint without persisting. Used by the FirstRunWizard
     * skip flow ("Test & continue") and reusable by any future Settings
     * surface that wants a "Test key" affordance.
     */
    validateApiKey: (args: {
      kind: HostedProviderKind;
      apiKey: string;
    }): Promise<ApiKeyValidation> =>
      ipcRenderer.invoke("agent:validateApiKey", args),
    clearApiKey: (args: { kind: HostedProviderKind }): Promise<void> =>
      ipcRenderer.invoke("agent:clearApiKey", args),

    // Memory (Phase 8.d). The probe is the FirstRunWizard's signal that
    // transcripts will (or won't) survive a restart; `listConversations`
    // backs the Chat session dropdown (8.k10h).
    getMemoryProbe: (): Promise<{
      writable: boolean;
      reason?: string;
      path: string;
    }> => ipcRenderer.invoke("agent:getMemoryProbe"),
    listConversations: (): Promise<
      Array<{
        conversationId: string;
        modifiedAt: number;
        sizeBytes: number;
        label: string;
      }>
    > => ipcRenderer.invoke("agent:listConversations"),
    /**
     * Phase 8.k10h — load a transcript by id so the renderer can
     * replay it. Returns [] on unknown id / parse failure.
     */
    loadConversation: (conversationId: string): Promise<AgentMessage[]> =>
      ipcRenderer.invoke("agent:loadConversation", conversationId),
    /** Phase 8.k10h — hard-delete a conversation file. */
    deleteConversation: (conversationId: string): Promise<boolean> =>
      ipcRenderer.invoke("agent:deleteConversation", conversationId),

    // Attachment staging (Phase 8.e). Renderer parses the spreadsheet
    // client-side for the preview chip, then ships the raw bytes here
    // on send. Main holds them keyed by a UUID; tools (import_excel)
    // read them back via that id. Bytes never enter the LLM context.
    stageAttachment: (input: {
      filename: string;
      bytes: Uint8Array;
      sheets: Array<{ name: string; headers: string[]; totalRows: number }>;
    }): Promise<{ id: string; filename: string; sizeBytes: number }> =>
      ipcRenderer.invoke("agent:stageAttachment", input),
    discardAttachment: (id: string): Promise<boolean> =>
      ipcRenderer.invoke("agent:discardAttachment", id),

    // General memory (Phase 8.k10h). Long-term facts the agent can
    // look up via the `recall_memory` tool. The renderer surface here
    // is for a future Settings → Memory pane to let the user audit /
    // delete entries; the agent itself goes through tool calls.
    listGeneralMemory: (): Promise<
      Array<{
        id: string;
        content: string;
        tags?: string[];
        createdAt: number;
      }>
    > => ipcRenderer.invoke("agent:listGeneralMemory"),
    addGeneralMemory: (args: {
      content: string;
      tags?: string[];
    }): Promise<{
      id: string;
      content: string;
      tags?: string[];
      createdAt: number;
    }> => ipcRenderer.invoke("agent:addGeneralMemory", args),
    removeGeneralMemory: (id: string): Promise<boolean> =>
      ipcRenderer.invoke("agent:removeGeneralMemory", id),
  },

  // Heartbeat alerts (Phase 8.f1). The renderer reads + mutates via this
  // surface; main rebroadcasts `alerts-changed` after every successful
  // mutation so every open window can refresh its store without polling.
  alerts: {
    list: (): Promise<Alert[]> => ipcRenderer.invoke("alerts:list"),
    unreadCount: (): Promise<number> =>
      ipcRenderer.invoke("alerts:unreadCount"),
    markSeen: (id: string): Promise<boolean> =>
      ipcRenderer.invoke("alerts:markSeen", id),
    dismiss: (id: string): Promise<boolean> =>
      ipcRenderer.invoke("alerts:dismiss", id),
    /**
     * Force a heartbeat tick now (skipping the cadence wait). Resolves
     * with the tick info — useful for a "Jetzt auslösen" button or for
     * tests driving the system without wall-clock waits.
     *
     * Includes a `decisions[]` array so the Settings panel can show
     * the analyst exactly which candidates were weighed and why
     * (LLM rationale, dedup, judge errors).
     */
    triggerNow: (): Promise<AlertTickInfo> =>
      ipcRenderer.invoke("alerts:triggerNow"),
    /**
     * Last 10 heartbeat ticks (newest first), with their per-candidate
     * decisions. Used by Settings → Meldungen to expose the agent's
     * decision history without having to re-trigger.
     */
    recentTicks: (): Promise<AlertTickInfo[]> =>
      ipcRenderer.invoke("alerts:recentTicks"),
    /** Subscribe to mutation events. Caller receives a void payload —
     *  refetch via `list()` / `unreadCount()` to get the current state. */
    onChanged: (cb: () => void): (() => void) => {
      const handler = () => cb();
      ipcRenderer.on("alerts:changed", handler);
      return () => ipcRenderer.removeListener("alerts:changed", handler);
    },

    // Heartbeat / push prefs (Phase 8.f3). The renderer's Settings
    // page reads + patches via this surface; main rebroadcasts
    // `alert-prefs:changed` so every open window's store re-syncs
    // without polling.
    getPrefs: (): Promise<AlertPrefs> =>
      ipcRenderer.invoke("alert-prefs:get"),
    setPrefs: (patch: Partial<AlertPrefs>): Promise<AlertPrefs> =>
      ipcRenderer.invoke("alert-prefs:set", patch),
    onPrefsChanged: (cb: (prefs: AlertPrefs) => void): (() => void) => {
      const handler = (_e: Electron.IpcRendererEvent, prefs: AlertPrefs) =>
        cb(prefs);
      ipcRenderer.on("alert-prefs:changed", handler);
      return () => ipcRenderer.removeListener("alert-prefs:changed", handler);
    },
    /** Read-only permission gate from the OS (8.f3). The renderer
     *  shows a hint + disables the push toggle when this reports
     *  `available: false`. */
    getNotificationPermission: (): Promise<NotificationPermissionStatus> =>
      ipcRenderer.invoke("notifications:getPermissionStatus"),
    /** Subscribe to the "click on a native notification" event.
     *  The renderer's App.tsx routes to /alerts on every fire. */
    onFocusAlerts: (cb: () => void): (() => void) => {
      const handler = () => cb();
      ipcRenderer.on("notifications:focusAlerts", handler);
      return () =>
        ipcRenderer.removeListener("notifications:focusAlerts", handler);
    },
  },

  // Recent-interest signal (Phase 8.r4). Renderer pings on
  // CompanyDetail mounts + chat company-link clicks; the freshness
  // scheduler reads the resulting boost during scoring. Fire-and-
  // forget; the IPC return is `void`.
  interest: {
    record: (companyId: string): Promise<void> =>
      ipcRenderer.invoke("interest:record", companyId),
  },

  // Standing watches (Phase 8.t2). Read + simple mutations only —
  // creation stays in the chat tool because the propose-and-confirm
  // gate is the whole point. The `onChanged` push is fired by main
  // after every successful mutation so the topbar chip + Settings
  // panel re-sync.
  watches: {
    list: (): Promise<Watch[]> => ipcRenderer.invoke("watches:list"),
    remove: (id: string): Promise<boolean> =>
      ipcRenderer.invoke("watches:remove", id),
    setEnabled: (id: string, enabled: boolean): Promise<boolean> =>
      ipcRenderer.invoke("watches:setEnabled", { id, enabled }),
    onChanged: (cb: (snapshot: Watch[]) => void): (() => void) => {
      const handler = (_e: Electron.IpcRendererEvent, snapshot: Watch[]) =>
        cb(snapshot);
      ipcRenderer.on("watches:changed", handler);
      return () => ipcRenderer.removeListener("watches:changed", handler);
    },
  },

  // User profile (Phase 8.t1). Settings panel reads via `get` and
  // writes via `set` (direct, no propose-and-confirm — the panel IS
  // the explicit user surface). `clear` wipes back to defaults. The
  // `onChanged` push is fired by main after every successful write so
  // the panel + every other window mirror re-syncs.
  profile: {
    get: (): Promise<UserProfile> => ipcRenderer.invoke("profile:get"),
    set: (patch: Partial<UserProfile>): Promise<UserProfile> =>
      ipcRenderer.invoke("profile:set", patch),
    clear: (): Promise<UserProfile> => ipcRenderer.invoke("profile:clear"),
    onChanged: (cb: (profile: UserProfile) => void): (() => void) => {
      const handler = (
        _e: Electron.IpcRendererEvent,
        profile: UserProfile,
      ) => cb(profile);
      ipcRenderer.on("profile:changed", handler);
      return () => ipcRenderer.removeListener("profile:changed", handler);
    },
  },

  // Voice / whisper sidecar (Phase 8.n1). The renderer reads
  // `getStatus` on mount, subscribes to `onStatusChanged` for
  // lifecycle transitions, and drives the model download via
  // `downloadModel` (progress arrives on `onProgress`). The
  // `transcribe` path is wired but stubbed in 8.n1 — a renderer
  // calling it gets a placeholder string so the mic-button → IPC →
  // textarea round-trip can be exercised before whisper.cpp itself
  // is bundled.
  voice: {
    getStatus: (): Promise<VoiceStatus> =>
      ipcRenderer.invoke("voice:getStatus"),
    downloadModel: (): Promise<void> =>
      ipcRenderer.invoke("voice:downloadModel"),
    cancelDownload: (): Promise<void> =>
      ipcRenderer.invoke("voice:cancelDownload"),
    deleteModel: (): Promise<void> =>
      ipcRenderer.invoke("voice:deleteModel"),
    transcribe: (audio: Uint8Array): Promise<{ text: string }> =>
      ipcRenderer.invoke("voice:transcribe", audio),
    /** Synchronous-style mic-permission read. macOS returns one of
     *  'not-determined' | 'granted' | 'denied' | 'restricted' |
     *  'unknown'; other platforms return 'unsupported' (no
     *  electron-queryable equivalent — rely on getUserMedia errors).
     *  `appNameInSettings` is what System Settings shows next to the
     *  toggle: "Electron" in dev (shared dev binary), the packaged
     *  product name in production. The renderer uses this to give
     *  the user the right thing to look for. */
    getMicPermission: (): Promise<{
      status:
        | "not-determined"
        | "granted"
        | "denied"
        | "restricted"
        | "unknown"
        | "unsupported";
      appNameInSettings: string;
      isDev: boolean;
    }> => ipcRenderer.invoke("voice:micPermission"),
    /** Pops the OS prompt on macOS the first time, returns the user's
     *  decision. Always resolves true on platforms without an OS gate. */
    requestMicPermission: (): Promise<boolean> =>
      ipcRenderer.invoke("voice:requestMicPermission"),
    /** Deep-link the OS privacy settings to the per-app mic toggle. */
    openMicSettings: (): Promise<void> =>
      ipcRenderer.invoke("voice:openMicSettings"),
    /** Auto-install whisper-cli (PATH lookup → Homebrew → mirror).
     *  Streams stdout via `onInstallLog`. */
    installBinary: (): Promise<void> =>
      ipcRenderer.invoke("voice:installBinary"),
    onInstallLog: (cb: (line: string) => void): (() => void) => {
      const handler = (_e: Electron.IpcRendererEvent, line: string) =>
        cb(line);
      ipcRenderer.on("voice:install:log", handler);
      return () => ipcRenderer.removeListener("voice:install:log", handler);
    },
    onStatusChanged: (cb: (status: VoiceStatus) => void): (() => void) => {
      const handler = (_e: Electron.IpcRendererEvent, status: VoiceStatus) =>
        cb(status);
      ipcRenderer.on("voice:status:changed", handler);
      return () => ipcRenderer.removeListener("voice:status:changed", handler);
    },
    onProgress: (
      cb: (p: VoiceModelDownloadProgress) => void,
    ): (() => void) => {
      const handler = (
        _e: Electron.IpcRendererEvent,
        p: VoiceModelDownloadProgress,
      ) => cb(p);
      ipcRenderer.on("voice:download:progress", handler);
      return () =>
        ipcRenderer.removeListener("voice:download:progress", handler);
    },
  },

  // Freshness scheduler (Phase 8.r3). Read-only views (`getPrefs`,
  // `recentTicks`) plus mutations (`setPrefs`, `triggerNow`). The
  // `onPrefsChanged` push is fired by main after every successful
  // `set` so the Settings panel can re-sync without polling.
  freshness: {
    getPrefs: (): Promise<FreshnessPrefs> =>
      ipcRenderer.invoke("freshness:getPrefs"),
    setPrefs: (patch: Partial<FreshnessPrefs>): Promise<FreshnessPrefs> =>
      ipcRenderer.invoke("freshness:setPrefs", patch),
    /** Force a tick now; returns the same shape `recentTicks` lists. */
    triggerNow: (): Promise<FreshnessTickInfo> =>
      ipcRenderer.invoke("freshness:triggerNow"),
    /** Last 10 ticks (newest first). */
    recentTicks: (): Promise<FreshnessTickInfo[]> =>
      ipcRenderer.invoke("freshness:recentTicks"),
    onPrefsChanged: (
      cb: (prefs: FreshnessPrefs) => void,
    ): (() => void) => {
      const handler = (
        _e: Electron.IpcRendererEvent,
        prefs: FreshnessPrefs,
      ) => cb(prefs);
      ipcRenderer.on("freshness:prefs-changed", handler);
      return () =>
        ipcRenderer.removeListener("freshness:prefs-changed", handler);
    },
  },
} as const;

contextBridge.exposeInMainWorld("api", api);

export type Api = typeof api;

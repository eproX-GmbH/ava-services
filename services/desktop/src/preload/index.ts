import { contextBridge, ipcRenderer } from "electron";
import type {
  AgentChoiceAnswer,
  AgentMessage,
  AgentSendInput,
  AgentSendResult,
  AgentStatus,
  AgentStreamFrame,
  ConversationSearchHit,
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
  ProducerLogEvent,
  ProducerLogLine,
  ProducerScreenshotEntry,
  ProducerStatus,
  ExternalServiceStatus,
  ExternalServicesStatus,
  CrmProviderKind,
  CrmProviderStatus,
  LinkedInAuthStatus,
  LinkedInFeedCounts,
  LinkedInLoginResult,
  LinkedInImageAnalysisStatus,
  LinkedInLinkedSignal,
  LinkedInLinkerStatus,
  LinkedInRecentPost,
  LinkedInRunListEntry,
  LinkedInScanResult,
  LinkedInScanStatus,
  LinkedInSettings,
  LinkedInSignalDetail,
  LinkedInSignalListFilter,
  LinkedInSignalListRow,
  LinkedInSignalStatus,
  UpdateStatus,
  ProviderCatalogEntry,
  ProviderConfig,
  ProviderConfigBundle,
  SkillBody,
  SkillDeleteResult,
  SkillExportAllResult,
  SkillExportResult,
  SkillImportCommit,
  SkillImportCommitResult,
  SkillImportResult,
  SkillRow,
  SkillSavePayload,
  SkillSaveResult,
} from "../shared/types";
export type {
  AgentChoiceAnswer,
  AgentChoiceOption,
  AgentMessage,
  AgentSendInput,
  AgentSendResult,
  AgentStatus,
  AgentStreamFrame,
  ConversationSearchHit,
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
  ProducerLogEvent,
  ProducerLogLine,
  ProducerScreenshotEntry,
  ProducerStatus,
  ExternalServiceStatus,
  ExternalServicesStatus,
  CrmProviderKind,
  CrmProviderStatus,
  LinkedInAuthStatus,
  LinkedInFeedCounts,
  LinkedInFingerprint,
  LinkedInLoginResult,
  LinkedInRecentPost,
  LinkedInScanOutcome,
  LinkedInScanResult,
  LinkedInImageAnalysisStatus,
  LinkedInLinkedSignal,
  LinkedInLinkerStatus,
  LinkedInScanStatus,
  LinkedInSessionMeta,
  LinkedInSettings,
  LinkedInSignalDetail,
  LinkedInSignalListFilter,
  LinkedInSignalListRow,
  LinkedInSignalStatus,
  UpdateStatus,
  ProviderCatalogEntry,
  ProviderConfig,
  ProviderConfigBundle,
  ProviderStatusSnapshot,
  QuietHoursConfig,
  SkillB2bScope,
  SkillBody,
  SkillDeleteResult,
  SkillExportAllResult,
  SkillExportResult,
  SkillImportAction,
  SkillImportCommit,
  SkillImportCommitEntry,
  SkillImportCommitResult,
  SkillImportConflict,
  SkillImportResult,
  SkillImportStagedEntry,
  SkillLanguage,
  SkillRow,
  SkillSavePayload,
  SkillSaveResult,
  SkillScope,
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

  // Auto-updater (Phase 8.u4). Renderer drives `check`/`download`/
  // `install` from the Settings panel; status pushes via the
  // `updater-status:changed` channel.
  updater: {
    getStatus: (): Promise<UpdateStatus> =>
      ipcRenderer.invoke("updater:getStatus"),
    check: (): Promise<void> => ipcRenderer.invoke("updater:check"),
    download: (): Promise<void> => ipcRenderer.invoke("updater:download"),
    install: (): Promise<void> => ipcRenderer.invoke("updater:install"),
    onStatusChanged: (cb: (status: UpdateStatus) => void): (() => void) => {
      const handler = (_e: Electron.IpcRendererEvent, status: UpdateStatus) =>
        cb(status);
      ipcRenderer.on("updater-status:changed", handler);
      return () =>
        ipcRenderer.removeListener("updater-status:changed", handler);
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
    /** Producer log streaming (v0.1.50). The Logs tab in the matrix
     *  drill-down panel calls `tail` once on mount for backfill, then
     *  subscribes via `onLine` for the live tail. Ring buffer in the
     *  main process caps memory at ~5000 lines per producer. */
    logs: {
      tail: (
        producer: string,
        limit?: number,
      ): Promise<ProducerLogLine[]> =>
        ipcRenderer.invoke("producers:logs:tail", { producer, limit }),
      onLine: (
        cb: (event: ProducerLogEvent) => void,
      ): (() => void) => {
        const handler = (
          _e: Electron.IpcRendererEvent,
          event: ProducerLogEvent,
        ) => cb(event);
        ipcRenderer.on("producer-log:line", handler);
        return () => ipcRenderer.removeListener("producer-log:line", handler);
      },
    },
    /** Selenium screenshots (v0.1.50). Producer drops PNGs to disk via
     *  AVA_SCREENSHOT_DIR; the renderer lists them by (producer, runId)
     *  where runId = `${transactionId}:${companyId}`. Image bytes are
     *  served via the custom `ava-screenshot://` protocol so the
     *  renderer can use a normal <img src> instead of base64 IPC. */
    screenshots: {
      list: (
        producer: string,
        runId: string,
      ): Promise<ProducerScreenshotEntry[]> =>
        ipcRenderer.invoke("producers:screenshots:list", { producer, runId }),
      urlFor: (
        producer: string,
        runId: string,
        filename: string,
      ): string =>
        `ava-screenshot://${encodeURIComponent(producer)}/${encodeURIComponent(runId)}/${encodeURIComponent(filename)}`,
    },
  },

  /** v0.1.52 — external upstream reachability (today: only
   *  unternehmensregister.de). Renderer reads on mount + subscribes
   *  to push events for transitions. Drives the under-topbar banner
   *  when the site is unreachable. */
  externalService: {
    getStatus: (): Promise<ExternalServicesStatus> =>
      ipcRenderer.invoke("external-service:getStatus"),
    probeNow: (): Promise<ExternalServicesStatus> =>
      ipcRenderer.invoke("external-service:probeNow"),
    onStatusChanged: (
      cb: (status: ExternalServicesStatus) => void,
    ): (() => void) => {
      const handler = (
        _e: Electron.IpcRendererEvent,
        status: ExternalServicesStatus,
      ) => cb(status);
      ipcRenderer.on("external-service-status:changed", handler);
      return () =>
        ipcRenderer.removeListener("external-service-status:changed", handler);
    },
  },

  /** v0.1.54 — CRM connections (Salesforce / HubSpot / Dynamics).
   *  Tokens never cross this boundary; only metadata + status. The
   *  Settings panel surfaces a card per provider; the chat agent
   *  drives the same calls via `connect_crm` / `disconnect_crm`. */
  crm: {
    list: (): Promise<CrmProviderStatus[]> => ipcRenderer.invoke("crm:list"),
    getStatus: (provider: CrmProviderKind): Promise<CrmProviderStatus> =>
      ipcRenderer.invoke("crm:getStatus", provider),
    /** Run the interactive OAuth flow. Resolves with the new status
     *  once tokens are persisted, or rejects on cancel / IdP error. */
    connect: (
      provider: CrmProviderKind,
      opts?: { orgUrl?: string },
    ): Promise<CrmProviderStatus> =>
      ipcRenderer.invoke("crm:connect", { provider, orgUrl: opts?.orgUrl }),
    disconnect: (provider: CrmProviderKind): Promise<CrmProviderStatus> =>
      ipcRenderer.invoke("crm:disconnect", provider),
    onStatusChanged: (
      cb: (status: CrmProviderStatus) => void,
    ): (() => void) => {
      const handler = (
        _e: Electron.IpcRendererEvent,
        status: CrmProviderStatus,
      ) => cb(status);
      ipcRenderer.on("crm-status:changed", handler);
      return () => ipcRenderer.removeListener("crm-status:changed", handler);
    },

    /** C4 — pass-through to /v1/companies/:id/crm. Returned shape:
     *  `{ links: Array<{ crmType, crmExternalId, crmDisplayName, ... }> }`. */
    listLinks: (companyId: string): Promise<unknown> =>
      ipcRenderer.invoke("crm:list:links", { companyId }),
    /** C4 — pass-through to /v1/companies/:id/crm/details. Returned shape:
     *  `{ details: Array<{ crmType, fetchedAt, notConfigured?, contacts?, deals?, ... }> }`. */
    fetchDetails: (
      companyId: string,
      opts?: { refresh?: boolean },
    ): Promise<unknown> =>
      ipcRenderer.invoke("crm:details:fetch", {
        companyId,
        refresh: opts?.refresh ?? false,
      }),
    /** C4 — run a HubSpot live enrichment fetch on this device and push
     *  the resulting payload to the gateway cache. Caller passes the
     *  AVA companyId + the CRM-side external id (HubSpot company id). */
    enrich: (
      args: { companyId: string; crmExternalId: string; crmType?: CrmProviderKind },
    ): Promise<{ ok: true; fetchedAt: string } | { ok: false; error: string }> =>
      ipcRenderer.invoke("crm:enrich:run", args),
    /** C4 — HubSpot company search for the manual-link picker dialog. */
    searchHubspotCompanies: (args: {
      query: string;
      limit?: number;
    }): Promise<{
      items: Array<{
        id: string;
        name: string | null;
        domain: string | null;
        city: string | null;
      }>;
      error?: string;
    }> => ipcRenderer.invoke("crm:hubspot:searchCompanies", args),
    /** C4 — create or replace a manual CompanyCrmLink. */
    linkManually: (args: {
      companyId: string;
      crmType: "HUBSPOT" | "SALESFORCE" | "DYNAMICS";
      crmExternalId: string;
      crmDisplayName?: string | null;
    }): Promise<{ ok: true } | { ok: false; error: string }> =>
      ipcRenderer.invoke("crm:linkManually", args),
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
     * Option D — BYO-key passthrough. Used by `gatewayUpload` to
     * attach the user's active LLM (provider, key, model) on the
     * dispatch HTTP headers. Returns null when no provider is
     * configured, the active provider is keyless (Ollama), or the
     * key blob can't be decrypted.
     */
    getActiveUserLlm: (): Promise<{
      provider: string;
      key: string;
      model?: string;
    } | null> => ipcRenderer.invoke("agent:getActiveUserLlm"),
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
    /**
     * v0.1.85 — full-text search across every conversation file.
     * Case-insensitive, whitespace-split AND. User + assistant only.
     * Returns at most `limit` hits, capped to `perChat` per
     * conversation. Sorted by recency.
     */
    searchConversations: (args: {
      query: string;
      limit?: number;
      perChat?: number;
    }): Promise<ConversationSearchHit[]> =>
      ipcRenderer.invoke("agent:searchConversations", args),

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

  // v0.1.101 — generic shell.openExternal bridge for plain external
  // links (Enterprise contact page, etc.). Constrained to http/https
  // schemes main-side so the renderer can't shell out to arbitrary
  // protocols.
  shell: {
    openExternal: (url: string): Promise<void> =>
      ipcRenderer.invoke("shell:openExternal", url),
  },

  // M3 monetization (v0.1.73) — Stripe Checkout + Customer Portal.
  // The renderer never sees Stripe URLs directly: main calls the
  // gateway with the user's bearer token, gets back a one-shot URL,
  // and shells it out via `shell.openExternal`. Renderer only needs
  // to know "did it open OK" (resolves) or "what error" (rejects with
  // the gateway's `message`).
  billing: {
    openCheckout: (tier: "starter" | "pro"): Promise<void> =>
      ipcRenderer.invoke("billing:openCheckout", tier),
    openPortal: (): Promise<void> => ipcRenderer.invoke("billing:openPortal"),
    /** Fired by the `ava://billing/success` protocol handler so the
     *  renderer can invalidate the `["usage"]` query and surface the
     *  new tier without polling. */
    onSuccess: (cb: () => void): (() => void) => {
      const handler = () => cb();
      ipcRenderer.on("billing:success", handler);
      return () => ipcRenderer.removeListener("billing:success", handler);
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

  /** LinkedIn-Beobachter (Phase L0). On/off + consent + kill-switch.
   *  All persisted state lives on this device; the gateway never sees
   *  any of it. Future phases will add cookies + scraped posts under
   *  the same userData/linkedin/ tree. */
  // User-authored skills (PLAN §2, S3). Settings panel reads `list()`
  // on mount and subscribes to `onChanged` so file-watcher reloads
  // refresh the UI. `getBody(name)` powers the read-only markdown
  // viewer. `setEnabled` persists in `<userData>/skills-prefs.json`
  // and the orchestrator skips disabled skills on the next turn.
  skills: {
    list: (): Promise<SkillRow[]> => ipcRenderer.invoke("skills:list"),
    getBody: (name: string): Promise<SkillBody | null> =>
      ipcRenderer.invoke("skills:getBody", name),
    setEnabled: (name: string, enabled: boolean): Promise<void> =>
      ipcRenderer.invoke("skills:setEnabled", { name, enabled }),
    reload: (): Promise<void> => ipcRenderer.invoke("skills:reload"),
    /** Opens a directory or file in Finder/Explorer. Without a path,
     *  opens the user-scope skills directory. */
    openPath: (target?: string): Promise<{ ok: true } | { error: string }> =>
      ipcRenderer.invoke("skills:openSourceDir", target),
    onChanged: (cb: () => void): (() => void) => {
      const handler = () => cb();
      ipcRenderer.on("skills:changed", handler);
      return () => ipcRenderer.removeListener("skills:changed", handler);
    },
    // S4 — author + manage skills in-app. `save()` runs server-side
    // schema validation and writes to <userData>/skills/<name>/SKILL.md
    // (auto-trusted on save). `trust()` flips a row from
    // untrusted/modified → trusted after the user accepts the dialog.
    // `delete()` removes a user-scope skill; workspace skills are
    // refused. `listAvailableTools()` powers the editor's chip
    // multi-select.
    save: (payload: SkillSavePayload): Promise<SkillSaveResult> =>
      ipcRenderer.invoke("skills:save", payload),
    delete: (name: string): Promise<SkillDeleteResult> =>
      ipcRenderer.invoke("skills:delete", name),
    trust: (name: string): Promise<void> =>
      ipcRenderer.invoke("skills:trust", name),
    listAvailableTools: (): Promise<string[]> =>
      ipcRenderer.invoke("skills:listAvailableTools"),
    // S5 — import / export. `export` + `exportAll` open native save
    // dialogs main-side. `pickImportFile` returns either a path or a
    // cancellation marker; the renderer then routes to `importZip`.
    // Drag-and-drop sidesteps the picker by handing the renderer a
    // `File` whose `.path` it ships straight into `importZip`.
    export: (name: string): Promise<SkillExportResult> =>
      ipcRenderer.invoke("skills:export", name),
    exportAll: (): Promise<SkillExportAllResult> =>
      ipcRenderer.invoke("skills:exportAll"),
    pickImportFile: (): Promise<{ path: string } | { cancelled: true }> =>
      ipcRenderer.invoke("skills:pickImportFile"),
    importZip: (localPath: string): Promise<SkillImportResult> =>
      ipcRenderer.invoke("skills:importZip", localPath),
    importMarkdown: (body: string): Promise<SkillImportResult> =>
      ipcRenderer.invoke("skills:importMarkdown", body),
    commitImport: (
      payload: SkillImportCommit,
    ): Promise<SkillImportCommitResult> =>
      ipcRenderer.invoke("skills:commitImport", payload),
    cancelImport: (stagingId: string): Promise<void> =>
      ipcRenderer.invoke("skills:cancelImport", stagingId),
  },

  linkedin: {
    getSettings: (): Promise<LinkedInSettings> =>
      ipcRenderer.invoke("linkedin:settings:get"),
    updateSettings: (
      partial: Partial<LinkedInSettings>,
    ): Promise<LinkedInSettings | { error: string }> =>
      ipcRenderer.invoke("linkedin:settings:update", partial),
    acceptConsent: (): Promise<LinkedInSettings> =>
      ipcRenderer.invoke("linkedin:consent:accept"),
    revokeConsent: (): Promise<LinkedInSettings> =>
      ipcRenderer.invoke("linkedin:consent:revoke"),
    killSwitch: (): Promise<{ ok: true }> =>
      ipcRenderer.invoke("linkedin:killswitch"),
    /** L1 — embedded-BrowserWindow login flow. The cookies captured
     *  by `openLogin` never cross this bridge: only metadata
     *  (capturedAt, earliestExpiresAt, memberUrn) is exposed. */
    auth: {
      status: (): Promise<LinkedInAuthStatus> =>
        ipcRenderer.invoke("linkedin:auth:status"),
      openLogin: (): Promise<LinkedInLoginResult> =>
        ipcRenderer.invoke("linkedin:auth:openLogin"),
      disconnect: (): Promise<{ ok: true }> =>
        ipcRenderer.invoke("linkedin:auth:disconnect"),
    },
    /** L2 — feed scraper. Cookies stay main-side; the renderer only
     *  ever sees aggregate counts and post metadata. */
    scan: {
      run: (args?: { manual?: boolean; maxPosts?: number }): Promise<LinkedInScanResult> =>
        ipcRenderer.invoke("linkedin:scan:run", args ?? { manual: true }),
      cancel: (): Promise<{ ok: true }> =>
        ipcRenderer.invoke("linkedin:scan:cancel"),
      status: (): Promise<LinkedInScanStatus> =>
        ipcRenderer.invoke("linkedin:scan:status"),
    },
    /** v0.1.109 — per-run diagnostic artefacts. Each row points at a
     *  folder full of screenshots + a `run.json`. Used by the "Letzte
     *  Läufe" panel so the user can inspect what the scraper saw. */
    runs: {
      list: (): Promise<LinkedInRunListEntry[]> =>
        ipcRenderer.invoke("linkedin:runs:list"),
      openFolder: (dir: string): Promise<{ ok: true } | { error: string }> =>
        ipcRenderer.invoke("linkedin:runs:openFolder", { dir }),
    },
    feed: {
      counts: (): Promise<LinkedInFeedCounts> =>
        ipcRenderer.invoke("linkedin:feed:counts"),
      recent: (
        args?: { limit?: number; offset?: number; since?: number },
      ): Promise<LinkedInRecentPost[]> =>
        ipcRenderer.invoke("linkedin:feed:recent", args ?? {}),
      /** L6 — broad filterable list for the /linkedin route + agent. */
      listSignals: (
        filter?: LinkedInSignalListFilter,
      ): Promise<LinkedInSignalListRow[]> =>
        ipcRenderer.invoke("linkedin:feed:listSignals", filter ?? {}),
      /** L6 — single-signal detail for the expanded card view. */
      signalDetail: (
        postUrn: string,
      ): Promise<LinkedInSignalDetail | null> =>
        ipcRenderer.invoke("linkedin:feed:signalDetail", { postUrn }),
      /** L6 — relative URL for a media file the route renders. */
      mediaUrl: (relPath: string): string => {
        const safe = relPath
          .split("/")
          .map((s) => encodeURIComponent(s))
          .join("/");
        return `ava-linkedin-media://${safe}`;
      },
    },
    /** L3 — text-topic extraction. The renderer polls `status` for
     *  Settings telemetry; signal CONTENT does not surface yet (L6). */
    signals: {
      status: (): Promise<LinkedInSignalStatus> =>
        ipcRenderer.invoke("linkedin:signals:status"),
      run: (): Promise<LinkedInSignalStatus> =>
        ipcRenderer.invoke("linkedin:signals:run"),
      cancel: (): Promise<{ ok: true }> =>
        ipcRenderer.invoke("linkedin:signals:cancel"),
      /** L6 — toggle dismissal on a single signal. */
      dismiss: (
        postUrn: string,
        dismissed: boolean,
      ): Promise<{ ok: true }> =>
        ipcRenderer.invoke("linkedin:signals:dismiss", { postUrn, dismissed }),
    },
    /** L4 — vision-LLM image analysis. Telemetry only for now (no
     *  separate run/cancel — the existing signals.run/cancel covers
     *  both phases). Counts surface in feed.counts.imageAnalyses. */
    images: {
      status: (): Promise<LinkedInImageAnalysisStatus> =>
        ipcRenderer.invoke("linkedin:images:status"),
    },
    /** L5 — entity linking against master-data companies + contacts.
     *  Telemetry only in Settings. signalsForCompany feeds L6. */
    linker: {
      status: (): Promise<LinkedInLinkerStatus> =>
        ipcRenderer.invoke("linkedin:linker:status"),
      signalsForCompany: (args: {
        companyId: string;
        limit?: number;
        offset?: number;
      }): Promise<LinkedInLinkedSignal[]> =>
        ipcRenderer.invoke("linkedin:linker:signalsForCompany", args),
    },
  },
} as const;

contextBridge.exposeInMainWorld("api", api);

export type Api = typeof api;

import { contextBridge, ipcRenderer } from "electron";
import type {
  AgentChoiceAnswer,
  AgentSendInput,
  AgentSendResult,
  AgentStatus,
  AgentStreamFrame,
  AuthStatus,
  AppConfig,
  LlmProviderKind,
  OllamaPullProgress,
  OllamaStatus,
  ProviderConfig,
  ProviderConfigBundle,
} from "../shared/types";
export type {
  AgentChoiceAnswer,
  AgentChoiceOption,
  AgentSendInput,
  AgentSendResult,
  AgentStatus,
  AgentStreamFrame,
  AppConfig,
  AuthStatus,
  LlmProviderKind,
  OllamaPullProgress,
  OllamaStatus,
  ProviderConfig,
  ProviderConfigBundle,
  ProviderStatusSnapshot,
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
    setProvider: (args: {
      kind: LlmProviderKind;
      model?: string;
    }): Promise<ProviderConfig> =>
      ipcRenderer.invoke("agent:setProvider", args),
    setOpenAiKey: (apiKey: string): Promise<void> =>
      ipcRenderer.invoke("agent:setOpenAiKey", apiKey),
    clearOpenAiKey: (): Promise<void> =>
      ipcRenderer.invoke("agent:clearOpenAiKey"),

    // Memory (Phase 8.d). The probe is the FirstRunWizard's signal that
    // transcripts will (or won't) survive a restart; `listConversations`
    // backs a future "recent conversations" pane.
    getMemoryProbe: (): Promise<{
      writable: boolean;
      reason?: string;
      path: string;
    }> => ipcRenderer.invoke("agent:getMemoryProbe"),
    listConversations: (): Promise<
      Array<{ conversationId: string; modifiedAt: number; sizeBytes: number }>
    > => ipcRenderer.invoke("agent:listConversations"),
  },
} as const;

contextBridge.exposeInMainWorld("api", api);

export type Api = typeof api;

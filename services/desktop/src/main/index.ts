import { app, BrowserWindow, ipcMain, shell } from "electron";
import { join } from "node:path";
import { Auth, type AuthStatus } from "./auth";
import { OllamaSupervisor } from "./ollama-supervisor";
import {
  AgentOrchestrator,
  GatewayClient,
  LlmProviderManager,
  MemoryStore,
  buildReadOnlyRegistry,
} from "./agent";
import type { ProviderConfig, LlmProviderKind } from "./agent";
import type { HostedProviderKind } from "../shared/types";
import type {
  AgentChoiceAnswer,
  AgentSendInput,
  AgentStatus,
  AgentStreamFrame,
  OllamaPullProgress,
  OllamaStatus,
} from "../shared/types";

// Main process.
//
// Responsibilities:
//   1. Single BrowserWindow with secure defaults
//      (contextIsolation, sandbox, no Node in renderer).
//   2. OIDC Authorization Code + PKCE flow in `Auth` (./auth.ts).
//   3. IPC bridge: renderer can request status, sign in / out, and pull
//      a fresh access token before each gateway call.
//
// Auth status is *pushed* to every window via `auth-status:changed` so
// renderer code can react without polling.

const GATEWAY_URL = process.env.GATEWAY_URL ?? "http://localhost:8080";

// OIDC config. Defaults aimed at the dev Keycloak compose service; in a
// packaged build these come from the build-time env (see electron-builder
// extraResources or a runtime config file in app.getPath('userData')).
const AUTH_ISSUER =
  process.env.AUTH_ISSUER ?? "http://auth.localhost/realms/ava";
const AUTH_CLIENT_ID = process.env.AUTH_CLIENT_ID ?? "ava-desktop";

const auth = new Auth(AUTH_ISSUER, AUTH_CLIENT_ID);

function broadcastAuthStatus(status: AuthStatus): void {
  for (const win of BrowserWindow.getAllWindows()) {
    win.webContents.send("auth-status:changed", status);
  }
}
auth.on("status", broadcastAuthStatus);

// Ollama supervisor (D7). Started on app.whenReady, stopped on before-quit.
// Disabled by setting AVA_DISABLE_OLLAMA=1 — used in CI / mock-gateway dev
// where there's nothing to run locally.
const ollama = new OllamaSupervisor();

function broadcastOllamaStatus(status: OllamaStatus): void {
  for (const win of BrowserWindow.getAllWindows()) {
    win.webContents.send("ollama-status:changed", status);
  }
}
function broadcastOllamaPullProgress(progress: OllamaPullProgress): void {
  for (const win of BrowserWindow.getAllWindows()) {
    win.webContents.send("ollama-pull:progress", progress);
  }
}
ollama.on("status", broadcastOllamaStatus);
ollama.on("progress", broadcastOllamaPullProgress);

// Agent orchestrator (Phase 8.a + 8.b).
//
// Single instance shared across windows — conversations are addressed by
// the renderer-supplied `conversationId`. Stream frames fan out to every
// window; the renderer filters by `requestId`.
//
// Phase 8.b: the gateway-backed read tools register up-front. Each tool
// reads the access token at call time via `auth.getAccessToken()` so
// re-auth/refresh is transparent to the model.
const gatewayClient = new GatewayClient({
  baseUrl: GATEWAY_URL,
  getAccessToken: () => auth.getAccessToken(),
});
// Provider manager (Phase 8.j). Owns the Ollama + OpenAI providers and
// the persisted config under userData/agent/. Constructed before the
// registry so the settings tools can hold a reference to it.
const providers = new LlmProviderManager(ollama);
const agentRegistry = buildReadOnlyRegistry({
  gateway: gatewayClient,
  providers,
});

// Memory store (Phase 8.d). Probed once at boot — if the userData/agent/memory
// directory isn't writable (read-only volume, sandbox glitch, …) we surface
// the reason via AgentStatus.memoryError so the FirstRunWizard can flag it,
// and we run the orchestrator without the on-disk mirror. Conversations
// still work in-memory for the lifetime of the process.
const memory = new MemoryStore();
const memoryProbe = memory.probe();
if (!memoryProbe.writable) {
  console.warn(
    `[memory] probe failed at ${memoryProbe.path}: ${memoryProbe.reason}`,
  );
}
const agent = new AgentOrchestrator({
  providers,
  registry: agentRegistry,
  memory: memoryProbe.writable ? memory : undefined,
  memoryError: memoryProbe.writable
    ? null
    : `${memoryProbe.path}: ${memoryProbe.reason ?? "not writable"}`,
});

function broadcastAgentStream(frame: AgentStreamFrame): void {
  for (const win of BrowserWindow.getAllWindows()) {
    win.webContents.send("agent:stream", frame);
  }
}
function broadcastAgentStatus(status: AgentStatus): void {
  for (const win of BrowserWindow.getAllWindows()) {
    win.webContents.send("agent-status:changed", status);
  }
}
agent.on("stream", broadcastAgentStream);
agent.on("status", broadcastAgentStatus);

function createMainWindow(): BrowserWindow {
  const win = new BrowserWindow({
    width: 1280,
    height: 800,
    minWidth: 960,
    minHeight: 600,
    show: false,
    autoHideMenuBar: true,
    webPreferences: {
      preload: join(__dirname, "../preload/index.js"),
      contextIsolation: true,
      sandbox: true,
      nodeIntegration: false,
    },
  });

  win.on("ready-to-show", () => win.show());

  // External links open in the user's browser, not inside the app.
  win.webContents.setWindowOpenHandler(({ url }) => {
    void shell.openExternal(url);
    return { action: "deny" };
  });

  if (process.env["ELECTRON_RENDERER_URL"]) {
    void win.loadURL(process.env["ELECTRON_RENDERER_URL"]);
  } else {
    void win.loadFile(join(__dirname, "../renderer/index.html"));
  }
  return win;
}

app.whenReady().then(async () => {
  // ---- IPC contract ---------------------------------------------------------
  //
  // `app:getConfig` returns *static* boot config — gateway URL only. The
  // access token is no longer included here; renderer fetches it on demand
  // via `auth:getAccessToken` so it always gets a fresh-enough one.
  ipcMain.handle("app:getConfig", () => ({ gatewayUrl: GATEWAY_URL }));

  ipcMain.handle("auth:getStatus", () => auth.getStatus());
  ipcMain.handle("auth:getAccessToken", () => auth.getAccessToken());
  ipcMain.handle("auth:signIn", () => auth.signIn());
  ipcMain.handle("auth:signOut", () => auth.signOut());

  // Ollama supervisor IPC. The renderer drives:
  //   - getStatus on startup (then subscribes to `ollama-status:changed`)
  //   - pullModel during the FirstRunWizard (progress arrives via
  //     `ollama-pull:progress`, terminal frame as the resolved value)
  ipcMain.handle("ollama:getStatus", () => ollama.getStatus());
  ipcMain.handle("ollama:pullModel", (_e, modelName: string) =>
    ollama.pullModel(modelName),
  );

  // Agent IPC. Stream frames arrive via `agent:stream`; the renderer is
  // expected to filter by `requestId` (the protocol leaves room for future
  // parallel requests, but 8.a only allows one in-flight at a time).
  ipcMain.handle("agent:getStatus", () => agent.getStatus());
  ipcMain.handle("agent:send", (_e, input: AgentSendInput) => agent.send(input));
  ipcMain.handle("agent:abort", (_e, requestId?: string) => {
    agent.abort(requestId);
  });
  ipcMain.handle("agent:answerChoice", (_e, answer: AgentChoiceAnswer) => {
    agent.answerChoice(answer.choiceId, answer.value);
  });

  // Provider switch IPC (Phase 8.j). Mirrors the settings_* tools so the
  // forthcoming Settings → Agent panel (8.g) can drive the same surface.
  ipcMain.handle("agent:getProviderConfig", () => providers.getConfigBundle());
  // Catalog projection (Phase 8.k2). Always LLM + tool-capable models —
  // see LlmProviderManager.listModels() for the rationale.
  ipcMain.handle("agent:listModels", () => providers.listModels());
  ipcMain.handle(
    "agent:setProvider",
    (_e, args: { kind: LlmProviderKind; model?: string }): ProviderConfig =>
      providers.setProvider(args.kind, { model: args.model }),
  );
  ipcMain.handle(
    "agent:setModel",
    (_e, args: { kind: LlmProviderKind; model: string }): ProviderConfig =>
      providers.setModel(args.kind, args.model),
  );
  ipcMain.handle(
    "agent:setApiKey",
    (_e, args: { kind: HostedProviderKind; apiKey: string }) => {
      providers.setApiKey(args.kind, args.apiKey);
    },
  );
  // Phase 8.k10b — cheap probe ("is this key valid") used by the
  // skip-to-external flow before we persist + flip provider. Does not
  // mutate state on its own.
  ipcMain.handle(
    "agent:validateApiKey",
    (_e, args: { kind: HostedProviderKind; apiKey: string }) =>
      providers.validateApiKey(args.kind, args.apiKey),
  );
  ipcMain.handle(
    "agent:clearApiKey",
    (_e, args: { kind: HostedProviderKind }) => {
      providers.clearApiKey(args.kind);
    },
  );

  // Memory IPC (Phase 8.d). The probe is cached on the MemoryStore — these
  // handlers are read-only views; mutations happen implicitly as the
  // orchestrator appends messages.
  ipcMain.handle("agent:getMemoryProbe", () => memoryProbe);
  ipcMain.handle("agent:listConversations", () => memory.list());

  // DEV ONLY — bypass OIDC entirely for UI testing against a mock gateway.
  // Set AVA_DEV_AUTH_BYPASS=1 alongside GATEWAY_URL to skip Keycloak.
  if (process.env.AVA_DEV_AUTH_BYPASS === "1") {
    console.warn(
      "[auth] AVA_DEV_AUTH_BYPASS=1 — faking a signed-in session. DO NOT USE IN PROD.",
    );
    auth.devBypassSignIn();
  } else {
    // Try silent restore from the OS-keychain–stored refresh token before
    // showing any UI — if it works the renderer never sees a sign-in screen.
    await auth.tryRestoreSession();
  }

  createMainWindow();

  // Boot the Ollama child process in the background. We don't `await` here
  // because spawn + 30s health-check would block the window from opening.
  // The renderer reads `ollama:getStatus` and reacts to status pushes.
  if (process.env.AVA_DISABLE_OLLAMA !== "1") {
    void ollama.start().catch((err) => {
      console.error("[ollama] supervisor.start() rejected:", err);
    });
  } else {
    console.warn(
      "[ollama] AVA_DISABLE_OLLAMA=1 — supervisor not started; renderer will see state=idle",
    );
  }

  app.on("activate", () => {
    if (BrowserWindow.getAllWindows().length === 0) createMainWindow();
  });
});

app.on("window-all-closed", () => {
  if (process.platform !== "darwin") app.quit();
});

// Best-effort graceful shutdown of the child process on quit. Electron
// gives us a small window before SIGKILL — `stop()` issues SIGTERM and
// returns immediately, the OS handles the rest.
app.on("before-quit", () => {
  agent.dispose();
  providers.dispose();
  void ollama.stop();
});

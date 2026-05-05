import {
  app,
  BrowserWindow,
  ipcMain,
  session,
  shell,
  systemPreferences,
} from "electron";
import { join } from "node:path";
import { Auth, type AuthStatus } from "./auth";
import { OllamaSupervisor } from "./ollama-supervisor";
import { PostgresSupervisor } from "./postgres-supervisor";
import { ProducerSupervisor } from "./producer-supervisor";
import { Updater, broadcastUpdateStatus } from "./updater";
import {
  AgentOrchestrator,
  AlertPrefsStore,
  AlertsStore,
  AttachmentStore,
  FreshnessCursorStore,
  FreshnessPrefsStore,
  FreshnessScheduler,
  InterestStore,
  UserProfileStore,
  WatchExecutor,
  WatchStore,
  GatewayClient,
  GeneralMemoryStore,
  Heartbeat,
  LlmProviderManager,
  MemoryStore,
  buildLlmAlertJudge,
  buildReadOnlyRegistry,
  buildRealCandidateSource,
} from "./agent";
import { NotificationManager } from "./notifications";
import { WhisperSidecar } from "./voice/whisper-sidecar";
import type { StagedSheetSummary } from "./agent";
import type { ProviderConfig, LlmProviderKind } from "./agent";
import type { HostedProviderKind } from "../shared/types";
import type {
  AgentChoiceAnswer,
  AgentSendInput,
  AgentStatus,
  AgentStreamFrame,
  Alert,
  AlertPrefs,
  OllamaPullProgress,
  OllamaStatus,
  PostgresStatus,
  ProducerStatus,
  UpdateStatus,
  UserProfile,
  Watch,
  VoiceModelDownloadProgress,
  VoiceStatus,
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

// Phase 8.u2 — single source-of-truth for public boot config. See
// `src/shared/config.ts` for the layered resolution (env → defaults).
// Resolved here at module load using `app.isPackaged` + `app.getVersion()`
// so the rest of main can treat config as static.
import { resolveConfig } from "../shared/config";
const APP_CONFIG = resolveConfig({
  appVersion: app.getVersion(),
  isPackaged: app.isPackaged,
});
const GATEWAY_URL = APP_CONFIG.gatewayUrl;
const AUTH_ISSUER = APP_CONFIG.authIssuer;
const AUTH_CLIENT_ID = APP_CONFIG.authClientId;

const auth = new Auth(AUTH_ISSUER, AUTH_CLIENT_ID);

function broadcastAuthStatus(status: AuthStatus): void {
  for (const win of BrowserWindow.getAllWindows()) {
    win.webContents.send("auth-status:changed", status);
  }
  // 8.v1.3 — auth lifecycle drives producer lifecycle.
  // Sign-in: invalidate any cached "no-amqp" error state and start
  // every producer that's idle/error. Sign-out: stop every producer
  // and drop the cached AMQP URL.
  if (status.signedIn) {
    for (const p of producers) {
      const s = p.getStatus().state;
      if (s === "idle" || s === "error") {
        void p.start().catch((err) => {
          console.error(
            `[producer:${p.getStatus().name}] start() rejected:`,
            err,
          );
        });
      }
    }
  } else {
    cachedCredentials = null;
    for (const p of producers) {
      void p.stop();
    }
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

// Postgres supervisor (Phase 8.v1.0).
//
// Boots the bundled portable Postgres on app start. Producer services
// (8.v1.2+) connect against this instance via DATABASE_URL pointing at
// 127.0.0.1:<port>/<db>. In v0.1.x there are no producers yet, but the
// substrate has to come up cleanly before we wire them in.
//
// Disabled by setting AVA_DISABLE_POSTGRES=1 — used in CI lint /
// mock-gateway dev where the local DB is not under test.
const postgres = new PostgresSupervisor();

function broadcastPostgresStatus(status: PostgresStatus): void {
  for (const win of BrowserWindow.getAllWindows()) {
    win.webContents.send("postgres-status:changed", status);
  }
}
postgres.on("status", broadcastPostgresStatus);

// Auto-updater (8.u4). Talks to GitHub Releases via the
// publish-config in electron-builder.yml. No-op in dev mode.
const updater = new Updater();
updater.on("status", (s: UpdateStatus) => broadcastUpdateStatus(s));

// Producer supervisors (Phase 8.v1.1+8.v1.3).
//
// One supervisor per local producer. AMQP URL is fetched on demand
// from the gateway's `/v1/local-amqp-url` endpoint after the user
// authenticates — we never bake the broker URL into the bundle.
// company-profile is the v1.1 proof; the remaining four producers
// join in 8.v1.4 once the pipeline is confirmed end-to-end.
//
// Local-credentials cache: we hold the most recent gateway fetch so
// a producer restart inside the cache window doesn't re-roundtrip.
// Invalidates on sign-out (cleared by the auth-status branch below)
// and on explicit refresh.
interface LocalCredentials {
  amqpUrl: string;
  databaseUrls: Record<string, string>;
  expiresAt: number;
}
let cachedCredentials: LocalCredentials | null = null;

async function fetchLocalCredentials(): Promise<LocalCredentials | null> {
  if (cachedCredentials && cachedCredentials.expiresAt > Date.now()) {
    return cachedCredentials;
  }
  const status = auth.getStatus();
  if (!status.signedIn) return null;
  try {
    const res = await gatewayClient.request<{
      amqpUrl: string;
      databaseUrls: Record<string, string>;
      expiresAt: string;
    }>("/v1/local-credentials");
    cachedCredentials = {
      amqpUrl: res.amqpUrl,
      databaseUrls: res.databaseUrls ?? {},
      // Cache 90% of the way to the server-declared expiry so we
      // refresh ahead of the actual deadline.
      expiresAt:
        Date.now() + 0.9 * (new Date(res.expiresAt).getTime() - Date.now()),
    };
    return cachedCredentials;
  } catch (err) {
    console.warn(
      "[producers] failed to fetch local-credentials:",
      err instanceof Error ? err.message : String(err),
    );
    return null;
  }
}

async function fetchAmqpUrl(): Promise<string | null> {
  const c = await fetchLocalCredentials();
  return c?.amqpUrl ?? null;
}

function makeDatabaseUrlGetter(
  producerName: string,
): () => Promise<string | null> {
  return async () => {
    const c = await fetchLocalCredentials();
    return c?.databaseUrls[producerName] ?? null;
  };
}

const producers: ProducerSupervisor[] = [];

function buildProducer(
  name: string,
  entry: string,
  databaseName: string,
  port: number,
): ProducerSupervisor {
  return new ProducerSupervisor({
    config: { name, entry, databaseName, port },
    databaseUrl: makeDatabaseUrlGetter(name),
    amqpUrl: fetchAmqpUrl,
    jwksUri: `${APP_CONFIG.authIssuer}/protocol/openid-connect/certs`,
    llmConfig: () => providers.getProducerLlmEnv(),
    // Bearer for producer→gateway calls (e.g. valueserp proxy).
    // Captured at spawn; see ProducerSupervisorOptions.getAccessToken.
    getAccessToken: () => auth.getAccessToken(),
  });
}

// Producer registry. Each entry registers a supervisor only if
// its vendored dir is present at startup — packaged builds without
// the producer bundle (CI without SUBMODULES_PAT) silently skip
// instead of sitting in `error` state from boot.
//
// Port allocation: 51010-step-10 to leave room for liveness/readiness
// probes (PORT+100/+101) without collision between producers.
{
  const PRODUCER_REGISTRY: Array<{
    name: string;
    entry: string;
    databaseName: string;
    port: number;
  }> = [
    // §8.v3 pivot-2 — local compute for everything except `website`
    // (which uses operator-paid valueserp). Each entry runs as a
    // PRODUCER_MODE=compute Node subprocess; persistence happens via
    // AMQP `tenant.persist.<svc>.v1` events that db-gateway's
    // persist-bus upserts into MPG.
    {
      name: "company-profile",
      entry: "dist/web/api/server.js",
      databaseName: "company_profile",
      port: 51010,
    },
    {
      name: "structured-content",
      entry: "dist/web/api/server.js",
      databaseName: "structured_content",
      port: 51020,
    },
    {
      name: "website",
      entry: "dist/web/api/server.js",
      databaseName: "website",
      port: 51060,
    },
    {
      // Unternehmensregister Selenium scrape + FoxIO captcha click
      // via the agentControl helper. The legacy onnx-runtime
      // captcha-solver stays bound (idle) — rip out once we're
      // sure no legacy URLs surface.
      name: "company-publication",
      entry: "dist/web/api/server.js",
      databaseName: "company_publication",
      port: 51030,
    },
    {
      // Phase 2a: 8-listener fan-in compute-worker. Each inbound
      // event becomes a partial persist event the gateway upserts.
      // Embedding compute + ES indexing pending in Phase 2b.
      name: "company-evaluation",
      entry: "dist/web/api/server.js",
      databaseName: "company_evaluation",
      port: 51040,
    },
    // Pending — re-add as each migration lands:
    //   company-contact      port 51050 / db company_contact
    // The fly counterpart stays running in legacy mode until the
    // local replacement is validated end-to-end.
  ];

  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const { existsSync } = require("node:fs") as typeof import("node:fs");
  for (const entry of PRODUCER_REGISTRY) {
    const candidatePackaged = join(
      process.resourcesPath ?? "",
      "producers",
      entry.name,
    );
    const candidateDev = join(
      app.getAppPath(),
      "resources",
      "producers",
      entry.name,
    );
    const vendored = app.isPackaged ? candidatePackaged : candidateDev;
    if (existsSync(vendored)) {
      producers.push(
        buildProducer(entry.name, entry.entry, entry.databaseName, entry.port),
      );
    } else {
      console.log(
        `[producers] ${entry.name} not vendored (looked at ${vendored}); skipping. ` +
          `Run \`pnpm fetch:producers\` to enable in dev.`,
      );
    }
  }
}

function broadcastProducerStatus(status: ProducerStatus): void {
  for (const win of BrowserWindow.getAllWindows()) {
    win.webContents.send("producer-status:changed", status);
  }
}
for (const p of producers) {
  p.on("status", broadcastProducerStatus);
}

// Agent orchestrator (Phase 8.a + 8.b).
//
// Single instance shared across windows — conversations are addressed by
// the renderer-supplied `conversationId`. Stream frames fan out to every
// window; the renderer filters by `requestId`.
//
// Phase 8.b: the gateway-backed read tools register up-front. Each tool
// reads the access token at call time via `auth.getAccessToken()` so
// re-auth/refresh is transparent to the model.
// Provider manager (Phase 8.j). Owns the Ollama + OpenAI providers and
// the persisted config under userData/agent/. Constructed before the
// gateway client so the BYO-key callback (Option D) can read the
// active provider's key on dispatch HTTP requests.
const providers = new LlmProviderManager(ollama);
const gatewayClient = new GatewayClient({
  baseUrl: GATEWAY_URL,
  getAccessToken: () => auth.getAccessToken(),
  // Option D — BYO-key passthrough. Dispatch tools opt in via
  // `attachUserLlm: true`; this callback returns the active provider's
  // (provider, key, model) for those calls. Other reads pay no key
  // cost and never broadcast the key.
  getUserLlm: () => providers.getActiveUserLlm(),
});
// General memory (Phase 8.k10h). Long-lived bag of facts the agent can
// recall via the `recall_memory` / `remember` tools. Distinct from the
// per-conversation MemoryStore below — that one mirrors transcripts.
// Probe lives in the same userData/agent dir, so if MemoryStore's probe
// failed we expect this one to fail too — surfaced via console for now;
// renderer doesn't currently render a separate error for it.
const generalMemory = new GeneralMemoryStore();
const generalMemoryProbe = generalMemory.probe();
if (!generalMemoryProbe.writable) {
  console.warn(
    `[general-memory] probe failed at ${generalMemoryProbe.path}: ${generalMemoryProbe.reason}`,
  );
}
// Attachment store (Phase 8.e — Excel-in-chat Scope C bridge). Holds raw
// xlsx/csv bytes the renderer staged on send so the `import_excel` tool
// can re-upload them to the gateway. In-memory only, TTL'd inside the
// store itself.
const attachments = new AttachmentStore();

// Heartbeat alerts (Phase 8.f1 → 8.f5).
//
// Constructed BEFORE the agent registry so the new alerts_* tools
// (8.f5 — agent self-service) can hold references to the same store
// the renderer reads. Order: alerts → prefs → notifications → real
// candidate source → composite source → heartbeat → registry.
const alerts = new AlertsStore();
const alertsProbe = alerts.probe();
if (!alertsProbe.writable) {
  console.warn(
    `[alerts] probe failed at ${alertsProbe.path}: ${alertsProbe.reason}`,
  );
}
const alertPrefs = new AlertPrefsStore();
const notifications = new NotificationManager(alertPrefs);
// 8.f4 — real candidate source backed by existing gateway endpoints
// (transactions → entities → publications). Falls back to the in-process
// demo source ONLY when the real source returns nothing AND the alerts
// file is empty, so a fresh-install user still sees something on the
// /alerts page while a populated install only sees real candidates.
const realCandidateSource = buildRealCandidateSource(gatewayClient);
const compositeCandidateSource = (() => {
  let demoFired = false;
  const demoOnce = async (): Promise<
    Awaited<ReturnType<typeof realCandidateSource>>
  > => {
    if (demoFired) return [];
    demoFired = true;
    const now = Date.now();
    const recent = (daysAgo: number) =>
      new Date(now - daysAgo * 86_400_000).toISOString();
    return [
      {
        kind: "publication" as const,
        companyId: "DEMO_KANNEGIESSER",
        companyName: "Herbert Kannegiesser GmbH",
        sourceRef: "demo:publication:kannegiesser:expansion-2026",
        occurredAt: recent(2),
        summary:
          "Pressemitteilung zur Eröffnung eines neuen Werks in Polen mit 120 zusätzlichen Stellen.",
        payload: { topic: "expansion" },
      },
      {
        kind: "financial-delta" as const,
        companyId: "DEMO_HETTICH",
        companyName: "Paul Hettich GmbH & Co. KG",
        sourceRef: "demo:financial-delta:hettich:fy2025",
        occurredAt: recent(14),
        summary:
          "Geschäftsbericht 2025: Umsatz +18 % gegenüber 2024 (€ 1,42 Mrd.), Operatives Ergebnis +24 %.",
        payload: { metric: "revenue", deltaPct: 18 },
      },
    ];
  };
  return async (since: Date | null) => {
    const real = await realCandidateSource(since);
    if (real.length > 0) return real;
    if (alerts.list().length > 0) return [];
    return demoOnce();
  };
})();
// Watch store + executor (Phase 8.t2). Built BEFORE the heartbeat so
// the executor can hook into the post-candidate slot. Storage probe
// is non-fatal — like the other JSONL stores, the rest of the app
// runs fine if the file isn't writable.
const watchStore = new WatchStore();
const watchProbe = watchStore.probe();
if (!watchProbe.writable) {
  console.warn(
    `[watches] probe failed at ${watchProbe.path}: ${watchProbe.reason}`,
  );
}
const watchExecutor = new WatchExecutor({
  watches: watchStore,
  alerts,
  providers,
});

function broadcastWatchesChanged(): void {
  const snapshot = watchStore.list();
  for (const win of BrowserWindow.getAllWindows()) {
    win.webContents.send("watches:changed", snapshot);
  }
}
watchStore.on("changed", () => broadcastWatchesChanged());

const heartbeat = new Heartbeat({
  store: alerts,
  // 8.f3 — read cadence from persisted prefs (default 15 min). The
  // store fires `changed` on every patch; we re-route that into
  // `setIntervalMs` below so the cadence radio in Settings takes
  // effect without an app restart.
  intervalMs: alertPrefs.get().cadenceMinutes * 60_000,
  source: compositeCandidateSource,
  // 8.f2 — real LLM judge. Throws `JudgeProviderUnavailable` when no
  // provider is ready, which the heartbeat catches and turns into a
  // skipped tick so dedup slots aren't burned during cold-start.
  judge: buildLlmAlertJudge(providers, {
    isProviderReady: () => providers.getStatus().ready,
  }),
  // 8.t2 — same candidate set the alert judge consumed → the watch
  // executor evaluates each due watch's rubric. Hits create alerts
  // tagged `kind: "evaluation-flag"` with a `watch:{id}:{ref}`
  // sourceRef for dedup, so the existing bell + /alerts surface
  // picks them up automatically.
  postCandidateHook: (candidates) => watchExecutor.evaluate(candidates),
});

function broadcastAlertsChanged(): void {
  for (const win of BrowserWindow.getAllWindows()) {
    win.webContents.send("alerts:changed");
  }
}

// Freshness scheduler (Phase 8.r1 — dry-run).
//
// Walks pipeline matrices every 30 min, scores each (companyId, stage)
// cell against its configured cadence, and logs the top-K most-overdue
// rows. Does NOT dispatch retries yet; that's 8.r2.
//
// The scheduler is independent of the heartbeat — different concern
// (keeping data fresh vs. judging significance), different cadence,
// different tools surface. Constructed before the registry so 8.r3
// can register `freshness_*` chat tools the same way `alerts_*` got
// wired.
const freshnessPrefs = new FreshnessPrefsStore();
const freshnessCursor = new FreshnessCursorStore();
// 8.r4 — recent-interest signal store. The renderer pings this on
// CompanyDetail mounts and chat company-link clicks; the scheduler
// reads it during scoring so freshly-attended companies float to the
// top of the queue without an explicit pin.
const interest = new InterestStore();

// User profile (Phase 8.t1). Persistent lens read by the system-prompt
// builder on every turn so every response is biased by the user's role
// / industries / topics. The propose-and-confirm gate lives in the
// `profile_propose_update` tool — main only sees writes after the user
// confirmed via ask_user_choice.
const userProfile = new UserProfileStore();
function broadcastProfileChanged(): void {
  const next = userProfile.get();
  for (const win of BrowserWindow.getAllWindows()) {
    win.webContents.send("profile:changed", next);
  }
}
userProfile.on("changed", () => broadcastProfileChanged());
const freshness = new FreshnessScheduler({
  gateway: gatewayClient,
  prefs: freshnessPrefs,
  cursor: freshnessCursor,
  interest,
});
function broadcastFreshnessPrefsChanged(): void {
  const next = freshnessPrefs.get();
  for (const win of BrowserWindow.getAllWindows()) {
    win.webContents.send("freshness:prefs-changed", next);
  }
}
freshnessPrefs.on("changed", (next) => {
  // Toggle off → cancel any timer; toggle on → restart at the default
  // cadence. We don't expose the interval as a user pref in 8.r1 (the
  // 30-min default is good enough); the toggle is the only knob that
  // needs runtime application.
  if (!next.enabled) {
    freshness.stop();
  } else {
    freshness.start();
  }
  broadcastFreshnessPrefsChanged();
});

// Whisper sidecar (Phase 8.n1).
//
// Boot-time probes (binary present? GGUF on disk?) drive a lifecycle
// the renderer mirrors via `voice:status:changed` — same channel
// pattern as ollama / agent / alerts. Transcription itself stays
// stubbed in 8.n1; renderer can already exercise the IPC roundtrip.
const whisper = new WhisperSidecar();
function broadcastVoiceStatus(status: VoiceStatus): void {
  for (const win of BrowserWindow.getAllWindows()) {
    win.webContents.send("voice:status:changed", status);
  }
}
function broadcastVoiceProgress(p: VoiceModelDownloadProgress): void {
  for (const win of BrowserWindow.getAllWindows()) {
    win.webContents.send("voice:download:progress", p);
  }
}
whisper.on("status", broadcastVoiceStatus);
whisper.on("progress", broadcastVoiceProgress);
// 8.n1 follow-up — auto-install streams stdout/stderr lines so the
// renderer can show "Brewing whisper-cpp …" in the Settings panel
// while the install is in flight.
whisper.on("installLog", (line: string) => {
  for (const win of BrowserWindow.getAllWindows()) {
    win.webContents.send("voice:install:log", line);
  }
});

const agentRegistry = buildReadOnlyRegistry({
  gateway: gatewayClient,
  providers,
  generalMemory,
  attachments,
  alerts,
  alertPrefs,
  heartbeat,
  freshness,
  freshnessPrefs,
  // 8.f5 — alerts_* tools call this after every mutation so the bell +
  // /alerts route refresh live without polling. Same callback the IPC
  // mutation handlers below use.
  onAlertsChanged: broadcastAlertsChanged,
  // 8.r3 — freshness_* tools fire this after every pref mutation so
  // every open window's Settings panel re-fetches.
  onFreshnessPrefsChanged: broadcastFreshnessPrefsChanged,
  profile: userProfile,
  // 8.t1 — profile_* tools fire this after every successful write so
  // the Settings panel + every other window's mirror re-syncs.
  onProfileChanged: broadcastProfileChanged,
  watches: watchStore,
  // 8.t2 — watch_* tools fire this after every successful mutation so
  // the topbar chip + Settings panel re-sync.
  onWatchesChanged: broadcastWatchesChanged,
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
  // Phase 8.k10f — when the orchestrator detects a local runner
  // crash mid-turn, we restart the supervisor so the user can hit
  // Send again without quitting the app. See `isRuntimeCrash` in
  // orchestrator.ts for the substring matchers.
  runtimeRecover: () => ollama.restart(),
  // 8.t1 — system-prompt builder reads profile on every turn so every
  // response is biased by the user's lens.
  profileStore: userProfile,
});

alertPrefs.on("changed", (next: AlertPrefs) => {
  // Apply the new cadence immediately. push / quiet-hours / threshold
  // changes don't need a reschedule — `NotificationManager` re-reads
  // prefs on every send.
  heartbeat.setIntervalMs(next.cadenceMinutes * 60_000);
  for (const win of BrowserWindow.getAllWindows()) {
    win.webContents.send("alert-prefs:changed", next);
  }
});

heartbeat.on("alerts", (created: Alert[]) => {
  console.log(`[heartbeat] persisted ${created.length} new alert(s)`);
  broadcastAlertsChanged();
  // Native push (8.f3) — every gating decision (push enabled, severity
  // threshold, quiet hours, OS support) lives inside the manager.
  for (const a of created) {
    notifications.notifyForAlert(a);
  }
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

  // (v0.1.7-v0.1.20 carried an `app.isPackaged → openDevTools` line
  // that auto-opened the inspector in packaged builds while we
  // diagnosed the OpenAI ECONNRESET. Removed once the cause was
  // pinned down. DevTools stays available via Cmd+Option+I; users
  // who want it can still pop it manually.)
  return win;
}

app.whenReady().then(async () => {
  // ---- Renderer permission grants (Phase 8.n2) -----------------------------
  //
  // Electron's default `setPermissionRequestHandler` denies every
  // permission request silently. That's why `getUserMedia({ audio })`
  // failed with NotAllowedError before — Chromium's permission prompt
  // never even surfaced because Electron killed the request first.
  //
  // We grant the small set of permissions the app actually needs:
  //   - `media` / `mediaKeySystem`: microphone for voice mode (8.n2)
  //   - `clipboard-sanitized-write`: future "Copy answer" affordance
  //   - everything else: deny
  //
  // The OS-level prompt (macOS Privacy & Security → Microphone) still
  // gates the actual mic, but at least Electron stops being the wall
  // before the OS gets a say.
  const ALLOWED_PERMS = new Set([
    "media",
    "mediaKeySystem",
    "clipboard-sanitized-write",
  ]);
  session.defaultSession.setPermissionRequestHandler(
    (_wc, permission, callback) => {
      callback(ALLOWED_PERMS.has(permission));
    },
  );
  // The check handler is consulted synchronously by the renderer's
  // Permissions API and by Chromium's media stack before kicking off
  // a getUserMedia. Returning `true` here mirrors the request grant.
  session.defaultSession.setPermissionCheckHandler((_wc, permission) =>
    ALLOWED_PERMS.has(permission),
  );

  // ---- IPC contract ---------------------------------------------------------
  //
  // `app:getConfig` returns *static* boot config — gateway URL only. The
  // access token is no longer included here; renderer fetches it on demand
  // via `auth:getAccessToken` so it always gets a fresh-enough one.
  ipcMain.handle("app:getConfig", () => ({
    gatewayUrl: APP_CONFIG.gatewayUrl,
    authIssuer: APP_CONFIG.authIssuer,
    authClientId: APP_CONFIG.authClientId,
    updateChannel: APP_CONFIG.updateChannel,
    appVersion: APP_CONFIG.appVersion,
    isDev: APP_CONFIG.isDev,
  }));

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
  // Phase 8.k10e — let the user reclaim disk space from Whoami. The
  // supervisor refreshes its installed-models list before resolving so
  // the renderer's next ollama-status push reflects the deletion.
  ipcMain.handle("ollama:deleteModel", (_e, modelName: string) =>
    ollama.deleteModel(modelName),
  );

  // Postgres supervisor IPC (8.v1.0). Renderer reads getStatus on
  // mount and subscribes to `postgres-status:changed`. No restart /
  // reset endpoints yet — those come with the Settings panel UX.
  ipcMain.handle("postgres:getStatus", () => postgres.getStatus());

  // Auto-updater IPC (8.u4).
  ipcMain.handle("updater:getStatus", () => updater.getStatus());
  ipcMain.handle("updater:check", () => updater.check());
  ipcMain.handle("updater:download", () => updater.download());
  ipcMain.handle("updater:install", () => updater.installAndRelaunch());

  // Producer supervisors (8.v1.1). Renderer reads the snapshot list
  // on mount and subscribes to `producer-status:changed` for diffs.
  ipcMain.handle("producers:list", () =>
    producers.map((p) => p.getStatus()),
  );
  ipcMain.handle("ollama:restart", () => ollama.restart());

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
  // Option D — BYO-key passthrough. The renderer's `gatewayUpload`
  // (Excel ingest) attaches these headers on dispatch. Returns null
  // when no provider is configured / Ollama is active / key missing,
  // and the producer falls back to its env-baked LLM. Keeps the
  // plaintext key off-disk (decrypted on demand each call).
  ipcMain.handle(
    "agent:getActiveUserLlm",
    () => providers.getActiveUserLlm(),
  );
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
  // Phase 8.k10h — load a specific conversation's transcript so the
  // renderer can replay it on session-switch. Returns [] for unknown
  // ids / parse failures (consistent with MemoryStore.load semantics).
  ipcMain.handle("agent:loadConversation", (_e, conversationId: string) =>
    memory.load(conversationId),
  );
  ipcMain.handle("agent:deleteConversation", (_e, conversationId: string) =>
    memory.delete(conversationId),
  );

  // General memory IPC (Phase 8.k10h). The agent reads/writes via the
  // `recall_memory` / `remember` tools; these handlers exist so a future
  // Settings → Memory panel can surface entries to the user for review
  // and manual deletion.
  ipcMain.handle("agent:listGeneralMemory", () => generalMemory.list());
  ipcMain.handle(
    "agent:addGeneralMemory",
    (_e, args: { content: string; tags?: string[] }) =>
      generalMemory.add(args),
  );
  ipcMain.handle("agent:removeGeneralMemory", (_e, id: string) =>
    generalMemory.remove(id),
  );

  // Heartbeat alerts IPC (Phase 8.f1). The renderer reads via
  // `alerts:list` / `alerts:unreadCount` and mutates with
  // `alerts:markSeen` / `alerts:dismiss`. `alerts:triggerNow` exists
  // primarily as a dev affordance ("Jetzt auslösen" button in
  // Settings — wired in 8.f3) but is safe to call at any time. Mutation
  // handlers re-broadcast `alerts:changed` so every open window's store
  // refreshes without the renderer having to invalidate cache.
  ipcMain.handle("alerts:list", () => alerts.list());
  ipcMain.handle("alerts:unreadCount", () => alerts.unreadCount());
  ipcMain.handle("alerts:markSeen", (_e, id: string) => {
    const ok = alerts.markSeen(id);
    if (ok) broadcastAlertsChanged();
    return ok;
  });
  ipcMain.handle("alerts:dismiss", (_e, id: string) => {
    const ok = alerts.dismiss(id);
    if (ok) broadcastAlertsChanged();
    return ok;
  });
  ipcMain.handle("alerts:triggerNow", async () => {
    const info = await heartbeat.triggerNow();
    return info;
  });
  // Phase 8.f3 (transparency add-on) — surfaces the last N ticks with
  // per-candidate decisions so the Settings panel can show the user
  // what was weighed and why nothing was promoted on a given run.
  ipcMain.handle("alerts:recentTicks", () => heartbeat.getRecentTicks());

  // Freshness scheduler IPC (Phase 8.r1). Read-only + manual trigger;
  // the chat tools surface (8.r3) layers on top. `triggerNow` returns
  // the same FreshnessTickInfo shape `freshness:recentTicks` lists.
  ipcMain.handle("freshness:recentTicks", () => freshness.getRecentTicks());
  ipcMain.handle("freshness:triggerNow", () => freshness.triggerNow());
  ipcMain.handle("freshness:getPrefs", () => freshnessPrefs.get());
  ipcMain.handle(
    "freshness:setPrefs",
    (_e, patch: Parameters<typeof freshnessPrefs.set>[0]) =>
      freshnessPrefs.set(patch),
  );
  // 8.r4 — interest-signal recorder. Fired by the renderer whenever
  // the user opens CompanyDetail or clicks a `[…](company:id)` link
  // in chat. No-op return; the scheduler picks the signal up on the
  // next tick.
  ipcMain.handle("interest:record", (_e, companyId: string) => {
    if (typeof companyId === "string" && companyId.length > 0) {
      interest.record(companyId);
    }
  });

  // User profile IPC (Phase 8.t1). Read-only views + direct writes
  // for Settings panel edits. Agent-inferred updates go through
  // `profile_propose_update` which gates on ask_user_choice; the
  // explicit-write IPC bypasses that gate intentionally because the
  // Settings panel IS the explicit user surface.
  ipcMain.handle("profile:get", () => userProfile.get());
  ipcMain.handle("profile:set", (_e, patch: Partial<UserProfile>) =>
    userProfile.set(patch),
  );
  ipcMain.handle("profile:clear", () => userProfile.clear());

  // Watches IPC (Phase 8.t2). Read-only views + remove / pause /
  // resume mutations for the Settings panel + topbar chip popover.
  // Watch *creation* stays chat-only (the propose-and-confirm gate
  // lives in the `watch_register` tool, which renders an
  // ask_user_choice card before persistence).
  ipcMain.handle("watches:list", (): Watch[] => watchStore.list());
  ipcMain.handle(
    "watches:remove",
    (_e, id: string): boolean => watchStore.remove(id),
  );
  ipcMain.handle(
    "watches:setEnabled",
    (_e, args: { id: string; enabled: boolean }): boolean =>
      watchStore.setEnabled(args.id, args.enabled),
  );

  // Voice / whisper sidecar IPC (Phase 8.n1). The download path is
  // long-running but resolves only when the GGUF lands on disk; the
  // renderer drives a progress bar off the `voice:download:progress`
  // push that's already wired above.
  ipcMain.handle("voice:getStatus", () => whisper.getStatus());
  ipcMain.handle("voice:downloadModel", () => whisper.downloadModel());
  ipcMain.handle("voice:cancelDownload", () => whisper.cancelDownload());
  ipcMain.handle("voice:deleteModel", () => whisper.deleteModel());
  // 8.n1 stub — renderer can already roundtrip but the body is a
  // placeholder string; 8.n2 swaps in the real whisper.cpp invocation.
  ipcMain.handle("voice:installBinary", async () => {
    await whisper.installBinary();
  });
  ipcMain.handle("voice:transcribe", async (_e, audio: Uint8Array) => {
    const u8 =
      audio instanceof Uint8Array
        ? audio
        : new Uint8Array(audio as ArrayBufferLike);
    return whisper.transcribe(u8);
  });
  // Microphone permission flow (Phase 8.n2 follow-up).
  // - macOS gates the mic at the OS level via TCC. The renderer
  //   queries the status BEFORE getUserMedia so it can show the
  //   right next step (request prompt vs. open System Settings).
  // - Windows / Linux don't expose an electron-queryable equivalent;
  //   we report `unsupported` and rely on getUserMedia errors at use
  //   time to drive the UI.
  ipcMain.handle("voice:micPermission", () => {
    // Dev mode runs the prebuilt `node_modules/electron/dist/Electron.app`
    // binary; macOS attaches mic permissions to the bundle's
    // CFBundleName, which for that binary is "Electron". In a packaged
    // build the bundle is "AVA". Surface this to the renderer
    // so the error message can tell the user where to LOOK in System
    // Settings.
    const isPackaged = app.isPackaged;
    const appNameInSettings = isPackaged ? app.getName() : "Electron";
    if (process.platform === "darwin") {
      return {
        status: systemPreferences.getMediaAccessStatus("microphone"),
        appNameInSettings,
        isDev: !isPackaged,
      };
    }
    return {
      status: "unsupported" as const,
      appNameInSettings,
      isDev: !isPackaged,
    };
  });
  ipcMain.handle("voice:requestMicPermission", async () => {
    if (process.platform === "darwin") {
      // Pops the system prompt the FIRST time it's called per-app;
      // subsequent calls return the user's prior decision. Returns
      // false when the user previously denied — that's the cue to
      // show the "open System Settings" affordance instead.
      return await systemPreferences.askForMediaAccess("microphone");
    }
    return true;
  });
  ipcMain.handle("voice:openMicSettings", async () => {
    // Deep-links into the OS privacy panel where the user can flip
    // the per-app toggle. macOS uses the x-apple.systempreferences
    // URL scheme; Windows uses the ms-settings: scheme.
    if (process.platform === "darwin") {
      await shell.openExternal(
        "x-apple.systempreferences:com.apple.preference.security?Privacy_Microphone",
      );
    } else if (process.platform === "win32") {
      await shell.openExternal("ms-settings:privacy-microphone");
    } else {
      // Linux distros vary; punt to the generic privacy page where
      // it's available via the desktop session manager.
      await shell.openExternal("https://help.ubuntu.com/stable/ubuntu-help/privacy.html");
    }
  });

  // Alert preferences (Phase 8.f3). The renderer's Settings page
  // reads via `alert-prefs:get` and patches via `alert-prefs:set`;
  // main rebroadcasts `alert-prefs:changed` so every open window's
  // store re-syncs without polling. Permission status is read-only
  // — the OS owns that gate.
  ipcMain.handle("alert-prefs:get", () => alertPrefs.get());
  ipcMain.handle("alert-prefs:set", (_e, patch: Partial<AlertPrefs>) =>
    alertPrefs.set(patch),
  );
  ipcMain.handle("notifications:getPermissionStatus", () =>
    notifications.permissionStatus(),
  );

  // Attachment staging (Phase 8.e). The renderer parses the spreadsheet
  // for the chip preview, then ships the raw bytes here on send so the
  // `import_excel` tool can re-upload them to the gateway. We hold them
  // in-process (TTL'd) keyed by a UUID that's woven into the user
  // prompt — bytes never enter the LLM context.
  ipcMain.handle(
    "agent:stageAttachment",
    (
      _e,
      input: {
        filename: string;
        bytes: Uint8Array;
        sheets: StagedSheetSummary[];
      },
    ) => {
      // Electron's structured-clone IPC may deliver the bytes as a Node
      // Buffer or a Uint8Array view backed by a different ArrayBuffer.
      // Normalise once so the store always holds a plain Uint8Array.
      const u8 =
        input.bytes instanceof Uint8Array
          ? new Uint8Array(input.bytes)
          : new Uint8Array(input.bytes as ArrayBufferLike);
      const entry = attachments.stage({
        filename: input.filename,
        bytes: u8,
        sheets: input.sheets,
      });
      return {
        id: entry.id,
        filename: entry.filename,
        sizeBytes: entry.sizeBytes,
      };
    },
  );
  ipcMain.handle("agent:discardAttachment", (_e, id: string) =>
    attachments.discard(id),
  );

  // DEV ONLY — bypass OIDC entirely for UI testing against a mock gateway.
  // Set AVA_DEV_AUTH_BYPASS=1 alongside GATEWAY_URL to skip Keycloak.
  // The resolver in shared/config.ts force-disables this in packaged
  // builds, so a curious user can't enable it on a shipped binary.
  if (APP_CONFIG.devAuthBypass) {
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

  // Postgres supervisor (8.v1.0). Same pattern as Ollama — fire and
  // forget; renderer reacts to status pushes. First-launch `initdb`
  // takes ~5s on a Mac, so we deliberately don't `await` either.
  if (process.env.AVA_DISABLE_POSTGRES !== "1") {
    void postgres
      .start()
      .then(() => {
        // Producer supervisors fire AFTER PGlite is ready so
        // `prisma migrate deploy` has a target to talk to. They
        // run in parallel with each other; failures are isolated
        // per producer.
        if (process.env.AVA_DISABLE_PRODUCERS !== "1") {
          for (const p of producers) {
            void p.start().catch((err) => {
              console.error(
                `[producer:${p.getStatus().name}] start() rejected:`,
                err,
              );
            });
          }
        }
      })
      .catch((err) => {
        console.error("[postgres] supervisor.start() rejected:", err);
      });
  } else {
    console.warn(
      "[postgres] AVA_DISABLE_POSTGRES=1 — supervisor not started; renderer will see state=idle",
    );
  }

  // Heartbeat begins ticking once the app + IPC are wired. Stopping
  // happens on `before-quit` below.
  heartbeat.start();
  // Freshness scheduler (8.r1). Starts only when the user pref is on
  // (default true). The `changed` listener above hooks pref-toggle
  // transitions so changing the toggle takes effect without restart.
  if (freshnessPrefs.get().enabled) freshness.start();
  // Whisper sidecar (8.n1). Probes binary + model presence and emits
  // a status frame. Failure modes (missing binary, missing model) are
  // not fatal — the rest of the app still runs; the Settings panel
  // surfaces the affordances to recover.
  void whisper.start();

  // Auto-updater. No-op in dev. In packaged builds: checks GitHub
  // Releases on launch + every 4h while the app is open.
  updater.start();

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
  whisper.cancelDownload();
  freshness.stop();
  heartbeat.stop();
  agent.dispose();
  providers.dispose();
  updater.stop();
  void ollama.stop();
  // Producers go down before Postgres so their final commits
  // succeed against the still-running PGlite instance.
  for (const p of producers) {
    void p.stop();
  }
  void postgres.stop();
});

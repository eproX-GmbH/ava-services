import {
  app,
  BrowserWindow,
  dialog,
  ipcMain,
  protocol,
  session,
  shell,
  systemPreferences,
} from "electron";
import { join } from "node:path";
import { Auth, type AuthStatus } from "./auth";
import { OllamaSupervisor } from "./ollama-supervisor";
import { PostgresSupervisor } from "./postgres-supervisor";
import { ProducerSupervisor } from "./producer-supervisor";
import { resumeStuckStages } from "./producer-resume";
import {
  producerLogBuffer,
  type ProducerLogEvent,
} from "./producer-log-buffer";
import {
  listScreenshots,
  pruneOldScreenshots,
  registerScreenshotProtocol,
} from "./producer-screenshots";
import { registerLinkedInMediaProtocol } from "./linkedin/media-protocol";
import {
  getDb as getLinkedInDb,
  heartbeatCandidates as listLinkedInHeartbeatCandidates,
  recordHeartbeatVerdict as recordLinkedInHeartbeatVerdict,
} from "./linkedin/db";
import { read as readLinkedInSettings } from "./linkedin/store";
import {
  ExternalServiceMonitor,
  UNTERNEHMENSREGISTER_DEPENDENT_PRODUCERS,
  UPSTREAM_FAILURE_PATTERNS,
  type ExternalServicesStatus,
} from "./external-service-monitor";
import { pickStructuredContentSource } from "./structured-content-source";
import { CrmManager } from "./crm";
import {
  runCrmEnrichment,
  searchHubspotCompanies,
} from "./crm/fetch-enrichment";
import { initBilling } from "./billing";
import { initLinkedIn } from "./linkedin";
import { ResearchFeaturesStore } from "./research/store";
import { ProviderConfigStore } from "./agent/providers/store";
import {
  initSkills,
  buildGateEvaluator,
  SkillsPrefsStore,
  SkillsTrustStore,
  saveSkillToDisk,
  exportSkillToZipFile,
  exportAllSkillsToZipFile,
  stageImportZip,
  stageImportMarkdown,
  commitImport,
  discardImportStaging,
} from "./skills";
import type {
  SkillRow,
  SkillBody,
  SkillSavePayload,
  SkillSaveResult,
  SkillDeleteResult,
  SkillExportResult,
  SkillExportAllResult,
  SkillImportResult,
  SkillImportCommit,
  SkillImportCommitResult,
} from "../shared/types";
import type { CrmProvider, CrmStatus } from "./crm/types";
import { scrubQuarantine, scrubWhisperBundle } from "./scrub-quarantine";
import { Updater, broadcastUpdateStatus } from "./updater";
// v0.1.200 — Audit-Trail. Local-first PGlite store, see audit-store.ts.
import { AuditStore } from "./audit/audit-store";
import type { AuditEventInput } from "./audit/audit-types";
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
  RetryTicker,
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
  AlertTickInfo,
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

// Register custom `ava-screenshot://` protocol as a privileged scheme.
// Must be called before app.whenReady() (electron requirement). The
// actual file-serving handler is wired in registerScreenshotProtocol()
// inside the whenReady callback. Marking it as `standard` lets the
// renderer use it in <img src=...> like a normal http:// URL.
protocol.registerSchemesAsPrivileged([
  {
    scheme: "ava-screenshot",
    privileges: {
      standard: true,
      secure: true,
      supportFetchAPI: true,
      bypassCSP: false,
    },
  },
  // L6 — same shape, serves LinkedIn-Beobachter media thumbnails.
  {
    scheme: "ava-linkedin-media",
    privileges: {
      standard: true,
      secure: true,
      supportFetchAPI: true,
      bypassCSP: false,
    },
  },
]);

const auth = new Auth(AUTH_ISSUER, AUTH_CLIENT_ID);

// v0.1.52 — external-service reachability monitor. Probes
// unternehmensregister.de every 60s. Used to (a) broadcast a banner
// state to the renderer ("upstream service down — Stamm + Publikation
// pausiert"), and (b) gate ProducerSupervisor.start() for the two
// producers that depend on that site so we don't burn Selenium
// cycles on a downed upstream.
const externalServiceMonitor = new ExternalServiceMonitor();

// v0.1.54 — CRM connection manager. Holds per-provider OAuth tokens
// in memory + on disk (safeStorage); renderer + agent tool drive
// connect/disconnect via IPC.
const crmManager = new CrmManager({
  getBearer: () => auth.getAccessToken(),
  gatewayUrl: GATEWAY_URL,
});

// One-shot guard for the producer-resume sweep. Fires from whichever of
// the two boot paths reaches "auth signed-in + producers spawning" first;
// the loser of the race short-circuits.
let resumeSweepDispatched = false;
function maybeRunResumeSweep(): void {
  if (resumeSweepDispatched) return;
  if (!auth.getStatus().signedIn) return;
  resumeSweepDispatched = true;
  void resumeStuckStages({ gateway: gatewayClient }).catch((err) => {
    console.warn(
      "[producer-resume] sweep rejected:",
      err instanceof Error ? err.message : err,
    );
  });
}

function broadcastAuthStatus(status: AuthStatus): void {
  for (const win of BrowserWindow.getAllWindows()) {
    win.webContents.send("auth-status:changed", status);
  }
  // 8.v1.3 — auth lifecycle drives producer lifecycle.
  // Sign-in: invalidate any cached "no-amqp" error state and start
  // every producer that's idle/error. Sign-out: stop every producer
  // and drop the cached AMQP URL.
  //
  // v0.1.52 — supersede with the external-service gate: producers
  // whose work depends on unternehmensregister.de stay paused while
  // that site is unreachable, so we don't burn Selenium cycles
  // hammering a downed upstream. The monitor's own status listener
  // (set up below) handles the inverse transition (resume on
  // reachable). This branch only refuses to start them now.
  if (status.signedIn) {
    for (const p of producers) {
      const s = p.getStatus().state;
      if (s !== "idle" && s !== "error") continue;
      const pname = p.getStatus().name;
      // v0.1.105 Session B — structured-content now has a fallback
      // (handelsregister.de), so it only stays paused when BOTH
      // upstreams are unreachable. company-publication still has
      // only the unternehmensregister path, so it gates on UR alone.
      const snap = externalServiceMonitor.getStatus();
      const urDown = snap.services.unternehmensregister.state === "unreachable";
      const hrDown = snap.services.handelsregister.state === "unreachable";
      if (pname === "structured-content" && urDown && hrDown) {
        continue;
      }
      if (
        pname === "company-publication" &&
        urDown
      ) {
        continue;
      }
      void p.start().catch((err) => {
        console.error(
          `[producer:${p.getStatus().name}] start() rejected:`,
          err,
        );
      });
    }
    // Resume stuck stages once per process (see producer-resume.ts).
    // Fires either from the postgres.start() chain (silent-restore
    // case where auth was signed-in before producers spawned) or
    // from this branch (fresh sign-in via the auth UI). The guard
    // ensures only one of those paths actually dispatches.
    maybeRunResumeSweep();
  } else {
    cachedCredentials = null;
    // Allow a future sign-in within the same process to re-run the
    // sweep — stages might have gotten stuck while signed out.
    resumeSweepDispatched = false;
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
/** v0.1.99 — registered producers whose vendored bundle is missing.
 *  Broadcast as state="not_installed" so Settings can show them. */
const missingProducers: Array<{
  name: string;
  databaseName: string;
  port: number;
}> = [];

function buildProducer(
  name: string,
  entry: string,
  databaseName: string,
  port: number,
): ProducerSupervisor {
  // v0.1.105 — structured-content can scrape from either
  // unternehmensregister.de or handelsregister.de. The picker reads
  // the live reachability snapshot and returns a source id at each
  // spawn so a flap doesn't pin a stale choice into the env. Session A
  // always returns "unternehmensregister"; Session B will flip the
  // body of pickStructuredContentSource() to prefer the fallback.
  const extraEnvAsync =
    name === "structured-content"
      ? async (): Promise<Record<string, string>> => {
          const snap = externalServiceMonitor.getStatus();
          const source = pickStructuredContentSource({
            unternehmensregister:
              snap.services.unternehmensregister.state === "reachable",
            handelsregister:
              snap.services.handelsregister.state === "reachable",
          });
          return { AVA_STRUCTURED_CONTENT_SOURCE: source };
        }
      : name === "website"
        ? // v0.1.172 Phase D — Research Features per-feature env vars.
          // Read tier/provider/key for both research pipelines from the
          // ResearchFeaturesStore and project them into the producer's env.
          // The website-side factory in infrastructure/research/index.ts
          // reads exactly these 6 vars (3 per feature). Unset feature
          // (tier=off) falls back to the legacy OPENAI_API_KEY path the
          // factory implements, so existing installs without Settings
          // migration keep working.
          async (): Promise<Record<string, string>> => {
            const store = ResearchFeaturesStore.shared();
            const env: Record<string, string> = {};
            const expansion = await store.resolveFeature("expansionTenders");
            if (expansion) {
              env.RESEARCH_EXPANSION_TIER = expansion.tier;
              env.RESEARCH_EXPANSION_PROVIDER = expansion.provider;
              env.RESEARCH_EXPANSION_API_KEY = expansion.apiKey;
            } else {
              env.RESEARCH_EXPANSION_TIER = "off";
            }
            const jobs = await store.resolveFeature("jobPostings");
            if (jobs) {
              env.RESEARCH_JOBS_TIER = jobs.tier;
              env.RESEARCH_JOBS_PROVIDER = jobs.provider;
              env.RESEARCH_JOBS_API_KEY = jobs.apiKey;
            } else {
              env.RESEARCH_JOBS_TIER = "off";
            }
            return env;
          }
        : name === "company-evaluation"
          ? // v0.1.184 — embeddinggemma is THE mandatory embedder for
            // company-evaluation (single embedding model across all
            // users so vector search in the central MPG works
            // consistently). Hardcoded here regardless of which LLM
            // provider the user picked for completions. The producer's
            // ai-provider then resolves to Ollama+embeddinggemma at
            // boot. embeddinggemma is in REQUIRED_MODELS so the Ollama
            // supervisor auto-pulls it; Settings UI also locks the
            // model from manual deletion.
            //
            // Output is 768d; the producer pads to 3072d before
            // pgvector insert (see padTo3072 in
            // company-evaluation/src/infrastructure/openai/universal-profiles.ts)
            // so the existing pgvector(3072) columns stay write-
            // compatible without a schema migration.
            async (): Promise<Record<string, string>> => ({
              EMBED_PROVIDER: "ollama",
              EMBED_MODEL: "embeddinggemma:latest",
            })
          : undefined;
  return new ProducerSupervisor({
    config: { name, entry, databaseName, port },
    databaseUrl: makeDatabaseUrlGetter(name),
    amqpUrl: fetchAmqpUrl,
    jwksUri: `${APP_CONFIG.authIssuer}/protocol/openid-connect/certs`,
    llmConfig: () => providers.getProducerLlmEnv(),
    // v0.1.144 — surface a precise reason (e.g. "Subscription-OAuth
    // wird vom lokalen Producer noch nicht unterstützt — wechsle …")
    // instead of the generic "nicht angemeldet"-Hinweis when llmConfig
    // returns null.
    llmConfigBlockerReason: () => providers.getProducerLlmBlockerReason(),
    // Bearer for producer→gateway calls (e.g. valueserp proxy).
    // Captured at spawn; see ProducerSupervisorOptions.getAccessToken.
    getAccessToken: () => auth.getAccessToken(),
    // v0.1.53 — userId for per-user AMQP queue isolation. The
    // supervisor injects this as AVA_USER_ID env on spawn; the
    // producer uses it to scope queue + binding key + downstream
    // publish routing.
    getUserId: async () => auth.getStatus().actorId ?? null,
    extraEnvAsync,
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
    {
      // Phase 3: thin compute-worker. BFS website crawl + LLM
      // extracts + valueserp fallback all run here; DB writes
      // (~700 lines of reconciliation graph) live server-side in
      // db-gateway via the vendored prisma client + the moved
      // lib/contact-extraction/ files.
      name: "company-contact",
      entry: "dist/web/api/server.js",
      databaseName: "company_contact",
      port: 51050,
    },
    // All six legacy producers now have a localized counterpart.
    // Phase 4 cleanup destroys the suspended fly app definitions.
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
      // v0.1.99 — surface the missing bundle in the Settings panel
      // instead of silently going invisible. Previously a CI bundling
      // failure produced an installed app where the affected producer
      // had no entry at all in <ProducersSection>; users had no way to
      // tell whether the producer was simply not running vs not even
      // shipped. We push a sentinel "not_installed" status so the UI
      // can render an actionable line.
      missingProducers.push({
        name: entry.name,
        databaseName: entry.databaseName,
        port: entry.port,
      });
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

/** v0.1.99 — emit a "not_installed" stub for every producer that was
 *  registered but couldn't find its vendored bundle. Re-emit on every
 *  new BrowserWindow creation (the renderer may not exist yet at app
 *  start). The store on the renderer side is a Map keyed by name, so
 *  re-emitting is idempotent. */
function broadcastMissingProducers(): void {
  for (const m of missingProducers) {
    broadcastProducerStatus({
      name: m.name,
      state: "not_installed",
      port: null,
      databaseName: m.databaseName,
      pid: null,
      errorMessage: null,
      lastExitCode: null,
      featureWarnings: [],
    });
  }
}
app.on("browser-window-created", () => broadcastMissingProducers());

// v0.1.52 — pipe external-service status to (a) the renderer banner
// and (b) producer auto-pause/resume. Only fires on transitions
// (reachable ⇄ unreachable), not on every probe, so a stable
// "down for an hour" doesn't churn the UI.
function broadcastExternalServiceStatus(
  status: ExternalServicesStatus,
): void {
  for (const win of BrowserWindow.getAllWindows()) {
    win.webContents.send("external-service-status:changed", status);
  }
}
externalServiceMonitor.on("status", (status: ExternalServicesStatus) => {
  broadcastExternalServiceStatus(status);
  // Auto-pause / auto-resume.
  //
  // v0.1.105 Session B — structured-content has a handelsregister.de
  // fallback now, so it only pauses when BOTH upstreams are
  // unreachable (anyReachable === false). company-publication still
  // talks only to unternehmensregister.de and continues to gate
  // on the UR per-service state.
  //
  // Resume is symmetric: structured-content resumes as soon as
  // either upstream is reachable; company-publication resumes as
  // soon as UR is reachable.
  const ur = status.services.unternehmensregister.state;
  const hr = status.services.handelsregister.state;
  const bothDown = ur === "unreachable" && hr === "unreachable";
  for (const p of producers) {
    const name = p.getStatus().name;
    if (!UNTERNEHMENSREGISTER_DEPENDENT_PRODUCERS.has(name)) continue;

    const pauseCondition =
      name === "structured-content" ? bothDown : ur === "unreachable";
    const resumeCondition =
      name === "structured-content"
        ? ur === "reachable" || hr === "reachable"
        : ur === "reachable";

    if (pauseCondition) {
      const s = p.getStatus().state;
      if (s !== "idle" && s !== "stopping") {
        console.log(
          `[external-service] upstreams down — pausing ${name}`,
        );
        void p.stop();
      }
    } else if (resumeCondition) {
      const s = p.getStatus().state;
      if ((s === "idle" || s === "error") && auth.getStatus().signedIn) {
        console.log(
          `[external-service] upstream back — resuming ${name}`,
        );
        void p.start().catch((err) => {
          console.error(
            `[producer:${name}] start() rejected after upstream recovery:`,
            err,
          );
        });
      }
    }
  }
});

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
    // L6 — fold LinkedIn-Beobachter heartbeat candidates into the same
    // sweep. Strength ≥ 4 + matched master company is the gating
    // contract; the linkedin db marks each visited row so the next
    // tick skips it. We never overwrite real publications even when
    // they overlap: both kinds can fire in the same sweep.
    const linkedin = await fetchLinkedInHeartbeatCandidates();
    const merged = [...real, ...linkedin];
    if (merged.length > 0) return merged;
    if (alerts.list().length > 0) return [];
    return demoOnce();
  };
})();

/** L6 helper — pulls LinkedIn-Beobachter signals that are ready for
 *  heartbeat judging. Wraps the linkedin db helper, transforms each
 *  row into a HeartbeatCandidate. The verdict is recorded post-tick
 *  via `recordLinkedInHeartbeatVerdicts` (registered as a tick
 *  listener once the heartbeat is built). */
async function fetchLinkedInHeartbeatCandidates(): Promise<
  Awaited<ReturnType<typeof realCandidateSource>>
> {
  try {
    const settings = readLinkedInSettings();
    if (!settings.enabled) return [];
    const db = await getLinkedInDb();
    const rows = await listLinkedInHeartbeatCandidates(db, {
      limit: 20,
      minStrength: 4,
    });
    return rows.map((r) => ({
      kind: "linkedin-signal" as const,
      companyId: r.companyId,
      companyName: r.companyName,
      sourceRef: `linkedin:${r.postUrn}:${r.companyId}`,
      occurredAt: r.postedAt
        ? new Date(r.postedAt).toISOString()
        : new Date().toISOString(),
      summary: r.summary,
      payload: {
        postUrn: r.postUrn,
        permalink: r.permalink,
        signalKind: r.signalKind,
        signalStrength: r.signalStrength,
        author: r.authorDisplayName,
        authorHeadline: r.authorHeadline,
        // Excerpt at 800 chars per spec — gives the judge enough text to
        // apply the "reine Selbstdarstellung" filter without blowing
        // the prompt budget.
        text: r.text.length > 800 ? r.text.slice(0, 800) : r.text,
      },
    }));
  } catch (err) {
    console.warn(
      "[heartbeat/linkedin] candidate fetch failed:",
      err instanceof Error ? err.message : err,
    );
    return [];
  }
}
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

/** L6 — after each heartbeat tick, mark every LinkedIn candidate that
 *  reached the judge so the next sweep skips it. Includes alerted +
 *  not-worth + judge-error outcomes; duplicates already advanced their
 *  cursor on the prior tick. The alert store still drives dedup; the
 *  cursor here is just a "we've evaluated this signal once" flag. */
async function recordLinkedInTickVerdicts(info: AlertTickInfo): Promise<void> {
  if (info.skipped) return;
  const linkedinDecisions = info.decisions.filter(
    (d) => d.kind === "linkedin-signal",
  );
  if (linkedinDecisions.length === 0) return;
  let db;
  try {
    db = await getLinkedInDb();
  } catch (err) {
    console.warn(
      "[heartbeat/linkedin] verdict recording skipped — db unavailable:",
      err instanceof Error ? err.message : err,
    );
    return;
  }
  const alertList = alerts.list();
  const alertBySourceRef = new Map(alertList.map((a) => [a.sourceRef, a.id]));
  for (const d of linkedinDecisions) {
    if (d.outcome === "duplicate" || d.outcome === "judge-error") continue;
    // sourceRef format: linkedin:<postUrn>:<companyId>
    const colon = d.sourceRef.indexOf(":");
    if (colon < 0 || !d.sourceRef.startsWith("linkedin:")) continue;
    const tail = d.sourceRef.slice("linkedin:".length);
    const lastColon = tail.lastIndexOf(":");
    const postUrn = lastColon > 0 ? tail.slice(0, lastColon) : tail;
    const alertId = alertBySourceRef.get(d.sourceRef) ?? null;
    try {
      await recordLinkedInHeartbeatVerdict(db, postUrn, alertId);
    } catch (err) {
      console.warn(
        `[heartbeat/linkedin] recordVerdict ${postUrn} failed:`,
        err instanceof Error ? err.message : err,
      );
    }
  }
}

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
heartbeat.on("tick", (info: AlertTickInfo) => {
  void recordLinkedInTickVerdicts(info);
});

// v0.1.200 — Audit-Trail store. Privacy-first: an embedded PGlite
// instance under userData/pglite/audit/ that NEVER syncs to any
// cloud DB. Every emit-site in main/ pipes through `audit()` below;
// AMQP-ferried events from producers + the gateway land here too.
//
// The store starts lazily on first append() — keeps app boot fast.
// Daily retention purge fires once on startup + every 24 h while the
// app is running.
const auditStore = new AuditStore();
let auditPurgeTimer: NodeJS.Timeout | null = null;
function audit(input: AuditEventInput): void {
  // Fire-and-forget; the renderer subscribes to `audit:inserted` for
  // live updates, and the IPC `audit:list` query happens on demand.
  // A failed insert just gets logged — no caller blocks on it.
  void auditStore.append(input).catch((err) => {
    console.warn("[audit] append failed:", err);
  });
}
auditStore.on("inserted", (event) => {
  // Live-broadcast to every open BrowserWindow so the Verlauf-Tab's
  // SSE-equivalent (IPC live stream) can prepend new events without
  // re-querying. The renderer filters client-side.
  for (const win of BrowserWindow.getAllWindows()) {
    try {
      win.webContents.send("audit:inserted", event);
    } catch {
      /* destroyed window — ignore */
    }
  }
});
// Heartbeat → audit. The tick itself is a routine event; we log
// only at info severity so a year of ticks fits comfortably under
// the retention TTL.
heartbeat.on("tick", (info: AlertTickInfo) => {
  audit({
    actorType: "scheduler",
    actorId: "heartbeat",
    category: "scheduler",
    action: "heartbeat.tick",
    severity: "info",
    subjectType: null,
    subjectId: null,
    summary: info.skipped
      ? `Heartbeat-Tick übersprungen${info.reason ? `: ${info.reason}` : ""}`
      : `Heartbeat-Tick: ${info.candidatesSeen} Kandidat(en) geprüft, ${info.alertsCreated} Alert(s) neu, ${info.duplicates} Duplikate`,
    metadata: {
      candidatesSeen: info.candidatesSeen,
      alertsCreated: info.alertsCreated,
      duplicates: info.duplicates,
      skipped: info.skipped,
      reason: info.reason ?? null,
      startedAt: info.startedAt,
      finishedAt: info.finishedAt,
    },
  });
});

// v0.1.201 — Auth + Updater audit emits. Wired as additional
// EventEmitter listeners (the existing broadcast handlers are
// untouched). Each event we log is a clear user-visible state
// transition that belongs in the trail.
let lastAuthSignedIn = false;
auth.on("status", (status: AuthStatus) => {
  if (status.signedIn !== lastAuthSignedIn) {
    audit({
      actorType: "user",
      actorId: status.actorId ?? null,
      category: "auth",
      action: status.signedIn ? "user.signed_in" : "user.signed_out",
      severity: "info",
      subjectType: null,
      subjectId: null,
      summary: status.signedIn
        ? `Angemeldet${status.actorId ? ` (${status.actorId})` : ""}`
        : "Abgemeldet",
      metadata: {
        actorId: status.actorId ?? null,
        tenantId: status.tenantId ?? null,
      },
    });
    lastAuthSignedIn = status.signedIn;
  }
});
let lastUpdaterState: string | null = null;
updater.on("status", (s: UpdateStatus) => {
  // Only state TRANSITIONS get audited, not progress ticks. The
  // download-progress events fire dozens of times during a single
  // download; we'd flood the log without adding signal.
  if (s.state !== lastUpdaterState) {
    audit({
      actorType: "system",
      actorId: "updater",
      category: "update",
      action: `updater.state.${s.state}`,
      severity: s.state === "error" ? "error" : "info",
      subjectType: null,
      subjectId: null,
      summary: updaterStateSummary(s),
      metadata: {
        state: s.state,
        currentVersion: s.currentVersion,
        latestVersion: s.latestVersion ?? null,
        error: s.errorMessage ?? null,
      },
    });
    lastUpdaterState = s.state;
  }
});
function updaterStateSummary(s: UpdateStatus): string {
  switch (s.state) {
    case "checking":
      return "Update-Prüfung läuft";
    case "available":
      return `Update verfügbar: v${s.latestVersion ?? "?"}`;
    case "up-to-date":
      return "App ist aktuell";
    case "downloading":
      return `Update wird heruntergeladen${s.latestVersion ? ` (v${s.latestVersion})` : ""}`;
    case "ready":
      return `Update bereit zur Installation${s.latestVersion ? ` (v${s.latestVersion})` : ""}`;
    case "installing":
      return "Update wird installiert (Neustart)";
    case "error":
      return `Update-Fehler: ${s.errorMessage ?? "unbekannt"}`;
    default:
      return `Updater-Status: ${s.state}`;
  }
}

// v0.1.118 — heartbeat-driven auto-retry. Polls the gateway every
// ~10 min for failed producer cells whose `nextRetryAt` has matured
// and re-fires the per-stage retry endpoint. Independent of the alert
// judge so a slow LLM tick can't starve it. Gated behind
// `alertPrefs.autoRetryEnabled` (default on) and `cadenceMinutes > 0`
// — both checked on every tick, so Settings changes apply live.
const retryTicker = new RetryTicker({
  gateway: gatewayClient,
  alertPrefs,
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

// Memory store (Phase 8.d). Probed once at boot — if the userData/agent/memory
// directory isn't writable (read-only volume, sandbox glitch, …) we surface
// the reason via AgentStatus.memoryError so the FirstRunWizard can flag it,
// and we run the orchestrator without the on-disk mirror. Conversations
// still work in-memory for the lifetime of the process.
//
// v0.1.110 / Phase T3 — declared here (was lower in the file) so the
// chat_history_* agent tools below get the same instance.
const memory = new MemoryStore();
const memoryProbe = memory.probe();
if (!memoryProbe.writable) {
  console.warn(
    `[memory] probe failed at ${memoryProbe.path}: ${memoryProbe.reason}`,
  );
}

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
  // v0.1.54 — CRM connect/disconnect/status tools.
  crm: crmManager,
  // Phase T1 — `crm_enrich_now` posts to the gateway cache endpoint
  // (HubSpot live enrichment). Reuses the same auth source as the
  // `crm:enrich:run` IPC handler.
  getBearer: () => auth.getAccessToken(),
  gatewayUrl: GATEWAY_URL,
  // Phase T2 — local LLM, voice setup, OTA updater self-service tools.
  ollama,
  whisper,
  updater,
  // Phase T3 — reachability + producer diagnostics + chat-history tools.
  externalServiceMonitor,
  producers,
  producerLogBuffer,
  memory,
});
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
  // v0.1.161 — fold the long-term memory entries into the system
  // prompt on every turn. Previously the agent could only reach them
  // via `recall_memory`-tool-use; the auto-inject closes the failure
  // mode where it answered "I don't know anything about you" despite
  // the store containing entries.
  generalMemoryStore: generalMemory,
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
  // Wire the on-disk handler for the `ava-screenshot://` protocol we
  // pre-registered above. Also prune captures older than the TTL so
  // a long-running install doesn't accumulate gigabytes of frames.
  registerScreenshotProtocol();
  void pruneOldScreenshots();
  // L6 — same protocol pattern for LinkedIn media thumbnails.
  registerLinkedInMediaProtocol();

  // v0.1.55 — clear `com.apple.quarantine` from this bundle. This
  // launch's process retains its quarantine flag (set by the kernel
  // at exec time), but the bundle on disk becomes clean — so the
  // NEXT launch boots un-quarantined and OTA can complete without
  // ShipIt tripping on hardened-runtime dylibs. See
  // ./scrub-quarantine.ts for the full root-cause analysis.
  void scrubQuarantine();
  // v0.1.162 — additionally scrub the whisper resources subtree so a
  // freshly-installed bundle's libwhisper.* siblings don't fail
  // dlopen() inside whisper-cli with a native crash. The main bundle
  // scrub above already covers .app/Contents/Resources, but doing the
  // whisper subtree explicitly + first lets the sidecar boot cleanly
  // even if the broader scrub is mid-walk.
  void scrubWhisperBundle();

  // v0.1.52 — start the external-service reachability monitor. First
  // probe runs synchronously inside start(); the recurring 60s
  // interval kicks in after.
  externalServiceMonitor.start();

  // v0.1.181 — background OAuth refresh for the Anthropic In-App
  // subscription token. Without this, the access_token expires after
  // ~1h and every producer's LLM call returns "Invalid authentication
  // credentials" until the user manually clicks "Neu verbinden" in
  // Settings. The refresher silently swaps for a fresh access_token
  // ~15 min before expiry using the stored refresh_token. The first
  // tick runs synchronously inside start() so a long-stale token
  // gets refreshed at boot before any producer-spawn.
  const { AnthropicTokenRefresher } = await import("./auth/token-refresher");
  const { ProviderConfigStore } = await import("./agent/providers/store");
  const providerConfigStore = ProviderConfigStore.shared();
  const anthropicTokenRefresher = new AnthropicTokenRefresher(
    providerConfigStore,
  );
  anthropicTokenRefresher.start();
  app.on("before-quit", () => anthropicTokenRefresher.stop());

  // v0.1.182 — cycle ALL producers when the user's LLM credentials
  // change (api-key or subscription token), debounced to coalesce
  // rapid edits. Without this, a "Neu verbinden" click or an
  // auto-refresh from the AnthropicTokenRefresher saves the new
  // token to disk but the running producer subprocesses keep using
  // the OLD env var that was captured at spawn time. Result for the
  // user was a sticky "Invalid authentication credentials" loop --
  // the new token sits unused until manual app restart.
  //
  // Why ALL producers, not just website: every LLM-driven producer
  // (company-profile, company-contact, company-evaluation,
  // company-publication, website) reads ANTHROPIC_AUTH_TOKEN /
  // ANTHROPIC_API_KEY / etc. at spawn. They all need a fresh env to
  // pick up a renewed credential. The cycle takes ~10-15s; AMQP
  // re-queues any in-flight messages, so the only user-visible
  // effect is a brief stall.
  let credCycleTimer: NodeJS.Timeout | null = null;
  function scheduleCredentialCycle(reason: string): void {
    if (credCycleTimer) clearTimeout(credCycleTimer);
    credCycleTimer = setTimeout(() => {
      credCycleTimer = null;
      console.info(
        `[providers] credentials changed (${reason}) — cycling producers to pick up new env`,
      );
      audit({
        actorType: "system",
        actorId: "credential-cycle",
        category: "auth",
        action: "producers.cycle.scheduled",
        severity: "info",
        subjectType: null,
        subjectId: null,
        summary: `Producer-Cycle wegen Credential-Änderung (${reason})`,
        metadata: { reason },
      });
      for (const p of producers) {
        const s = p.getStatus().state;
        if (s === "idle" || s === "stopping") continue;
        void (async () => {
          const name = p.getStatus().name;
          try {
            await p.stop();
          } catch (err) {
            console.warn(`[providers] ${name}.stop() rejected:`, err);
            return;
          }
          if (!auth.getStatus().signedIn) return;
          try {
            await p.start();
          } catch (err) {
            console.error(`[providers] ${name}.start() rejected after restart:`, err);
          }
        })();
      }
    }, 500);
  }
  providerConfigStore.on("keyChanged", (kind) => {
    scheduleCredentialCycle(`keyChanged(${kind})`);
    audit({
      actorType: "user",
      actorId: null,
      category: "auth",
      action: "credential.key.changed",
      severity: "info",
      subjectType: "credential",
      subjectId: kind,
      summary: `API-Key für ${kind} aktualisiert`,
      metadata: { provider: kind },
    });
  });
  providerConfigStore.on("anthropicSubscriptionTokenChanged", () => {
    scheduleCredentialCycle("anthropicSubscriptionTokenChanged");
    audit({
      actorType: "user",
      actorId: null,
      category: "auth",
      action: "credential.subscription.changed",
      severity: "info",
      subjectType: "credential",
      subjectId: "anthropic-subscription",
      summary: "Anthropic-Subscription-Token aktualisiert",
      metadata: { provider: "anthropic", authMode: "subscription" },
    });
  });
  // configChanged covers anthropicAuthMode flips ("auf API-Key umschalten"
  // / "auf Abo umschalten") which change which env var the producer
  // resolves at spawn time. Provider-kind / model-id changes also need
  // a cycle.
  providerConfigStore.on("configChanged", () =>
    scheduleCredentialCycle("configChanged"),
  );

  // v0.1.192 — reactive on-401 recovery.
  //
  // The scheduled refresher (v0.1.181) handles the happy path: tick
  // every 5 min, refresh when <15 min remain. But it misses three
  // cases the user just hit in production:
  //
  //   1. Legacy login without refresh_token (record from before
  //      v0.1.181) — tick early-returns at the `!refreshToken` gate.
  //   2. App was suspended (laptop closed) past the token expiry —
  //      by the time we wake up, the token is dead and producers
  //      hold the stale env from spawn time.
  //   3. Server-side early revocation (clock skew, manual logout in
  //      another tab) — the access_token died before our `expiresAt`
  //      would have triggered a tick.
  //
  // In all three the producer hits a 401 on its next LLM call. We
  // watch the producer's stdio for the credential-rejection patterns
  // emitted in those cases (`Invalid authentication credentials` for
  // Anthropic, `authentication_error` for the SDK wrappers,
  // `Incorrect API key` for OpenAI) and:
  //
  //   - try a forced refresh via tokenRefresher.refreshNow();
  //   - on "refreshed" → schedule a credential cycle so the producer
  //     re-spawns with the new env;
  //   - on "no_refresh_token" / "revoked" → surface an OS notification
  //     pointing the user at Settings → Modelle → Anthropic so they
  //     can re-connect manually. We don't auto-cycle in those cases
  //     because cycling would just hit the same 401 again.
  //   - on "transient" → leave it to the next scheduled tick (or a
  //     subsequent producer error) to retry.
  //
  // Debounce lives inside ProducerSupervisor (30 s per producer); the
  // global authRecoveryInFlight flag below prevents two producers
  // hitting auth-failures simultaneously from racing on the refresh.
  let authRecoveryInFlight = false;

  // v0.1.205 — auth-blocked state machine.
  //
  // When refreshNow() returns a non-recoverable status (revoked /
  // no_refresh_token / no_record) we STOP all producers and pause
  // the retry-ticker — otherwise the heartbeat-driven retry-ticker
  // keeps re-firing the same failed cell every 5–10 min, the
  // producer hits the same 401 with the same stale token, and the
  // user wastes hours of LLM credit on a crashloop they can't
  // diagnose. Real-world example: company-profile crashlooped on a
  // single message for 12 h, producing 30+ "Invalid authentication
  // credentials" log lines / each firing wasted retries / quota.
  //
  // Producers resume automatically once the user updates credentials
  // (any of keyChanged / anthropicSubscriptionTokenChanged /
  // configChanged unblocks + the existing scheduleCredentialCycle
  // path restarts them).
  //
  // Transient failures (network / 5xx) DON'T block immediately; we
  // count them and only block after 3 consecutive failures within
  // 30 minutes. This avoids overreacting to a single flaky network
  // moment while still catching the "refresh-tries-but-can't-reach-
  // Anthropic-for-hours" case.
  const TRANSIENT_FAILURE_THRESHOLD = 3;
  const TRANSIENT_FAILURE_WINDOW_MS = 30 * 60 * 1000;
  let authBlocked = false;
  let authBlockedReason: string | null = null;
  let transientFailures: number[] = []; // timestamps within the window

  function blockAuth(reason: string): void {
    if (authBlocked) return;
    authBlocked = true;
    authBlockedReason = reason;
    console.warn(
      `[providers] AUTH BLOCKED (${reason}) — stopping all producers and pausing retry-ticker until the user re-authenticates`,
    );
    audit({
      actorType: "system",
      actorId: "auth-guard",
      category: "auth",
      action: "auth.blocked",
      severity: "error",
      subjectType: "credential",
      subjectId: "anthropic-subscription",
      summary: `Producer-Verarbeitung pausiert: ${reason}`,
      metadata: { reason, transientFailureCount: transientFailures.length },
    });
    // Stop the retry-ticker so the heartbeat doesn't keep refiring
    // failed cells against the stale token.
    try {
      retryTicker.stop();
    } catch (err) {
      console.warn("[providers] retryTicker.stop() failed:", err);
    }
    // Stop every running producer. They'll re-spawn through the
    // existing scheduleCredentialCycle() path once a credential
    // change fires.
    for (const p of producers) {
      const s = p.getStatus().state;
      if (s === "idle" || s === "stopping" || s === "error") continue;
      void p.stop().catch((err) => {
        console.warn(`[providers] stop(${p.getStatus().name}) rejected:`, err);
      });
    }
    notifyUserAuthExpired("anthropic");
  }

  function unblockAuth(trigger: string): void {
    if (!authBlocked) return;
    authBlocked = false;
    const prevReason = authBlockedReason;
    authBlockedReason = null;
    transientFailures = [];
    console.info(
      `[providers] auth unblocked (${trigger}, was: ${prevReason}); retry-ticker resuming`,
    );
    audit({
      actorType: "system",
      actorId: "auth-guard",
      category: "auth",
      action: "auth.unblocked",
      severity: "info",
      subjectType: "credential",
      subjectId: "anthropic-subscription",
      summary: `Producer-Verarbeitung freigegeben (${trigger})`,
      metadata: { trigger, previousReason: prevReason },
    });
    try {
      retryTicker.start();
    } catch (err) {
      console.warn("[providers] retryTicker.start() failed:", err);
    }
    // Producers re-spawn via the scheduleCredentialCycle() path —
    // the same event that called us also fires that. No double-
    // cycle needed here.
  }

  function recordTransientFailure(): boolean {
    const now = Date.now();
    transientFailures = transientFailures.filter(
      (t) => now - t < TRANSIENT_FAILURE_WINDOW_MS,
    );
    transientFailures.push(now);
    return transientFailures.length >= TRANSIENT_FAILURE_THRESHOLD;
  }

  // Register the unblock-on-credential-change listeners as a SECOND
  // subscription (the original providerConfigStore.on(...) calls
  // above already drive scheduleCredentialCycle; this just adds an
  // unblock pass for the auth-blocked path). Order matters: this
  // runs AFTER scheduleCredentialCycle's listener, so by the time
  // unblockAuth fires retryTicker.start(), producers are already
  // queued to restart with fresh env.
  providerConfigStore.on("keyChanged", (kind) =>
    unblockAuth(`keyChanged(${kind})`),
  );
  providerConfigStore.on("anthropicSubscriptionTokenChanged", () =>
    unblockAuth("anthropicSubscriptionTokenChanged"),
  );
  providerConfigStore.on("configChanged", () =>
    unblockAuth("configChanged"),
  );
  async function handleProducerAuthError(args: {
    producerName: string;
    provider: string | null;
  }): Promise<void> {
    if (authRecoveryInFlight) return;
    audit({
      actorType: "producer",
      actorId: args.producerName,
      category: "auth",
      action: "credential.rejected",
      severity: "warning",
      subjectType: "credential",
      subjectId: args.provider,
      summary: `Producer ${args.producerName} meldet abgelehnten ${args.provider ?? "LLM-"}Credential`,
      metadata: { producer: args.producerName, provider: args.provider },
    });
    if (args.provider !== "anthropic") {
      // Only the Anthropic OAuth path has an auto-refreshable
      // credential today. OpenAI / Google / Mistral keys can't be
      // self-healed — surface a clear UI hint instead.
      console.warn(
        `[providers] producer ${args.producerName} signalled auth failure for provider=${args.provider}; no auto-refresh available, user must update the key in Settings.`,
      );
      void notifyUserAuthExpired(args.provider);
      return;
    }
    authRecoveryInFlight = true;
    try {
      console.info(
        `[providers] producer ${args.producerName} signalled Anthropic auth failure; attempting forced token refresh`,
      );
      const result = await anthropicTokenRefresher.refreshNow();
      audit({
        actorType: "system",
        actorId: "token-refresher",
        category: "auth",
        action: `token.refresh.${result.status}`,
        severity: result.status === "refreshed" ? "info" : "warning",
        subjectType: "credential",
        subjectId: "anthropic-subscription",
        summary:
          result.status === "refreshed"
            ? "Anthropic-OAuth-Token erneuert (reaktiv nach 401)"
            : result.status === "no_refresh_token"
              ? "Anthropic-Token-Refresh übersprungen (Legacy-Login ohne refresh_token)"
              : result.status === "revoked"
                ? "Anthropic-Token-Refresh abgelehnt (revoked, Neu-Anmeldung erforderlich)"
                : result.status === "transient"
                  ? "Anthropic-Token-Refresh transient fehlgeschlagen (Retry geplant)"
                  : "Anthropic-Token-Refresh übersprungen (kein Record)",
        metadata: {
          trigger: "producer-401",
          producer: args.producerName,
          ...(result.status === "revoked" || result.status === "transient"
            ? { error: (result as { error?: string }).error ?? null }
            : {}),
        },
      });
      switch (result.status) {
        case "refreshed":
          // Reset the transient-failure tally — we've recovered.
          // The setAnthropicSubscriptionRecord() call inside the
          // refresher already fired the
          // anthropicSubscriptionTokenChanged event, which routes
          // through scheduleCredentialCycle() — we don't cycle
          // here.
          transientFailures = [];
          console.info(
            `[providers] forced refresh succeeded for ${args.producerName}; producers will cycle automatically`,
          );
          return;
        case "no_refresh_token":
          console.warn(
            `[providers] forced refresh skipped: legacy OAuth record without refresh_token. User must re-connect.`,
          );
          // v0.1.205 — non-recoverable: block until user re-logs.
          blockAuth("legacy OAuth login ohne refresh_token");
          return;
        case "revoked":
          console.warn(
            `[providers] forced refresh rejected by Anthropic (revoked). User must re-connect: ${result.error}`,
          );
          blockAuth("Anthropic-Refresh-Token revoked");
          return;
        case "transient":
          // v0.1.205 — count transient failures; block after N in
          // the rolling window so a sustained outage doesn't
          // crashloop producers for hours.
          console.warn(
            `[providers] forced refresh transient failure: ${result.error}. Will retry on next scheduled tick.`,
          );
          if (recordTransientFailure()) {
            blockAuth(
              `${TRANSIENT_FAILURE_THRESHOLD} aufeinanderfolgende transiente Refresh-Fehler — Netzwerk oder Anthropic unerreichbar`,
            );
          }
          return;
        case "no_record":
          // No subscription token at all — the user is on an api-key
          // path that hit 401 anyway. Block too.
          blockAuth("kein Anthropic-Subscription-Record vorhanden");
          return;
      }
    } finally {
      authRecoveryInFlight = false;
    }
  }

  function notifyUserAuthExpired(provider: string | null): void {
    const label =
      provider === "anthropic"
        ? "Anthropic"
        : provider === "openai"
          ? "OpenAI"
          : provider === "google"
            ? "Google"
            : provider === "mistral"
              ? "Mistral"
              : "LLM-Provider";
    const body =
      provider === "anthropic"
        ? `${label}-Anmeldung abgelaufen. In den Einstellungen → Modelle → ${label} bitte neu verbinden.`
        : `${label}-API-Key wird nicht mehr akzeptiert. In den Einstellungen → Modelle → ${label} bitte neuen Key eintragen.`;
    try {
      const { Notification } = require("electron") as typeof import("electron");
      if (Notification.isSupported()) {
        new Notification({
          title: "AVA: Anmeldung erforderlich",
          body,
        }).show();
      }
    } catch (err) {
      console.warn("[providers] failed to show auth-expired notification:", err);
    }
    // Also broadcast to any open windows so the renderer can show an
    // in-app banner / Settings nudge. Renderer-side handler is best-
    // effort; falling back to the OS notification covers the
    // app-in-background case.
    for (const win of BrowserWindow.getAllWindows()) {
      try {
        win.webContents.send("providers:authExpired", { provider });
      } catch {
        /* window may already be destroyed; ignore */
      }
    }
  }

  for (const p of producers) {
    p.on(
      "authError",
      (args: { producerName: string; provider: string | null }) => {
        void handleProducerAuthError(args);
      },
    );
    // v0.1.201 — producer-emitted audit events arrive via the
    // stdout `__AVA_AUDIT__…` marker convention (see
    // producer-supervisor.ts → detectAuditMarker). The supervisor
    // already filled in actorType/actorId defaults; we just have
    // to coerce the payload back into the canonical shape and
    // append.
    p.on("auditEvent", (payload: Record<string, unknown>) => {
      try {
        audit({
          actorType: (payload.actorType as AuditEventInput["actorType"]) ??
            "producer",
          actorId:
            typeof payload.actorId === "string" ? payload.actorId : null,
          category: payload.category as AuditEventInput["category"],
          action: String(payload.action),
          severity:
            (payload.severity as AuditEventInput["severity"]) ?? "info",
          subjectType:
            (payload.subjectType as AuditEventInput["subjectType"]) ?? null,
          subjectId:
            typeof payload.subjectId === "string" ? payload.subjectId : null,
          summary: String(payload.summary),
          metadata:
            (payload.metadata as Record<string, unknown> | undefined) ?? {},
        });
      } catch (err) {
        console.warn(
          `[audit] producer ${p.getStatus().name} emitted invalid payload:`,
          err,
        );
      }
    });
    // v0.1.200 — audit producer lifecycle, but only the user-
    // relevant transitions (entered error / recovered to ready).
    // The starting/stopping/idle churn is high-frequency noise
    // that already lives in the Producer-Status-Panel; keeping
    // it out of the audit log saves TTL space for actual signal.
    let prevState: string | null = null;
    p.on("status", (status: ProducerStatus) => {
      const cur = status.state;
      const wasErrored = prevState === "error";
      if (cur === "error" && prevState !== "error") {
        audit({
          actorType: "producer",
          actorId: status.name,
          category: "producer",
          action: "producer.error",
          severity: "error",
          subjectType: null,
          subjectId: null,
          summary: `Producer ${status.name} fehlerhaft: ${status.errorMessage ?? "unbekannte Ursache"}`,
          metadata: {
            producer: status.name,
            errorMessage: status.errorMessage,
            lastExitCode: status.lastExitCode,
          },
        });
      } else if (cur === "ready" && wasErrored) {
        audit({
          actorType: "producer",
          actorId: status.name,
          category: "producer",
          action: "producer.recovered",
          severity: "info",
          subjectType: null,
          subjectId: null,
          summary: `Producer ${status.name} wieder bereit (nach Fehler)`,
          metadata: { producer: status.name },
        });
      }
      prevState = cur;
    });
  }

  // v0.1.54 — hydrate persisted CRM tokens from disk + start
  // broadcasting status changes to the renderer. Failures here are
  // non-fatal: a corrupt/encrypted-unavailable record just leaves
  // the provider as "not connected" until the user re-runs OAuth.
  // v0.1.201 — audit CRM lifecycle. crmManager.on("status") fires
  // once per provider whose state changed. We only audit the
  // "connected" <-> "disconnected" boundary (transitions), not every
  // refresh tick: those would be noise. Track last-seen-state per
  // provider.
  const lastCrmConnected = new Map<string, boolean>();
  crmManager.on("status", (status: CrmStatus) => {
    for (const win of BrowserWindow.getAllWindows()) {
      win.webContents.send("crm-status:changed", status);
    }
    try {
      const prev = lastCrmConnected.get(status.provider) ?? false;
      if (status.connected !== prev) {
        audit({
          actorType: "user",
          actorId: null,
          category: "crm",
          action: status.connected ? "crm.connected" : "crm.disconnected",
          severity: "info",
          subjectType: null,
          subjectId: status.provider,
          summary: status.connected
            ? `CRM verbunden: ${status.provider}${status.account ? ` (${status.account})` : ""}`
            : `CRM getrennt: ${status.provider}`,
          metadata: {
            provider: status.provider,
            account: status.account ?? null,
            lastError: status.lastError ?? null,
          },
        });
        lastCrmConnected.set(status.provider, status.connected);
      }
    } catch (err) {
      console.warn("[audit] crm-status hook failed:", err);
    }
  });
  await crmManager.hydrate().catch((err: unknown) => {
    // eslint-disable-next-line no-console
    console.warn("[crm] hydrate failed:", err);
  });

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

  // M3 monetization — Stripe Checkout / Customer Portal IPC + the
  // `ava://billing/*` protocol bridge. Registers its own ipcMain
  // handlers for `billing:openCheckout` / `billing:openPortal` and
  // wires `app.on('open-url')` for Stripe success/cancel redirects.
  initBilling({
    gatewayUrl: APP_CONFIG.gatewayUrl,
    getAccessToken: () => auth.getAccessToken(),
  });

  // v0.1.101 — generic shell.openExternal bridge for plain http/https
  // links (Enterprise contact page on Settings → Plan & Abrechnung).
  // Refuses any other scheme so the renderer can't open arbitrary
  // URIs (file:, javascript:, custom protocols, etc.) through this
  // path — those should each have their own dedicated IPC.
  ipcMain.handle("shell:openExternal", async (_e, url: string) => {
    if (typeof url !== "string") {
      throw new Error("shell:openExternal requires a string URL");
    }
    let parsed: URL;
    try {
      parsed = new URL(url);
    } catch {
      throw new Error("shell:openExternal: invalid URL");
    }
    if (parsed.protocol !== "https:" && parsed.protocol !== "http:") {
      throw new Error(
        `shell:openExternal: refused non-http(s) scheme '${parsed.protocol}'`,
      );
    }
    await shell.openExternal(parsed.toString());
  });

  // v0.1.155 — reveal-in-Finder + open-dir bridge for the
  // silent-OTA-failure banner. We don't enforce a scheme here because
  // file-system paths aren't URLs; we DO restrict to absolute paths
  // so the renderer can't trick main into opening relative paths from
  // CWD. file:// schemes are blocked at the openExternal layer above.
  ipcMain.handle("shell:showItemInFolder", (_e, path: string) => {
    if (typeof path !== "string" || !path.startsWith("/")) return;
    shell.showItemInFolder(path);
  });
  ipcMain.handle("shell:openPath", async (_e, path: string) => {
    if (typeof path !== "string" || !path.startsWith("/")) return;
    await shell.openPath(path);
  });

  // LinkedIn-Beobachter (Phase L0). Persistent settings + consent gate
  // + kill-switch IPC. No scraper code here yet — that lands in L1+.
  initLinkedIn({ providers, gateway: gatewayClient });

  // Skills loader (PLAN §2, S1+S2). Discovers SKILL.md files in
  // userData/skills/ and <repo>/.ava/skills/, validates frontmatter,
  // evaluates `metadata.ava.requires` against the live CRM + Ollama
  // managers, hot-reloads on save, and surfaces the loaded skills
  // to the agent orchestrator (system-prompt block + /name
  // invocation + enforced tool allowlist).
  //
  // CRM connect/disconnect does NOT auto-trigger a skill reload yet —
  // S2-followup: `crmManager.on("status", () => skillStore.reload())`.
  const skillGate = buildGateEvaluator({
    isCrmConnected: (provider) => {
      if (provider === "any") {
        return crmManager
          .getAllStatuses()
          .some((s: CrmStatus) => s.connected);
      }
      // Provider names line up with CrmProvider strings ("hubspot",
      // "salesforce", "dynamics"). Anything unknown is treated as
      // not connected.
      if (
        provider === "hubspot" ||
        provider === "salesforce" ||
        provider === "dynamics"
      ) {
        return crmManager.getStatus(provider).connected;
      }
      return false;
    },
    ollamaState: () => {
      const st = ollama.getStatus();
      return {
        installed: st.host !== null || st.installed.length > 0,
        running: st.state === "ready",
      };
    },
  });
  // S4 — single SkillsTrustStore instance shared between the loader's
  // trust evaluator and the IPC `skills:trust` handler. Must be
  // constructed before `initSkills` so the bundled-starter vendor
  // hook can auto-trust on first install.
  const skillsTrust = new SkillsTrustStore();
  const skillStore = await initSkills(app, {
    evaluateGate: skillGate,
    trustStore: skillsTrust,
  }).catch((err: unknown) => {
    console.error(
      `[skills] Initialisierung fehlgeschlagen: ${err instanceof Error ? err.message : String(err)}`,
    );
    return null;
  });
  // S3 — per-user enabled-state for skills. Wire BEFORE the SkillStore
  // hook-up so the orchestrator's availableSkills() filter has the
  // prefs in hand on the first turn.
  const skillsPrefs = new SkillsPrefsStore();
  agent.setSkillsPrefs(skillsPrefs);
  if (skillStore) {
    agent.setSkillStore(skillStore);
  }

  /** S3 — project a LoadedSkill + prefs/gate state down to the
   *  renderer-facing SkillRow shape. */
  function toSkillRow(s: import("./skills").LoadedSkill): SkillRow {
    return {
      name: s.name,
      description: s.description,
      language: s.language,
      b2bScope: s.b2bScope,
      allowedTools: s.allowedTools.slice(),
      requiresUserConfirm: s.requiresUserConfirm,
      disableModelInvocation: s.disableModelInvocation,
      userInvocable: s.userInvocable,
      scope: s.scope,
      sourcePath: s.sourcePath,
      hash: s.hash,
      enabled: skillsPrefs.isEnabled(s.name),
      gateSatisfied: s.gateSatisfied,
      gateReason: s.gateReason,
      trust: s.trust,
      previouslyTrustedAllowedTools: s.previouslyTrustedAllowedTools.slice(),
    };
  }

  function broadcastSkillsChanged(): void {
    for (const win of BrowserWindow.getAllWindows()) {
      win.webContents.send("skills:changed");
    }
  }
  if (skillStore) {
    skillStore.on("changed", broadcastSkillsChanged);
  }
  skillsPrefs.on("changed", broadcastSkillsChanged);
  // S4 — trust changes (accept, revoke after a save, after a delete)
  // also propagate so the Settings row's trust pill updates live.
  skillsTrust.on("changed", () => {
    // A trust change can re-classify an existing LoadedSkill (its
    // `trust` field comes from the evaluator that closes over the
    // trust store). The cleanest way to make the renderer see the
    // new state is to reload the store — cheap, and matches the
    // S1 hot-reload pattern.
    if (skillStore) {
      void skillStore.reload().catch((err) => {
        console.warn(
          `[skills] Reload nach Trust-Änderung fehlgeschlagen: ${err instanceof Error ? err.message : String(err)}`,
        );
      });
    } else {
      broadcastSkillsChanged();
    }
  });

  // ---- Skills IPC (S3) ----------------------------------------------------
  ipcMain.handle("skills:list", (): SkillRow[] => {
    const all = skillStore?.list() ?? [];
    const rows = all.map(toSkillRow);
    rows.sort((a, b) => a.name.localeCompare(b.name, "de"));
    return rows;
  });
  ipcMain.handle(
    "skills:getBody",
    (_e, name: string): SkillBody | null => {
      const s = skillStore?.get(name);
      if (!s) return null;
      return { body: s.body, sourcePath: s.sourcePath, hash: s.hash };
    },
  );
  ipcMain.handle(
    "skills:setEnabled",
    (_e, args: { name: string; enabled: boolean }): void => {
      if (!args || typeof args.name !== "string") {
        throw new Error("skills:setEnabled erwartet { name, enabled }");
      }
      skillsPrefs.setEnabled(args.name, args.enabled !== false);
    },
  );
  ipcMain.handle("skills:reload", async (): Promise<void> => {
    if (!skillStore) return;
    await skillStore.reload();
  });
  ipcMain.handle(
    "skills:openSourceDir",
    async (
      _e,
      target?: string,
    ): Promise<{ ok: true } | { error: string }> => {
      // No argument → user-scope skills directory.
      const path =
        typeof target === "string" && target.length > 0
          ? target
          : join(app.getPath("userData"), "skills");
      try {
        const err = await shell.openPath(path);
        if (err) return { error: err };
        return { ok: true };
      } catch (err) {
        return { error: err instanceof Error ? err.message : String(err) };
      }
    },
  );

  // ---- Skills IPC (S4 — editor, trust, delete, tool list) ---------------

  // Node helpers used by the S4 IPC handlers below. Pulled in via
  // require like the rest of main/index.ts to avoid adding top-level
  // imports for narrow-use stdlib calls.
  const { readFileSync, existsSync: existsSyncFs, rmSync } =
    require("node:fs") as typeof import("node:fs");
  const { createHash } = require("node:crypto") as typeof import("node:crypto");
  const nodePath = require("node:path") as typeof import("node:path");

  ipcMain.handle(
    "skills:save",
    async (_e, payload: SkillSavePayload): Promise<SkillSaveResult> => {
      if (!payload || typeof payload !== "object") {
        return { ok: false, error: "skills:save erwartet ein Payload-Objekt" };
      }
      const userDir = join(app.getPath("userData"), "skills");
      try {
        const res = await saveSkillToDisk(userDir, payload);
        if (!res.ok || !res.name || !res.path) {
          return { ok: false, error: res.error ?? "Unbekannter Fehler" };
        }
        // Auto-trust the freshly authored content: the user just wrote
        // it, so by definition they trust it. We hash the on-disk file
        // (not the payload) so the value matches what the loader sees
        // on the next scan.
        try {
          const written = readFileSync(res.path, "utf8");
          const hash = createHash("sha256").update(written, "utf8").digest("hex");
          skillsTrust.trust(
            res.name,
            hash,
            payload.frontmatter["allowed-tools"] ?? [],
          );
        } catch (err) {
          console.warn(
            `[skills] Auto-Trust nach Save fehlgeschlagen: ${err instanceof Error ? err.message : String(err)}`,
          );
        }
        if (skillStore) {
          await skillStore.reload();
        }
        return { ok: true, name: res.name };
      } catch (err) {
        return {
          ok: false,
          error: err instanceof Error ? err.message : String(err),
        };
      }
    },
  );

  ipcMain.handle(
    "skills:delete",
    async (_e, name: string): Promise<SkillDeleteResult> => {
      if (typeof name !== "string" || !name) {
        return { ok: false, error: "skills:delete erwartet einen Namen" };
      }
      // Refuse to touch workspace-scope skills — those live in the
      // user's project repo and we don't want to silently delete
      // committed files.
      const target = skillStore?.get(name);
      if (target && target.scope === "workspace") {
        return {
          ok: false,
          error:
            "Workspace-Skills werden im Projekt-Repo verwaltet und können hier nicht gelöscht werden.",
        };
      }
      const userDir = join(app.getPath("userData"), "skills");
      const skillDir = join(userDir, name);
      try {
        // Bounds check: refuse anything that resolves outside userDir
        // (defence against path-traversal via crafted names).
        const resolved = nodePath.resolve(skillDir);
        const root = nodePath.resolve(userDir);
        if (!resolved.startsWith(root + nodePath.sep)) {
          return {
            ok: false,
            error: "Ungültiger Skill-Name (Pfad-Traversal abgewiesen).",
          };
        }
        if (!existsSyncFs(skillDir)) {
          // Already gone — clear trust state anyway.
          skillsTrust.revoke(name);
          if (skillStore) await skillStore.reload();
          return { ok: true };
        }
        rmSync(skillDir, { recursive: true, force: true });
        skillsTrust.revoke(name);
        if (skillStore) await skillStore.reload();
        return { ok: true };
      } catch (err) {
        return {
          ok: false,
          error: err instanceof Error ? err.message : String(err),
        };
      }
    },
  );

  ipcMain.handle("skills:trust", async (_e, name: string): Promise<void> => {
    if (typeof name !== "string" || !name) {
      throw new Error("skills:trust erwartet einen Namen");
    }
    const target = skillStore?.get(name);
    if (!target) return;
    skillsTrust.trust(name, target.hash, target.allowedTools);
    // changed-listener above re-reloads the store so the row's
    // `trust` field flips to "trusted" without a manual refresh.
  });

  ipcMain.handle(
    "skills:listAvailableTools",
    (): { name: string; description: string }[] => {
      return agentRegistry
        .list()
        .map((t) => ({ name: t.name, description: t.description }))
        .sort((a, b) => a.name.localeCompare(b.name));
    },
  );

  // ---- Skills IPC (S5 — import / export) --------------------------------

  function focusedWindow(): BrowserWindow | null {
    return (
      BrowserWindow.getFocusedWindow() ??
      BrowserWindow.getAllWindows()[0] ??
      null
    );
  }

  ipcMain.handle(
    "skills:export",
    async (_e, name: string): Promise<SkillExportResult> => {
      if (typeof name !== "string" || !name) {
        return { ok: false, error: "skills:export erwartet einen Namen" };
      }
      const target = skillStore?.get(name);
      if (!target) {
        return { ok: false, error: `Skill '${name}' nicht gefunden.` };
      }
      const parent = focusedWindow();
      const res = await dialog.showSaveDialog(parent ?? undefined as never, {
        title: "Skill exportieren",
        defaultPath: `${name}.zip`,
        filters: [{ name: "Skill-Paket", extensions: ["zip"] }],
      });
      if (res.canceled || !res.filePath) {
        return { ok: false, cancelled: true };
      }
      return exportSkillToZipFile(target, res.filePath);
    },
  );

  ipcMain.handle(
    "skills:exportAll",
    async (): Promise<SkillExportAllResult> => {
      const all = skillStore?.list() ?? [];
      const today = new Date().toISOString().slice(0, 10);
      const parent = focusedWindow();
      const res = await dialog.showSaveDialog(parent ?? undefined as never, {
        title: "Alle Skills exportieren",
        defaultPath: `ava-skills-${today}.zip`,
        filters: [{ name: "Skill-Paket", extensions: ["zip"] }],
      });
      if (res.canceled || !res.filePath) {
        return { ok: false, cancelled: true };
      }
      return exportAllSkillsToZipFile(all, res.filePath);
    },
  );

  ipcMain.handle(
    "skills:importZip",
    async (_e, localPath: string): Promise<SkillImportResult> => {
      if (typeof localPath !== "string" || !localPath) {
        return { ok: false, error: "skills:importZip erwartet einen Dateipfad" };
      }
      try {
        return await stageImportZip(localPath, {
          userSkillsDir: join(app.getPath("userData"), "skills"),
          trustStore: skillsTrust,
        });
      } catch (err) {
        return {
          ok: false,
          error: err instanceof Error ? err.message : String(err),
        };
      }
    },
  );

  ipcMain.handle(
    "skills:importMarkdown",
    async (_e, body: string): Promise<SkillImportResult> => {
      if (typeof body !== "string") {
        return {
          ok: false,
          error: "skills:importMarkdown erwartet einen Body-String",
        };
      }
      try {
        return await stageImportMarkdown(body, {
          userSkillsDir: join(app.getPath("userData"), "skills"),
          trustStore: skillsTrust,
        });
      } catch (err) {
        return {
          ok: false,
          error: err instanceof Error ? err.message : String(err),
        };
      }
    },
  );

  ipcMain.handle(
    "skills:commitImport",
    async (
      _e,
      payload: SkillImportCommit,
    ): Promise<SkillImportCommitResult> => {
      if (!payload || typeof payload !== "object") {
        return {
          ok: false,
          error: "skills:commitImport erwartet ein Payload-Objekt",
        };
      }
      const res = commitImport(payload, {
        userSkillsDir: join(app.getPath("userData"), "skills"),
        trustStore: skillsTrust,
      });
      if (skillStore && res.ok) {
        await skillStore.reload().catch(() => {});
      }
      return res;
    },
  );

  ipcMain.handle(
    "skills:cancelImport",
    (_e, stagingId: string): void => {
      if (typeof stagingId === "string" && stagingId) {
        discardImportStaging(stagingId);
      }
    },
  );

  /** Open-file dialog wrapper so the renderer can stay browser-shaped
   *  and not need raw fs paths. Returns the path on accept, null on
   *  cancel. Filters to .zip and .md so the user can't pick noise. */
  ipcMain.handle(
    "skills:pickImportFile",
    async (): Promise<{ path: string } | { cancelled: true }> => {
      const parent = focusedWindow();
      const res = await dialog.showOpenDialog(parent ?? undefined as never, {
        title: "Skill-Paket importieren",
        properties: ["openFile"],
        filters: [
          { name: "Skill-Paket", extensions: ["zip", "md"] },
          { name: "Alle Dateien", extensions: ["*"] },
        ],
      });
      if (res.canceled || res.filePaths.length === 0) {
        return { cancelled: true };
      }
      return { path: res.filePaths[0]! };
    },
  );

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
  // v0.1.155 — diagnostics for silent OTA failures. The renderer's
  // Settings panel calls getDiagnostics when the user clicks
  // "Update-Logs zeigen" and dismissSilentFailure when they
  // acknowledge the banner.
  ipcMain.handle("updater:getDiagnostics", () => updater.getDiagnostics());
  ipcMain.handle("updater:dismissSilentFailure", () =>
    updater.dismissSilentFailure(),
  );

  // Producer supervisors (8.v1.1). Renderer reads the snapshot list
  // on mount and subscribes to `producer-status:changed` for diffs.
  ipcMain.handle("producers:list", () =>
    producers.map((p) => p.getStatus()),
  );

  // Producer log streaming. The Logs tab in the matrix drill-down
  // panel calls tail() on open (backfill) then subscribes to
  // `producer-log:line` for the live tail. See producer-log-buffer.ts
  // for the ring-buffer semantics.
  ipcMain.handle(
    "producers:logs:tail",
    (_e, args: { producer: string; limit?: number }) =>
      producerLogBuffer.tail(args.producer, args.limit ?? 500),
  );
  // v0.1.163 — on-disk log file path per producer so renderer / chat
  // tools can point the user at the file for `tail -f` from Terminal.
  ipcMain.handle(
    "producers:logs:filePath",
    (_e, args: { producer: string }) =>
      producerLogBuffer.filePath(args.producer),
  );
  producerLogBuffer.on("line", (event: ProducerLogEvent) => {
    for (const win of BrowserWindow.getAllWindows()) {
      win.webContents.send("producer-log:line", event);
    }
    // v0.1.56 — fast-path "upstream is down" detection. The scheduled
    // 15-min HEAD probe is a slow recovery signal; producers that
    // actually hit unternehmensregister.de during a scrape see
    // ECONNRESET/ETIMEDOUT first. Pattern-match their log lines to
    // flip the monitor state immediately so the banner + auto-pause
    // fire without users having to wait.
    if (
      event.line.stream === "stderr" &&
      UNTERNEHMENSREGISTER_DEPENDENT_PRODUCERS.has(event.producer) &&
      UPSTREAM_FAILURE_PATTERNS.some((re) => re.test(event.line.text))
    ) {
      // v0.1.105 Session B — structured-content may now be scraping
      // handelsregister.de. Use the log line prefix it emits to
      // attribute the failure correctly. company-publication still
      // only hits unternehmensregister.
      const hitsHandelsregister =
        event.producer === "structured-content" &&
        event.line.text.includes("[handelsregister]");
      externalServiceMonitor.reportUnreachable(
        hitsHandelsregister ? "handelsregister" : "unternehmensregister",
        `${event.producer}: ${event.line.text.slice(0, 200)}`,
      );
    }
  });

  // Producer screenshots. The Screenshots tab calls list() with
  // (producer, runId) where runId = `${transactionId}:${companyId}`,
  // matches the on-disk dir created by each producer's screenshot
  // util. The custom `ava-screenshot://` protocol (registered before
  // app.whenReady) serves the actual PNG bytes.
  ipcMain.handle(
    "producers:screenshots:list",
    (_e, args: { producer: string; runId: string }) =>
      listScreenshots(args.producer, args.runId),
  );

  // v0.1.52 — external-service status (today: only
  // unternehmensregister.de). Renderer reads on mount + subscribes
  // to `external-service-status:changed` for transition pushes
  // (state changes, not every probe). The banner under the topbar
  // surfaces the unreachable state and explains which stages are
  // paused so users aren't confused by stuck-pending cells.
  ipcMain.handle("external-service:getStatus", () =>
    externalServiceMonitor.getStatus(),
  );
  ipcMain.handle("external-service:probeNow", () =>
    externalServiceMonitor.probeNow(),
  );

  // v0.1.54 — CRM connection manager. Drive OAuth connect/disconnect
  // for the supported CRMs (Salesforce / HubSpot / Dynamics). Status
  // pushes via `crm-status:changed`.
  ipcMain.handle("crm:list", (): CrmStatus[] => crmManager.getAllStatuses());
  ipcMain.handle(
    "crm:getStatus",
    (_e, provider: CrmProvider): CrmStatus => crmManager.getStatus(provider),
  );
  ipcMain.handle(
    "crm:connect",
    async (_e, args: { provider: CrmProvider; orgUrl?: string }) => {
      await crmManager.connect(args.provider, { orgUrl: args.orgUrl });
      return crmManager.getStatus(args.provider);
    },
  );
  ipcMain.handle(
    "crm:disconnect",
    async (_e, provider: CrmProvider): Promise<CrmStatus> => {
      await crmManager.disconnect(provider);
      return crmManager.getStatus(provider);
    },
  );
  // v0.1.153 — see CrmManager.getExternalUrl rationale.
  ipcMain.handle(
    "crm:getExternalUrl",
    (
      _e,
      args: { provider: CrmProvider; externalId: string },
    ): Promise<string | null> =>
      crmManager.getExternalUrl(args.provider, args.externalId),
  );

  // Workstream C4 — CRM linkage UI surface.
  //
  // `crm:list:links`    → thin pass-through over GET /v1/companies/:id/crm
  // `crm:details:fetch` → thin pass-through over GET /v1/companies/:id/crm/details
  // `crm:enrich:run`    → on-device HubSpot fetch + POST to /crm/cache
  // `crm:hubspot:searchCompanies` / `crm:linkManually` → manual-link picker.
  ipcMain.handle(
    "crm:list:links",
    async (
      _e,
      args: { companyId: string },
    ): Promise<unknown> => {
      const bearer = await auth.getAccessToken();
      if (!bearer) throw new Error("nicht angemeldet");
      const url = `${GATEWAY_URL.replace(/\/+$/, "")}/v1/companies/${encodeURIComponent(args.companyId)}/crm`;
      const res = await fetch(url, {
        headers: { authorization: `Bearer ${bearer}` },
      });
      if (!res.ok) {
        const body = await res.text().catch(() => "");
        throw new Error(`gateway ${res.status} ${body.slice(0, 200)}`);
      }
      return res.json();
    },
  );
  ipcMain.handle(
    "crm:details:fetch",
    async (
      _e,
      args: { companyId: string; refresh?: boolean },
    ): Promise<unknown> => {
      const bearer = await auth.getAccessToken();
      if (!bearer) throw new Error("nicht angemeldet");
      const qs = args.refresh ? "?refresh=true" : "?refresh=false";
      const url = `${GATEWAY_URL.replace(/\/+$/, "")}/v1/companies/${encodeURIComponent(args.companyId)}/crm/details${qs}`;
      const res = await fetch(url, {
        headers: { authorization: `Bearer ${bearer}` },
      });
      if (!res.ok) {
        const body = await res.text().catch(() => "");
        throw new Error(`gateway ${res.status} ${body.slice(0, 200)}`);
      }
      return res.json();
    },
  );
  ipcMain.handle(
    "crm:enrich:run",
    async (
      _e,
      args: {
        companyId: string;
        crmExternalId: string;
        crmType?: CrmProvider;
      },
    ) => {
      return runCrmEnrichment(crmManager, args, {
        gatewayUrl: GATEWAY_URL,
        getBearer: () => auth.getAccessToken(),
      });
    },
  );
  ipcMain.handle(
    "crm:hubspot:searchCompanies",
    async (_e, args: { query: string; limit?: number }) => {
      try {
        return await searchHubspotCompanies(crmManager, args);
      } catch (err) {
        return {
          items: [],
          error: err instanceof Error ? err.message : String(err),
        };
      }
    },
  );
  ipcMain.handle(
    "crm:linkManually",
    async (
      _e,
      args: {
        companyId: string;
        crmType: "HUBSPOT" | "SALESFORCE" | "DYNAMICS";
        crmExternalId: string;
        crmDisplayName?: string | null;
      },
    ): Promise<{ ok: true } | { ok: false; error: string }> => {
      const bearer = await auth.getAccessToken();
      if (!bearer) return { ok: false, error: "nicht angemeldet" };
      const url = `${GATEWAY_URL.replace(/\/+$/, "")}/v1/companies/${encodeURIComponent(args.companyId)}/crm/links`;
      const res = await fetch(url, {
        method: "POST",
        headers: {
          authorization: `Bearer ${bearer}`,
          "content-type": "application/json",
        },
        body: JSON.stringify({
          crmType: args.crmType,
          crmExternalId: args.crmExternalId,
          crmDisplayName: args.crmDisplayName ?? null,
        }),
      });
      if (!res.ok) {
        const body = await res.text().catch(() => "");
        return {
          ok: false,
          error: `gateway ${res.status} ${body.slice(0, 200)}`,
        };
      }
      return { ok: true };
    },
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
    async (_e, args: { kind: HostedProviderKind; apiKey: string }) => {
      // v0.1.209 — setApiKey ist async geworden, weil bei Anthropic
      // ein Tier-Detection-Call drangehängt wird. IPC handler awaitet,
      // damit der Renderer's invalidateQueries danach den frischen
      // TierInfo direkt sieht (kein Flackern, kein zweiter Roundtrip).
      await providers.setApiKey(args.kind, args.apiKey);
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

  // ---- Phase A1 — Anthropic subscription auth ---------------------------
  ipcMain.handle(
    "agent:setAnthropicSubscriptionToken",
    (_e, args: { token: string }) => {
      providers.setAnthropicSubscriptionToken(args.token);
    },
  );
  ipcMain.handle(
    "agent:validateAnthropicSubscriptionToken",
    (_e, args: { token: string }) =>
      providers.validateAnthropicSubscriptionToken(args.token),
  );
  ipcMain.handle("agent:clearAnthropicSubscriptionToken", () => {
    providers.clearAnthropicSubscriptionToken();
  });
  ipcMain.handle(
    "agent:setAnthropicAuthMode",
    (_e, args: { mode: "api-key" | "subscription" }) =>
      providers.setAnthropicAuthMode(args.mode),
  );

  // Phase A6 — In-App-OAuth-Flow. Öffnet das Anthropic-Login in einem
  // dedizierten Electron-Fenster, fängt den Redirect ab, tauscht Code
  // gegen Access-Token und persistiert ihn über die bestehende
  // Subscription-Token-Pipeline. Renderer bekommt nur `{ ok, error? }`
  // — der Token verlässt den Main-Process nicht.
  // ---- v0.1.172 Settings Phase A — Research Features --------------------
  // Per-feature config + key registry for the website producer's two
  // research pipelines (Deep Research / Tenders+Expansion, Job-Postings).
  // See src/main/research/store.ts for the persistence layout.
  const researchStore = ResearchFeaturesStore.shared();

  function researchBundle() {
    const pcs = ProviderConfigStore.shared();
    return {
      config: researchStore.getConfig(),
      keys: researchStore.listKeys(),
      globals: {
        openai: pcs.hasKey("openai"),
        anthropic: pcs.hasKey("anthropic"),
      },
      encryptionAvailable: pcs.isEncryptionAvailable(),
    };
  }

  ipcMain.handle("research:getBundle", () => researchBundle());

  ipcMain.handle(
    "research:setFeatureConfig",
    (_e, args: {
      feature: "expansionTenders" | "jobPostings";
      partial: {
        tier?: "off" | "standard" | "deep";
        provider?: "openai" | "anthropic" | null;
        keyId?: string | null;
      };
    }) => {
      researchStore.setFeatureConfig(args.feature, args.partial);
      return researchBundle();
    },
  );

  ipcMain.handle(
    "research:createKey",
    (_e, args: { provider: "openai" | "anthropic"; label: string; plaintext: string }) => {
      const id = researchStore.createKey(args);
      return { id, bundle: researchBundle() };
    },
  );

  ipcMain.handle("research:deleteKey", (_e, args: { keyId: string }) => {
    const { detachedFeatures } = researchStore.deleteKey(args.keyId);
    return { detachedFeatures, bundle: researchBundle() };
  });

  // Probe handler (Phase G) — does a 1-token round-trip against the
  // provider so we can give green/red feedback in the Settings UI.
  // Plaintext key never leaves this process.
  ipcMain.handle(
    "research:probeKey",
    async (_e, args: { keyId: string }): Promise<{
      ok: boolean;
      latencyMs?: number;
      error?: string;
    }> => {
      const plaintext = await researchStore.__getPlaintextKeyForProbe(args.keyId);
      if (!plaintext) {
        return { ok: false, error: "Key not found or undecryptable" };
      }
      // Provider deduction: global:* aliases are obvious; for uuid we
      // need to read the meta.
      const allKeys = researchStore.listKeys();
      let provider: "openai" | "anthropic" | null = null;
      if (args.keyId === "global:openai") provider = "openai";
      else if (args.keyId === "global:anthropic") provider = "anthropic";
      else provider = allKeys.find((k) => k.id === args.keyId)?.provider ?? null;

      if (!provider) {
        return { ok: false, error: "Unknown provider for keyId" };
      }

      const t0 = Date.now();
      try {
        if (provider === "openai") {
          // /v1/models is the cheapest authenticated endpoint -- list of
          // available models, ~$0 cost. Verifies the key works.
          const resp = await fetch("https://api.openai.com/v1/models", {
            headers: { authorization: `Bearer ${plaintext}` },
          });
          if (!resp.ok) {
            const txt = (await resp.text()).slice(0, 200);
            researchStore.markProbeResult(args.keyId, false);
            return { ok: false, error: `OpenAI ${resp.status}: ${txt}` };
          }
        } else {
          // Anthropic has no "list models" endpoint without consuming
          // credits. A 1-token ping with max_tokens=1 is the minimum
          // viable probe (costs ~$0.0001).
          const resp = await fetch("https://api.anthropic.com/v1/messages", {
            method: "POST",
            headers: {
              "content-type": "application/json",
              "x-api-key": plaintext,
              "anthropic-version": "2023-06-01",
            },
            body: JSON.stringify({
              model: "claude-haiku-4-5",
              max_tokens: 1,
              messages: [{ role: "user", content: "hi" }],
            }),
          });
          if (!resp.ok) {
            const txt = (await resp.text()).slice(0, 200);
            researchStore.markProbeResult(args.keyId, false);
            return { ok: false, error: `Anthropic ${resp.status}: ${txt}` };
          }
        }
        const latencyMs = Date.now() - t0;
        researchStore.markProbeResult(args.keyId, true);
        return { ok: true, latencyMs };
      } catch (err) {
        researchStore.markProbeResult(args.keyId, false);
        return { ok: false, error: err instanceof Error ? err.message : String(err) };
      }
    },
  );

  // v0.1.179 — Pre-import skip-mode IPCs. The renderer (or chat-tool)
  // calls these around an import POST so the user can opt out of
  // expensive research features for that batch without permanently
  // toggling them off.
  //
  // Flow:
  //   1. research:beginSkipMode      → snapshot + flip to off
  //   2. research:waitWebsiteReady   → block until producer reboots
  //   3. (caller does the import POST, captures transactionId)
  //   4. research:attachSkipToTransaction(snap, tx)
  //   5. (TransactionStream observes completion)
  //   6. research:endSkipModeForTransaction(tx) → restore snapshot
  //
  // If anything between 2 and 6 fails, the user's saved config stays
  // at off -- fail-safe to not-spending. They can re-enable in
  // Settings.
  ipcMain.handle("research:beginSkipMode", () => {
    return { snapshotKey: researchStore.beginSkipMode() };
  });

  ipcMain.handle(
    "research:waitWebsiteReady",
    async (_e, args?: { timeoutMs?: number }) => {
      const timeoutMs = args?.timeoutMs ?? 30_000;
      const website = producers.find((p) => p.getStatus().name === "website");
      if (!website) {
        return { ready: false, reason: "website producer not registered" };
      }
      const deadline = Date.now() + timeoutMs;
      while (Date.now() < deadline) {
        const s = website.getStatus().state;
        if (s === "ready") return { ready: true };
        if (s === "error") {
          return {
            ready: false,
            reason: website.getStatus().errorMessage ?? "producer in error state",
          };
        }
        // Poll every 250ms — tight enough for the typical 5-15s
        // restart cycle, loose enough to not burn CPU.
        await new Promise((r) => setTimeout(r, 250));
      }
      return { ready: false, reason: `timeout after ${timeoutMs}ms` };
    },
  );

  ipcMain.handle(
    "research:attachSkipToTransaction",
    (_e, args: { snapshotKey: string; transactionId: string }) => {
      return {
        ok: researchStore.attachSkipSnapshotToTransaction(
          args.snapshotKey,
          args.transactionId,
        ),
      };
    },
  );

  ipcMain.handle(
    "research:endSkipModeForTransaction",
    (_e, args: { transactionId: string }) => {
      return { ok: researchStore.endSkipModeForTransaction(args.transactionId) };
    },
  );

  ipcMain.handle("research:hasPendingSkipMode", () => {
    return { pending: researchStore.hasPendingSkipMode() };
  });

  // Push bundle updates to all renderer windows when config/keys change.
  // Keeps Settings UI live-synced if another window (or future CLI tool)
  // mutates it.
  const broadcastResearchBundle = () => {
    const bundle = researchBundle();
    for (const win of BrowserWindow.getAllWindows()) {
      win.webContents.send("research:bundleChanged", bundle);
    }
  };
  researchStore.on("configChanged", broadcastResearchBundle);
  researchStore.on("keysChanged", broadcastResearchBundle);

  // v0.1.172 Phase D — Restart-on-Change. When the user mutates a
  // research feature in Settings, the website producer needs to
  // re-spawn so its `extraEnvAsync` callback picks up the fresh
  // RESEARCH_* env vars. We only cycle on configChanged (not
  // keysChanged) because key probes / metadata writes don't affect
  // what the supervisor sends to the producer; only the per-feature
  // {tier, provider, keyId} triple does.
  //
  // Coalesce rapid edits (e.g. user typing in a key field that
  // auto-saves) into a single restart by debouncing 500ms.
  let researchRestartTimer: NodeJS.Timeout | null = null;
  researchStore.on("configChanged", () => {
    if (researchRestartTimer) clearTimeout(researchRestartTimer);
    researchRestartTimer = setTimeout(() => {
      researchRestartTimer = null;
      const website = producers.find((p) => p.getStatus().name === "website");
      if (!website) return;
      const s = website.getStatus().state;
      if (s === "idle" || s === "stopping") return;
      console.info(
        "[research-store] config changed — cycling website producer to pick up new RESEARCH_* env",
      );
      void (async () => {
        try {
          await website.stop();
        } catch (err) {
          console.warn("[research-store] website.stop() rejected:", err);
        }
        if (!auth.getStatus().signedIn) return;
        try {
          await website.start();
        } catch (err) {
          console.error("[research-store] website.start() rejected after restart:", err);
        }
      })();
    }, 500);
  });

  ipcMain.handle(
    "agent:connectAnthropicSubscription",
    async (event): Promise<{ ok: true } | { ok: false; error: string }> => {
      try {
        const parent =
          BrowserWindow.fromWebContents(event.sender) ??
          BrowserWindow.getFocusedWindow() ??
          BrowserWindow.getAllWindows()[0] ??
          null;
        const { runAnthropicOAuth } = await import(
          "./auth/anthropic-oauth-flow"
        );
        const token = await runAnthropicOAuth({ parent });
        // v0.1.181 — save the full record (access + refresh +
        // expires_in) so the background refresher can keep the
        // access_token fresh without user interaction. Falls back
        // to plain-token behavior if the server didn't return
        // refresh_token / expires_in.
        providers.setAnthropicSubscriptionRecord({
          accessToken: token.accessToken,
          refreshToken: token.refreshToken,
          expiresIn: token.expiresIn,
        });
        try {
          providers.setProvider("anthropic");
        } catch {
          // Falls der Manager nicht switchen kann (z. B. weil eine
          // andere Pre-Condition fehlt), bleibt der Token gespeichert
          // und der Auth-Modus auf "subscription" — das reicht für die
          // Settings-Karte, die danach „Verbunden" zeigt.
        }
        return { ok: true };
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        return { ok: false, error: message };
      }
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
  // v0.1.151 — still-open choice/text prompts for a conversation.
  // The renderer calls this on mount / conversation switch to re-paint
  // any prompt cards whose original stream frame was missed (Chat
  // wasn't mounted, or the user navigated away mid-prompt).
  ipcMain.handle("agent:getPendingPrompts", (_e, conversationId: string) =>
    agent.getPendingPrompts(conversationId),
  );
  ipcMain.handle("agent:loadConversation", (_e, conversationId: string) =>
    memory.load(conversationId),
  );
  ipcMain.handle("agent:deleteConversation", (_e, conversationId: string) =>
    memory.delete(conversationId),
  );
  // v0.1.85 — full-text search across every conversation file. Boring
  // case-insensitive AND across whitespace-split terms, capped at
  // limit/perChat. User + assistant only.
  ipcMain.handle(
    "agent:searchConversations",
    (_e, args: { query: string; limit?: number; perChat?: number }) =>
      memory.search(args.query, { limit: args.limit, perChat: args.perChat }),
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
  // v0.1.160 — scheduling status (next-scheduled / running / cadence).
  // The Settings panel renders "nächster Sweep planmäßig HH:MM" from
  // this so users can see the scheduler is alive even before the
  // first tick has produced a history entry.
  ipcMain.handle("alerts:heartbeatStatus", () => heartbeat.getStatus());

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

  // v0.1.200 — Audit-Trail IPC.
  //
  // Renderer calls (audit:list) → query the local PGlite-backed
  // store. Audit-store auto-starts on first append; the list
  // handler also triggers start() so a fresh install with zero
  // events still answers with an empty page rather than a
  // not-started error.
  //
  // Live-tail is the `audit:inserted` event broadcast we wire on
  // the store's "inserted" emit (see above near auditStore
  // construction); the renderer subscribes via ipcRenderer.on.
  ipcMain.handle("audit:list", async (_e, query) => {
    return auditStore.list(query ?? {});
  });
  ipcMain.handle("audit:purgeAll", async () => {
    const removed = await auditStore.purgeAll();
    audit({
      actorType: "user",
      actorId: null,
      category: "auth", // closest match — destructive op
      action: "audit.purge.all",
      severity: "warning",
      subjectType: null,
      subjectId: null,
      summary: `Audit-Trail manuell geleert (${removed} Einträge entfernt)`,
      metadata: { removed },
    });
    return { removed };
  });
  // Retention sweep: once on app start, then every 24 h. The store
  // lazy-loads on first call so we don't pay startup cost when the
  // user never opens the Verlauf-Tab.
  const RETENTION_INTERVAL_MS = 24 * 60 * 60 * 1000;
  void auditStore
    .purgeExpired()
    .then((n) => {
      if (n > 0)
        console.info(`[audit] startup retention sweep removed ${n} expired event(s)`);
    })
    .catch((err) =>
      console.warn("[audit] startup retention sweep failed:", err),
    );
  if (auditPurgeTimer) clearInterval(auditPurgeTimer);
  auditPurgeTimer = setInterval(() => {
    void auditStore
      .purgeExpired()
      .then((n) => {
        if (n > 0)
          console.info(`[audit] daily retention sweep removed ${n} expired event(s)`);
      })
      .catch((err) =>
        console.warn("[audit] daily retention sweep failed:", err),
      );
  }, RETENTION_INTERVAL_MS);

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
        // Resume sweep for stages stuck in pending / in_progress from
        // a prior crash, update, or mid-pipeline app close. Fires
        // here for the silent-restore case (auth already signed-in
        // when producers spawn). The auth-status branch fires it
        // for the fresh-sign-in case. The one-shot guard inside
        // maybeRunResumeSweep keeps it to a single dispatch per
        // process. See producer-resume.ts for full rationale.
        if (process.env.AVA_DISABLE_PRODUCERS !== "1") {
          maybeRunResumeSweep();
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

  // Auto-retry ticker — same gating as the alert-judge heartbeat (the
  // tick is a no-op when prefs disable it, but starting the timer is
  // still cheap and we want a Settings flip to take effect without
  // waiting for an app restart).
  retryTicker.start();

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
  // v0.1.155 — start() became async because it reads a "previous-boot
  // install-attempted" marker before kicking the first check. We
  // intentionally fire-and-forget: the await would block the rest of
  // app.whenReady, and the marker read is best-effort.
  void updater.start();

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
  retryTicker.stop();
  agent.dispose();
  providers.dispose();
  updater.stop();
  externalServiceMonitor.stop();
  void ollama.stop();
  // Producers go down before Postgres so their final commits
  // succeed against the still-running PGlite instance.
  for (const p of producers) {
    void p.stop();
  }
  void postgres.stop();
});

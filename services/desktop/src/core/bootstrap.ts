// Komposition der AVA ohne Hülle (docs/PLAN_AVA_CLOUD.md §12, Schritt R2b).
//
// Hier entsteht alles, was AVA ausmacht: Stores, Supervisoren, Orchestrator,
// Workflows, Telegram, Mail, Producer. Die Datei kennt kein Electron; was die
// Hülle beisteuert (Fenster, Protokolle, Sitzungen, Beenden-Kette), läuft über
// die Plattform-Schicht (./platform) und die Hooks. Der Inhalt ist der
// bisherige Hauptprozess (src/main/index.ts) in Funktionsform; Reihenfolge und
// Kommentare sind erhalten, damit die Startsequenz unverändert bleibt.
//
// Aufrufer: src/main/index.ts (Electron) und später src/server/main.ts (Node).
//   const core = await bootstrapCore({ onResume });   // Komposition + stille Anmeldung
//   ... Hülle registriert IPC / Fenster ...
//   await core.startBackground();                      // Ollama, Postgres, Producer, Herzschlag, Worker-Modus

import { lifecycle, notifier, paths, platform, power, windows } from "./platform";
import { KopfRelais } from "./relais/kopf-relais";
import { PlanTokenServer } from "../main/auth/plan-token-server";
import { meldeAbgeleiteteAdressen } from "../main/contacts/email-muster/rueckmeldung";
import { radarActivity } from "../main/discovery/activity";
import { NutzerstandService } from "../main/suggestions/nutzerstand";
import { ChipErzeugung } from "../main/suggestions/erzeugung";
import { VorschlaegeSettingsStore } from "../main/suggestions/settings";
import { MithelfenSettingsStore, MithelfenSupervisor } from "../main/register-delta/supervisor";
import { HintergrundAufgaben, AUTO_WERKZEUGE, setzeAufgabenInstanz } from "../main/aufgaben/aufgaben";
import { workerModus } from "../main/worker-modus";
import { ChromeForTesting } from "../main/chrome-for-testing";
import { existsSync as existsSyncMain, rmSync as rmSyncMain, writeFileSync as writeFileSyncMain } from "node:fs";
import { ORG_FEATURES } from "../shared/types";
import { pruefeModellstufe } from "../main/workflows/modellstufe";
import { EmailMusterSupervisor } from "../main/contacts/email-muster/supervisor";
import { streamToText as hintergrundUrteil } from "../main/link-monitor/llm";
import { handleSignedIn as accountSpaceSignedIn, listAccounts, spaceDirFor, readIdentity } from "../main/account-space";
import { join } from "node:path";
import { markHeartbeatSuspend, quitStep, traceStep, writeLineSync } from "../main/file-logger";
import { Auth, type AuthStatus } from "../main/auth";
import { OllamaSupervisor } from "../main/ollama-supervisor";
import { OllamaBinaryUpdater } from "../main/ollama-binary-updater";
import { PostgresSupervisor } from "../main/postgres-supervisor";
import { ProducerSupervisor } from "../main/producer-supervisor";
import { processingControl } from "../main/processing-control";
import { resumeStuckStages, NeustartZaehler } from "../main/producer-resume";
import { resolveProducerDirUnder } from "../main/producer-dirs";
import { sweepManagedTemp } from "../main/temp-sweep";
import { beendeVerwaisteBrowser } from "../main/browser-sweep";
import {
  producerLogBuffer,
  type ProducerLogEvent,
} from "../main/producer-log-buffer";
import { pruneOldScreenshots } from "../main/producer-screenshots";
import {
  getDb as getLinkedInDb,
  heartbeatCandidates as listLinkedInHeartbeatCandidates,
  recordHeartbeatVerdict as recordLinkedInHeartbeatVerdict,
} from "../main/linkedin/db";
import { read as readLinkedInSettings } from "../main/linkedin/store";
import {
  ExternalServiceMonitor,
  UNTERNEHMENSREGISTER_DEPENDENT_PRODUCERS,
  UPSTREAM_FAILURE_PATTERNS,
  type ExternalServicesStatus,
} from "../main/external-service-monitor";
import { pickStructuredContentSource } from "../main/structured-content-source";
import { CrmManager } from "../main/crm";
import { setOrgQuotaExceededHandler } from "../main/agent/providers/ai-sdk-provider";
import { initOrganisation, onSignedIn as organisationSignedIn, checkTenantChange } from "../main/organisation";
import { featureEnabled, getOrgPolicy, onOrgPolicyChange } from "../main/org-policy";
import * as relevanz from "../main/relevanz";
import { fokusFirmen, faelligeNachfragen } from "../main/buying-center/fokus";
import { startScheduler as startLinkedInScheduler, stopScheduler as stopLinkedInScheduler } from "../main/linkedin/scheduler";
import { MailSupervisor } from "../main/mail/supervisor";
import { ScheduledJobsStore } from "../main/scheduler/store";
import { ScheduledJobsSupervisor } from "../main/scheduler/supervisor";
import { LinkMonitorStore } from "../main/link-monitor/store";
import { LinkMonitorSupervisor } from "../main/link-monitor/supervisor";
import { SelfCorrectionsStore } from "../main/agent/self-corrections-store";
import type { ScheduledMailSendPayload, ScheduledReminderPayload } from "../shared/types";
import { LINK_MONITOR_ACTIVE_CAP, type LinkMonitorSnapshot, type TelegramSnapshot } from "../shared/types";
import type { MailSnapshot } from "../shared/types";
import { ResearchFeaturesStore } from "../main/research/store";
import { SpracheStore } from "../main/sprache/store";
import { SpracheRelay } from "../main/sprache/relay";
import { ProviderConfigStore } from "../main/agent/providers/store";
import { initSkills, buildGateEvaluator, SkillsPrefsStore, SkillsTrustStore } from "../main/skills";
import type { SkillRow } from "../shared/types";
import type { CrmStatus } from "../main/crm/types";
import { scrubQuarantine, scrubWhisperBundle } from "../main/scrub-quarantine";
import { Updater, broadcastUpdateStatus } from "../main/updater";
import { AuditStore } from "../main/audit/audit-store";
import { UsageStore } from "../main/usage/usage-store";
import { performBootResetIfRequested } from "../main/reset-store";
import { TelegramStore } from "../main/telegram/store";
import { PublicationStore } from "../main/publication/store";
import { TelegramChannel } from "../main/telegram/channel";
import { TelegramInbound } from "../main/telegram/inbound";
import { KnowledgeProviderStore } from "../main/knowledge/store";
import { KnowledgeManager } from "../main/knowledge/manager";
import { estimateUsd } from "@ava/ai-provider";
import type { AuditEventInput } from "../main/audit/audit-types";
import {
  AgentOrchestrator,
  AlertPrefsStore,
  AutonomyStore,
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
  collectTenantCompanyIds,
} from "../main/agent";
import { NotificationManager } from "../main/notifications";
import { WhisperSidecar } from "../main/voice/whisper-sidecar";
import { IcpStore } from "../main/agent/icp-store";
import { MatchStore } from "../main/discovery/match-store";
import { CustomerProfileStore } from "../main/discovery/customer-profiles";
import { RadarSupervisor } from "../main/discovery/radar-supervisor";
import { RadarAlertEmitter, policyForTier } from "../main/discovery/radar-alerts";
import { runMatch } from "../main/discovery/matcher";
import { ProfileWorker } from "../main/discovery/profile-worker";
import { WatchlistKeyStore } from "../main/linkedin/watchlist/key-store";
import { WatchlistStore } from "../main/linkedin/watchlist/store";
import { WorkflowService } from "../main/workflows";
import { TransactionWatcher } from "../main/transaction-watcher";
import { StatusWatcher } from "../main/status-watcher";
import type { WorkflowProgressFrame } from "../shared/workflow-types";
import { WatchlistSupervisor } from "../main/linkedin/watchlist/supervisor";
import { PersonenRadarStore } from "../main/linkedin/personen-radar/store";
import { PersonenRadarSupervisor } from "../main/linkedin/personen-radar/supervisor";
import type { LlmProviderKind } from "../main/agent";
import type { AgentStatus, AgentStreamFrame, Alert, AlertPrefs, AlertTickInfo, OllamaPullProgress, OllamaStatus, PostgresStatus, ProducerStatus, UpdateStatus, VoiceModelDownloadProgress, VoiceStatus } from "../shared/types";
import { resolveConfig } from "../shared/config";

export interface BootstrapHooks {
  /** Nach dem Aufwachen, sobald die Dienste wieder laufen: die Hülle weckt ihre Fenster. */
  onResume?: () => void;
}

export async function bootstrapCore(hooks: BootstrapHooks = {}) {
  // Plattform-Schicht zuerst: Stores lesen ihre Pfade schon beim Laden (docs/PLAN_AVA_CLOUD.md §12).

  /** Pfad des Worker-Modus-Merkers; im Start gesetzt (siehe dort). */
  let workerModusMerkerPfad: string | null = null;

  function workerModusMerkerSetzen(): void {
    if (!workerModusMerkerPfad) return;
    try {
      writeFileSyncMain(workerModusMerkerPfad, new Date().toISOString(), "utf8");
    } catch {
      /* ohne Merker weiter, nur ohne Netz */
    }
  }

  function workerModusMerkerLoeschen(): void {
    if (!workerModusMerkerPfad) return;
    try {
      rmSyncMain(workerModusMerkerPfad, { force: true });
    } catch {
      /* egal */
    }
  }
  // Side-effect import — MUST be first. Installs the persistent file logger
  // (mirrors every main-process console.* + uncaught errors into a rotated
  // file under ~/Library/Logs/AVA/) before any other module loads or logs.
  // Captures boot AND the post-wake `[power] resume` / updater path even on
  // a normal Finder/Dock launch, where stdout is otherwise discarded.
  // T1 — Account-Space VOR allen Stores waehlen (siehe account-space.ts).
  // v0.1.200 — Audit-Trail. Local-first PGlite store, see audit-store.ts.
  // v0.1.224 — Knowledge-Integrations-Framework (Phase 1). Konkrete
  // Adapter (Notion, Obsidian) folgen in P2/P3.

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

  const APP_CONFIG = resolveConfig({
    appVersion: paths().version(),
    isPackaged: paths().isPackaged,
  });
  const GATEWAY_URL = APP_CONFIG.gatewayUrl;
  const AUTH_ISSUER = APP_CONFIG.authIssuer;
  const AUTH_CLIENT_ID = APP_CONFIG.authClientId;

  // v0.1.409 — Ausstehenden „Werksreset außer Modelle" GANZ FRÜH ausführen —
  // beim Modul-Load, BEVOR die Store-Singletons (memory, usage, …) unten
  // konstruiert werden und ihre Verzeichnisse anlegen. Liefe der Reset erst
  // in app.whenReady(), würde er die von den Stores bereits (beim Import)
  // angelegten Verzeichnisse — v. a. agent/memory — wieder löschen, ohne dass
  // sie in derselben Session neu entstehen → jeder Chat-Schreibvorgang würde
  // mit ENOENT scheitern. `paths().get("userData")` ist hier bereits gültig.
  try {
    performBootResetIfRequested();
  } catch (err) {
    console.warn("[reset] boot reset failed:", err);
  }


  const auth = new Auth(AUTH_ISSUER, AUTH_CLIENT_ID, GATEWAY_URL);

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
    void resumeStuckStages({ gateway: gatewayClient, neustartZaehler: neustartZaehler() }).catch((err) => {
      console.warn(
        "[producer-resume] sweep rejected:",
        err instanceof Error ? err.message : err,
      );
    });
  }

  // v0.1.218 — Periodischer Resume-Sweep, läuft alle 15 Min. solange
  // die App offen ist + ein Nutzer angemeldet ist. Vorher nur einmal
  // beim Boot — wenn ein Producer mid-Session crashte und in_progress
  // hängen blieb, bekam der Nutzer den Stuck-Status erst beim
  // nächsten App-Neustart frei. Der 60s-recent-update-Guard in
  // `resumeStuckStages` verhindert Doppel-Trigger laufender Stages.
  //
  // 15 Min. Intervall ist Kompromiss: lang genug, dass typische
  // Producer-Stage-Laufzeiten (Sekunden bis ~5 Min.) durch sind und
  // kein False-Positive feuert; kurz genug, dass ein Crash maximal
  // 15 Min. „stuck-Pille" auf der Matrix sichtbar bleibt.
  const PERIODIC_RESUME_INTERVAL_MS = 15 * 60 * 1000;
  // Begrenzung automatischer Neuanstoesse je Schritt (docs/PLAN_HINTERGRUNDAUFGABEN.md, Stufe 2).
  let neustartZaehlerInstanz: NeustartZaehler | null = null;
  function neustartZaehler(): NeustartZaehler {
    neustartZaehlerInstanz ??= new NeustartZaehler(join(paths().get("userData"), "auto-neustarts.json"));
    return neustartZaehlerInstanz;
  }
  let periodicResumeTimer: NodeJS.Timeout | null = null;
  function startPeriodicResumeSweep(): void {
    if (periodicResumeTimer) return;
    periodicResumeTimer = setInterval(() => {
      if (!auth.getStatus().signedIn) return;
      void resumeStuckStages({
        gateway: gatewayClient,
        neustartZaehler: neustartZaehler(),
        // v0.1.360 — verklemmte Producer (lange in_progress) neu starten,
        // damit ein frischer AMQP-Consumer das re-dispatchte Event abholt.
        // Behebt „Pipeline komplett eingefroren". Nur im periodischen Sweep
        // (beim Boot starten die Producer ohnehin frisch).
        restartProducer: async (name: string) => {
          const sup = producers.find((p) => p.getStatus().name === name);
          if (!sup) return;
          await sup.stop();
          await sup.start();
        },
      }).catch((err) => {
        console.warn(
          "[producer-resume] periodic sweep rejected:",
          err instanceof Error ? err.message : err,
        );
      });
    }, PERIODIC_RESUME_INTERVAL_MS);
  }
  function stopPeriodicResumeSweep(): void {
    if (periodicResumeTimer) {
      clearInterval(periodicResumeTimer);
      periodicResumeTimer = null;
    }
  }

  function broadcastAuthStatus(status: AuthStatus): void {
    windows().broadcast("auth-status:changed", status);
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
    if (status.signedIn && !processingControl.isPaused() && !workerModus.aktiv()) {
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
      // v0.1.218 — danach läuft der Sweep alle 15 Min. weiter, damit
      // mid-Session-Crashes (STRUKTUR/PUBLIKATION Stage stuck in
      // in_progress) ohne App-Neustart frei werden.
      startPeriodicResumeSweep();
    } else {
      cachedCredentials = null;
      // Allow a future sign-in within the same process to re-run the
      // sweep — stages might have gotten stuck while signed out.
      resumeSweepDispatched = false;
      stopPeriodicResumeSweep();
      for (const p of producers) {
        void p.stop();
      }
    }
  }
  auth.on("status", broadcastAuthStatus);

  // v0.1.395 — Lokaler Verarbeitungs-Schalter. Pause → alle lokalen Producer
  // stoppen (kein Konsumieren mehr; laufender Schritt endet). Resume → die
  // reguläre Sign-in-Start-Logik erneut anstoßen (Producer laufen wieder an,
  // Reachability-Gating greift weiterhin). Renderer wird benachrichtigt.
  processingControl.on("changed", (paused: boolean) => {
    windows().broadcast("processing-control:changed", { paused });
    if (paused) {
      console.log("[processing-control] pausiert — stoppe alle Producer");
      for (const p of producers) void p.stop();
    } else {
      console.log("[processing-control] fortgesetzt — Producer neu starten");
      broadcastAuthStatus(auth.getStatus());
    }
  });

  // Ollama supervisor (D7). Started on app.whenReady, stopped on before-quit.
  // Disabled by setting AVA_DISABLE_OLLAMA=1 — used in CI / mock-gateway dev
  // where there's nothing to run locally.
  // Server: ein Ollama-Sidecar unter AVA_OLLAMA_HOST/AVA_OLLAMA_PORT wird übernommen
  // statt eine gebündelte Fassung zu starten (docs/PLAN_AVA_CLOUD.md §4.1).
  const ollama = new OllamaSupervisor({
    ...(process.env.AVA_OLLAMA_HOST ? { host: process.env.AVA_OLLAMA_HOST } : {}),
    ...(process.env.AVA_OLLAMA_PORT ? { port: Number(process.env.AVA_OLLAMA_PORT) } : {}),
  });
  // v0.1.220 — Runtime-Self-Update für die Ollama-Binary. Trennt das
  // Lifecycle des Supervisors (Subprozess hochfahren / Modelle pullen)
  // vom Binary-Update (Download neuer Ollama-Version in <userData>/
  // ollama-managed/). Supervisor liest die Binary-Pfad neu auf jedem
  // start(), darum genügt es, ihn nach erfolgreichem Update neu zu
  // starten — App-Restart nicht nötig.
  const ollamaUpdater = new OllamaBinaryUpdater();
  ollamaUpdater.on("state", (s) => {
    windows().broadcast("ollama-updater:state", s);
  });

  function broadcastOllamaStatus(status: OllamaStatus): void {
    windows().broadcast("ollama-status:changed", status);
  }
  function broadcastOllamaPullProgress(progress: OllamaPullProgress): void {
    windows().broadcast("ollama-pull:progress", progress);
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
    windows().broadcast("postgres-status:changed", status);
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

  /**
   * Eigener Browser fuer die Hintergrundverarbeitung (chrome-for-testing.ts).
   * Wird im Start eingerichtet; bis dahin null, dann greift der Browser der
   * Person wie bisher.
   */
  let eigenerBrowser: ChromeForTesting | null = null;
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
              // 2026-09-06 — Organisationsschluessel: unter Anbieter-Sperre
              // laeuft Research immer ueber den Gateway-Proxy; das Deep-
              // Research-Modell gibt die Organisation vor.
              const locked = providers.isProviderLocked();
              const pol = getOrgPolicy();
              if (pol.researchModel) env.RESEARCH_DEEP_MODEL = pol.researchModel;
              // docs/PLAN_CHATGPT_ABO_UEBERALL.md: ohne Schluessel laeuft die
              // Standard-Stufe ueber das ChatGPT-Abo (Deep braucht weiter einen Schluessel).
              const ueberAbo = providers.producerUeberAbo();
              const rcfg = store.getConfig();
              const expansion = await store.resolveFeature("expansionTenders", { providerLocked: locked });
              if (expansion) {
                env.RESEARCH_EXPANSION_TIER = expansion.tier;
                env.RESEARCH_EXPANSION_PROVIDER = expansion.provider;
                env.RESEARCH_EXPANSION_API_KEY = expansion.apiKey;
                if (expansion.viaGateway) env.RESEARCH_EXPANSION_VIA_GATEWAY = "1";
              } else if (ueberAbo && rcfg.expansionTenders.tier === "standard") {
                env.RESEARCH_EXPANSION_TIER = "standard";
                env.RESEARCH_EXPANSION_VIA_PLAN = "1";
              } else {
                env.RESEARCH_EXPANSION_TIER = "off";
              }
              const jobs = await store.resolveFeature("jobPostings", { providerLocked: locked });
              if (jobs) {
                env.RESEARCH_JOBS_TIER = jobs.tier;
                env.RESEARCH_JOBS_PROVIDER = jobs.provider;
                env.RESEARCH_JOBS_API_KEY = jobs.apiKey;
                if (jobs.viaGateway) env.RESEARCH_JOBS_VIA_GATEWAY = "1";
              } else if (ueberAbo && rcfg.jobPostings.tier === "standard") {
                env.RESEARCH_JOBS_TIER = "standard";
                env.RESEARCH_JOBS_VIA_PLAN = "1";
              } else {
                env.RESEARCH_JOBS_TIER = "off";
              }
              // 2026-09-24 — manueller Lauf je Firma: Schluessel IMMER mitgeben,
              // auch bei Stufe "Aus" (der Producer nimmt ihn nur fuer Laeufe
              // mit Stufe im Ereignis). Vorrang wie im Chat: eigener zuerst.
              const manuell = await store.resolveManuellOpenai({ providerLocked: locked });
              if (manuell?.viaGateway) env.RESEARCH_OPENAI_VIA_GATEWAY = "1";
              else if (manuell?.apiKey) env.RESEARCH_OPENAI_API_KEY = manuell.apiKey;
              // v0.1.270 — wenn das Haupt-LLM nicht OpenAI ist (also kein
              // OPENAI_API_KEY in llmConfig steckt), aber Research auf
              // OpenAI läuft, projizieren wir den ersten verfügbaren
              // Research-OpenAI-Key zusätzlich als OPENAI_API_KEY. Dadurch
              // wird im Producer das `openaiInstance` in di.ts non-null,
              // shared-Client-Reuse funktioniert und der Boot-Log meldet
              // keinen scheinbaren Fehler mehr. Außer producer-supervisor
              // setzt es schon aus dem Haupt-LLM (dann bleibt's so).
              const fallbackOpenaiKey =
                expansion && expansion.provider === "openai" && !expansion.viaGateway
                  ? expansion.apiKey
                  : jobs && jobs.provider === "openai" && !jobs.viaGateway
                    ? jobs.apiKey
                    : null;
              if (fallbackOpenaiKey) {
                env.OPENAI_API_KEY = fallbackOpenaiKey;
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
            : name === "company-contact"
              ? // §8b (v0.1.487) — Apify-BYOK-Token fuer den Firmenprofil-
                // Primaerweg. Gleicher Vertrauens-Weg wie OPENAI_API_KEY:
                // Main→Child-env beim Spawn (Renderer-IPC bleibt tabu).
                // Kein Token = leeres env, Producer faellt auf SERP zurueck.
                async (): Promise<Record<string, string>> => {
                  const apifyKey = watchlistKeyStore?.getKey();
                  // O3 — Organisationsvorgabe „Kontakt-Recherche aus": kein
                  // Apify-Token → keine Mitarbeiter-Suche im Producer.
                  if (!featureEnabled("kontakte")) return {};
                  // O5 — Organisations-Token bleibt im Gateway: Producer ruft
                  // /v1/proxy/apify mit dem Nutzer-JWT.
                  if (providers.apifyUeberOrganisation(Boolean(apifyKey))) {
                    return {
                      AVA_APIFY_VIA_GATEWAY: "1",
                      APIFY_COMPANY_FENSTER: String(watchlistKeyStore?.getConfig().companyWindow ?? 100),
                      APIFY_PROFIL_MODUS:
                        watchlistKeyStore?.getConfig().profilModus === "voll" ? "full" : "short",
                    };
                  }
                  if (!apifyKey) return {};
                  return {
                    APIFY_TOKEN: apifyKey,
                    APIFY_COMPANY_FENSTER: String(
                      watchlistKeyStore?.getConfig().companyWindow ?? 100,
                    ),
                    APIFY_PROFIL_MODUS:
                      watchlistKeyStore?.getConfig().profilModus === "voll" ? "full" : "short",
                  };
                }
            : name === "company-publication"
              ? // v0.1.424 — Analyse-Modus (PB1): "lazy" (Default) analysiert
                // nur trend-relevante Bloecke, "eager" jeden Block.
                // v0.1.426 — PB2b: Embedding-Env fuer die Block-Einbettung.
                // Die Bloecke gehen als Persist-Events ans Gateway (zentraler
                // Korpus fuer alle Nutzer); embeddet wird LOKAL beim
                // verarbeitenden Nutzer — embeddinggemma fuer alle identisch,
                // dieselbe Konsistenz-Entscheidung wie bei company-evaluation.
                async (): Promise<Record<string, string>> => ({
                  AVA_PUBLICATION_ANALYSIS: publicationStore.getMode(),
                  EMBED_PROVIDER: "ollama",
                  EMBED_MODEL: "embeddinggemma:latest",
                })
              : undefined;
    return new ProducerSupervisor({
      config: { name, entry, databaseName, port },
      // Eigener Browser statt der Chrome-Installation der Person, sobald eine
      // Fassung bereitliegt (docs/ANALYSE_CHROME_PROZESSE.md, L5).
      browserPfad: () => eigenerBrowser?.browserPfad() ?? null,
      treiberVerzeichnis: () => eigenerBrowser?.treiberVerzeichnis() ?? null,
      databaseUrl: makeDatabaseUrlGetter(name),
      amqpUrl: fetchAmqpUrl,
      jwksUri: `${APP_CONFIG.authIssuer}/protocol/openid-connect/certs`,
      llmConfig: () => providers.getProducerLlmEnv(),
      // ChatGPT-Abo: Producer holen den Token vom Loopback-Dienst des Mains.
      planTokenEndpunkt: () => planTokenServer.endpunkt(),
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
      // O3 — wirksamer Tenant aus dem whoami-Abgleich (identity.json), sonst
      // Token-Claim, sonst Nutzer-ID (persoenlicher Tenant).
      getTenantId: async () => {
        const st = auth.getStatus();
        return readIdentity()?.tenantId ?? st.tenantId ?? st.actorId ?? null;
      },
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

    for (const entry of PRODUCER_REGISTRY) {
      // v0.1.363 — short-dir layout `resources/p/<code>/` (Windows MAX_PATH
      // fix) with legacy `resources/producers/<name>/` fallback. See
      // producer-dirs.ts (same resolver the supervisor uses).
      const resourcesRoot = paths().isPackaged
        ? (paths().resources() ?? "")
        : join(paths().appPath(), "resources");
      const vendored = resolveProducerDirUnder(resourcesRoot, entry.name);
      if (vendored) {
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

  /** Register-Delta S6 — Stand der geteilten Job-Queue (GET /v1/register-jobs/status). */
  async function registerQueueStatus(): Promise<Record<string, unknown> | null> {
    try {
      const token = await auth.getAccessToken();
      if (!token) return null;
      const res = await fetch(`${GATEWAY_URL}/v1/register-jobs/status`, { headers: { authorization: `Bearer ${token}` } });
      if (!res.ok) return null;
      return (await res.json()) as Record<string, unknown>;
    } catch {
      return null;
    }
  }

  function broadcastProducerStatus(status: ProducerStatus): void {
    windows().broadcast("producer-status:changed", status);
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

  // v0.1.52 — pipe external-service status to (a) the renderer banner
  // and (b) producer auto-pause/resume. Only fires on transitions
  // (reachable ⇄ unreachable), not on every probe, so a stable
  // "down for an hour" doesn't churn the UI.
  function broadcastExternalServiceStatus(
    status: ExternalServicesStatus,
  ): void {
    windows().broadcast("external-service-status:changed", status);
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
        // v0.1.395 — Nutzer-Pause hat Vorrang: nicht wieder anlaufen lassen.
        // Im Worker-Modus laeuft ueberhaupt kein Producer.
        if (processingControl.isPaused() || workerModus.aktiv()) continue;
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
  // docs/PLAN_CHATGPT_ABO_UEBERALL.md (E1): Loopback-Token-Dienst fuer Producer.
  const planTokenServer = new PlanTokenServer(() => providers.planTokenFuerProducer());
  void planTokenServer.start().catch((err) => console.warn("[chatgpt-plan] Token-Dienst nicht gestartet:", err));

  // v0.1.466 — Plan-Tier-Cache (Radar-Staffelung). Synchron lesbar fuer
  // Alert-Politik + Automatik-Klammer; Refresh lazy alle 30 Minuten via
  // GET /v1/usage. null = noch unbekannt (Konsumenten fallen dann auf
  // ihr Legacy-Verhalten zurueck, nie auf kuenstliche Verknappung).
  let cachedTenantTier: "free" | "starter" | "pro" | "enterprise" | null = null;
  let tierFetchStartedAt = 0;
  function getTenantTierCached(): typeof cachedTenantTier {
    if (Date.now() - tierFetchStartedAt > 30 * 60_000) {
      tierFetchStartedAt = Date.now();
      void gatewayClient
        .request<{ tier?: string }>("/v1/usage")
        .then((u) => {
          if (
            u.tier === "free" ||
            u.tier === "starter" ||
            u.tier === "pro" ||
            u.tier === "enterprise"
          ) {
            cachedTenantTier = u.tier;
          }
        })
        .catch(() => {
          /* offline/ausgeloggt — letzter bekannter Wert bleibt */
        });
    }
    return cachedTenantTier;
  }

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
  // 2026-09-30: Ablage auf Platte, Handles ueberleben Neustarts (D1).
  const attachments = new AttachmentStore(join(paths().get("userData"), "anhaenge"));

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
  // v0.1.412 — Telegram als zusätzlicher Zustellkanal. Eigener Schalter +
  // eigener Schwellwert (unabhängig vom Desktop-Push), Queue mit Taktung und
  // Bündelung gegen Meldungswellen. Wird unten an den NotificationManager
  // gehängt, sodass alle vorhandenen Alert-Quellen automatisch mitspielen.
  const telegramStore = new TelegramStore();
  // v0.1.424 — Publikations-Analyse-Modus (lazy/eager) fuer den
  // company-publication-Producer.
  const publicationStore = new PublicationStore();
  const telegramChannel = new TelegramChannel({
    store: telegramStore,
    inQuietHours: () => notifications.isInQuietHours(),
    onDisabled: (grund) => {
      // Nutzer muss es sehen: sonst bleibt Telegram still, waehrend die Testnachricht weiter geht.
      const a = alerts.add({ tenantId: null, companyId: "", companyName: "Telegram", kind: "reminder", severity: "warn", headline: "Telegram-Zustellung abgeschaltet", rationale: `Telegram hat eine Meldung endgültig abgelehnt (${grund}). Der Kanal wurde abgeschaltet. Prüfe Bot-Token und Chat in den Einstellungen und schalte ihn wieder ein.`, sourceRef: `telegram:disabled:${Date.now()}` });
      if (a) broadcastAlertsChanged();
    },
    onAudit: ({ severity, summary, metadata }) => {
      audit({
        actorType: "system",
        actorId: null,
        category: "watch",
        action: "telegram.delivery",
        severity,
        subjectType: null,
        subjectId: null,
        summary,
        metadata,
      });
    },
    onPendingChanged: () => {
      void broadcastTelegramChanged();
    },
  });
  notifications.addChannel(telegramChannel);
  telegramStore.on("changed", () => {
    void broadcastTelegramChanged();
    telegramInbound?.sync();
  });
  // Beim Beenden die Zustell-Timer stoppen, damit kein Retry mehr feuert.
  lifecycle().onBeforeQuit(() => quitStep("telegramChannel.stop", () => telegramChannel.stop()));
  // Relevanz: was noch in der Warteschlange liegt, beim Beenden rausschicken.
  lifecycle().onBeforeQuit(() => quitStep("relevanz.beende", () => { void relevanz.beendeRelevanz(); }));
  // v0.1.417 — Gegenrichtung: Nachrichten aus dem Telegram-Chat lesen und
  // beantworten. Wird erst nach der Orchestrator-Konstruktion gesetzt
  // (siehe unten) und folgt danach der Konfiguration.
  let telegramInbound: TelegramInbound | null = null;
  function broadcastTelegramChanged(): void {
    const snapshot: TelegramSnapshot = {
      config: telegramStore.getConfig(),
      hasToken: telegramStore.hasToken(),
      encryptionAvailable: telegramStore.isEncryptionAvailable(),
      pendingCount: telegramChannel.pendingCount(),
    };
    windows().broadcast("telegram:changed", snapshot);
  }
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
      const rawRows = await listLinkedInHeartbeatCandidates(db, {
        limit: 50,
        minStrength: 4,
      });
      // v0.1.369 — Dedup gegen „aggressive" Meldungs-Flut. Ein einzelnes
      // Real-Ereignis (z. B. „Otto Group: Führungswechsel") wird von vielen
      // Personen GLEICHZEITIG gepostet (Journalisten, Analysten, die Firma
      // selbst). Jeder Post war bisher ein eigenes Signal → eigene Meldung
      // (gemeldet: 8 fast identische Otto-Group-Meldungen). Wir kollabieren
      // pro Sweep auf EINE Meldung je (Firma × Signal-Art): wir behalten den
      // stärksten (bei Gleichstand neuesten) Post als Kandidaten und markieren
      // die übrigen sofort als ausgewertet, damit sie nicht erneut auftauchen.
      const strongest = new Map<string, (typeof rawRows)[number]>();
      const dropped: typeof rawRows = [];
      for (const r of rawRows) {
        const key = `${r.companyId}|${r.signalKind}`;
        const cur = strongest.get(key);
        if (!cur) {
          strongest.set(key, r);
          continue;
        }
        const better =
          r.signalStrength > cur.signalStrength ||
          (r.signalStrength === cur.signalStrength &&
            (r.postedAt ?? 0) > (cur.postedAt ?? 0));
        if (better) {
          dropped.push(cur);
          strongest.set(key, r);
        } else {
          dropped.push(r);
        }
      }

      // v0.1.404 — Pass 2: FIRMENÜBERGREIFENDE Inhalts-Dedup. Dieselbe
      // Nachricht (z. B. „Corgi schließt 106 Mio. USD-Runde ab und expandiert
      // in neue Verticals") taucht in den Feeds VIELER überwachter Firmen
      // gleichzeitig auf (z. B. bei zehn Investoren, die alle darüber posten).
      // Jeder Post hat eine andere companyId (= die überwachte Investor-Firma,
      // nicht das Subjekt Corgi) und überlebt daher Pass 1. Wir clustern die
      // Überlebenden über eine normalisierte Token-Signatur der Zusammenfassung
      // (Präfix-Stemming gegen „Verticals/Vertikalen/Vertikale" etc. + Jaccard)
      // und behalten je Cluster nur den stärksten (bei Gleichstand neuesten)
      // Post. So wird aus zehn Corgi-Meldungen genau eine.
      const STOP = new Set([
        "und", "der", "die", "das", "ein", "eine", "einen", "mit", "fuer",
        "von", "im", "in", "ab", "auf", "zu", "an", "bei", "sowie", "neue",
        "neuen", "weitere", "weiteren", "ueber", "the", "and", "for", "with",
        "new",
      ]);
      const sigOf = (summary: string): Set<string> =>
        new Set(
          (summary ?? "")
            .toLowerCase()
            .replace(/[^\p{L}\p{N}]+/gu, " ")
            .split(/\s+/)
            .filter((w) => w.length >= 3 && !STOP.has(w))
            .map((w) => w.slice(0, 5)),
        );
      const jaccard = (a: Set<string>, b: Set<string>): number => {
        if (a.size === 0 || b.size === 0) return 0;
        let inter = 0;
        for (const x of a) if (b.has(x)) inter += 1;
        return inter / (a.size + b.size - inter);
      };
      const SIM_THRESHOLD = 0.5;
      const ordered = [...strongest.values()].sort(
        (a, b) =>
          b.signalStrength - a.signalStrength ||
          (b.postedAt ?? 0) - (a.postedAt ?? 0),
      );
      const clusters: { rep: (typeof rawRows)[number]; sig: Set<string> }[] = [];
      for (const r of ordered) {
        const sig = sigOf(r.summary);
        const hit = clusters.find((c) => jaccard(c.sig, sig) >= SIM_THRESHOLD);
        if (hit) {
          dropped.push(r); // gleiche Nachricht aus anderem Feed → kollabieren
        } else {
          clusters.push({ rep: r, sig });
        }
      }

      for (const d of dropped) {
        try {
          await recordLinkedInHeartbeatVerdict(db, d.postUrn, null);
        } catch {
          /* best-effort — der nächste Sweep fängt es sonst erneut */
        }
      }
      const rows = clusters.map((c) => c.rep);
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
    windows().broadcast("watches:changed", snapshot);
  }
  watchStore.on("changed", () => broadcastWatchesChanged());

  // ---------------------------------------------------------------------------
  // Mail-Supervisor (Phase 9.m — v0.1.257).
  // ---------------------------------------------------------------------------
  //
  // AVAs dedizierter Mail-Account. Single-Instance-Singleton; bleibt auch
  // "leer" instanziert (kein Konto konfiguriert), damit Settings → Datenquellen
  // die Konfiguration nachreichen kann. ProviderConfigStore wird lazy nach
  // dem app.whenReady() in den Boot-Sequenz unten attached (siehe weiter unten).
  let mailSupervisor: MailSupervisor | null = null;
  let scheduledJobsSupervisor: ScheduledJobsSupervisor | null = null;
  let linkMonitorSupervisor: LinkMonitorSupervisor | null = null;
  let radarSupervisor: RadarSupervisor | null = null;
  let radarAlertEmitter: RadarAlertEmitter | null = null;
  let profileWorker: ProfileWorker | null = null;
  let watchlistKeyStore: WatchlistKeyStore | null = null;
  let watchlistStore: WatchlistStore | null = null;
  let watchlistSupervisor: WatchlistSupervisor | null = null;
  let personenRadarStore: PersonenRadarStore | null = null;
  let personenRadarSupervisor: PersonenRadarSupervisor | null = null;
  /** W1 — Workflows (docs/PLAN_WORKFLOWS.md). */
  let workflowService: WorkflowService | null = null;
  let emailMuster: EmailMusterSupervisor | null = null;
  // v0.1.646 — Nutzerstand fuer Chat-Vorschlaege (PLAN_CHAT_VORSCHLAEGE V1).
  let nutzerstand: NutzerstandService | null = null;
  let chipErzeugung: ChipErzeugung | null = null;
  let vorschlaegeSettings: VorschlaegeSettingsStore | null = null;
  // Register-Delta S6 — Mithelfen (Desktop-Worker).
  let mithelfen: MithelfenSupervisor | null = null;
  let skillStoreRef: { list(): unknown[] } | null = null;

  /** v0.1.580 — Apify-Zugang fuer Watchlist/Personen-Radar im Hauptprozess:
   *  eigener Token gewinnt (ausser unter Anbieter-Sperre), sonst der
   *  Organisationsschluessel ueber den Gateway-Proxy mit dem Nutzer-JWT. */
  async function resolveApifyAccess(): Promise<import("../main/linkedin/apify-access").ApifyAccess | null> {
    const { eigenerApifyZugang, organisationsApifyZugang } = await import("../main/linkedin/apify-access");
    const eigener = watchlistKeyStore?.getKey() ?? null;
    if (providers.apifyUeberOrganisation(Boolean(eigener))) {
      const gw = providers.getOrgGateway();
      const jwt = await gw.getToken();
      if (gw.gatewayUrl && jwt) return organisationsApifyZugang(gw.gatewayUrl, jwt);
      // Hat die Organisation den eigenen Token ausdruecklich untersagt, darf er
      // auch dann nicht einspringen, wenn der Weg ueber die Organisation gerade
      // nicht zustande kommt. Sonst waere die Vorgabe umgehbar.
      if (!providers.apifyEigenerErlaubt()) return null;
    }
    return eigener ? eigenerApifyZugang(eigener) : null;
  }

  /** Fuer die UI: woher der Apify-Zugang kommt (ohne Token-Inhalte). */
  function apifyZugangInfo(): { apifyQuelle: "eigen" | "organisation" | null; apifyVerfuegbar: boolean; eigenerTokenErlaubt: boolean } {
    const eigener = watchlistKeyStore?.hasKey() ?? false;
    const org = providers.apifyUeberOrganisation(eigener) && Boolean(providers.getOrgGateway().gatewayUrl);
    const quelle = org ? "organisation" : eigener ? "eigen" : null;
    // Nur die Apify-Vorgabe zaehlt (Korrektur 2026-09-19). Die Anbieter-Sperre
    // stand hier mit drin und blendete das Eingabefeld aus, obwohl die
    // Organisation eigene Token ausdruecklich erlaubt hatte — siehe
    // apifyUeberOrganisation in agent/providers/manager.ts.
    return {
      apifyQuelle: quelle,
      apifyVerfuegbar: quelle !== null,
      eigenerTokenErlaubt: providers.apifyEigenerErlaubt(),
    };
  }
  // v0.1.490 — Bruecke: das Chat-Tool linkedin_watchlist_config aendert
  // companyWindow und muss den company-contact-Producer recyceln; die
  // eigentliche cycle-Funktion entsteht erst in der IPC-Registrierung.
  let recycleCompanyContactRef: (() => void) | null = null;

  function broadcastMailSnapshot(snapshot: MailSnapshot): void {
    windows().broadcast("mail:snapshot", snapshot);
  }

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
    // BC5 — Fokuskunden (eigenes aktives Buying Center) im Alarmweg und die
    // monatliche Nachfrage, ob ein Buying Center noch stimmt.
    // BC6 — abgeschaltet heisst: keine Fokuskunden im Alarmweg, keine Nachfrage.
    fokusFirmen: () => (featureEnabled("buyingcenter") ? fokusFirmen(gatewayClient) : Promise.resolve(new Set<string>())),
    faelligeNachfragen: (now) => (featureEnabled("buyingcenter") ? faelligeNachfragen(gatewayClient, now) : Promise.resolve([])),
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
      // Profil + ICP live in die Alarm-Bewertung — dieselbe Meldung ist
      // je nach Nutzer-Fokus alarmwuerdig oder Rauschen.
      getUserContext: () => {
        const p = userProfile.get();
        const lines: string[] = [];
        if (p.bio?.trim()) lines.push(`Bio: ${p.bio.trim()}`);
        if (p.role?.trim()) lines.push(`Rolle: ${p.role.trim()}`);
        if ((p.industries ?? []).length > 0)
          lines.push(`Branchen: ${p.industries.join(", ")}`);
        if ((p.geographies ?? []).length > 0)
          lines.push(`Regionen: ${p.geographies.join(", ")}`);
        if ((p.topics ?? []).length > 0)
          lines.push(`Themen: ${p.topics.join(", ")}`);
        // 2026-10-05: Was der Nutzer selbst als starkes Signal benannt hat,
        // gilt auch fuer Alarme — nicht nur fuer LinkedIn.
        if (p.signalInterests?.trim())
          lines.push(`Besonders interessant laut Nutzer: ${p.signalInterests.trim()}`);
        if (icpStore.isSet()) lines.push(`ICP: ${icpStore.renderText()}`);
        return lines.length > 0 ? lines.join("\n") : null;
      },
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
  // v0.1.210 — Token-Verbrauch lokal (PGlite). Wie der Audit-Store
  // lazy gestartet, lokal-only. Daily-Purge fired auf App-Start +
  // alle 24h. Settings → Verbrauch liest hieraus.
  const usageStore = new UsageStore();
  let usagePurgeTimer: NodeJS.Timeout | null = null;
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
    windows().broadcast("audit:inserted", event);
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
  // T1 — Account-Space-Zuordnung bei Anmeldung (Adoption von _pending,
  // Identitaets-Sperre bei fremdem sub). Nur einmal je Anmeldung.
  let lastSpaceSub: string | null = null;
  auth.on("status", (status: AuthStatus) => {
    // v0.1.537 — Liefert die STILLE Wiederherstellung ein fremdes Konto,
    // gehoert das gespeicherte Token nicht in diesen Space: verwerfen,
    // in seinen eigenen Space exportieren, Anmeldemaske fuer DIESEN Space
    // zeigen. Vorher griff die Identitaets-Sperre und warf den Nutzer in
    // den alten Account zurueck ("2x Neustart, wieder quikk").
    if (status.signedIn && status.actorId && status.via === "restore") {
      const ident = readIdentity();
      if (ident && ident.sub !== status.actorId) {
        console.warn(
          `[account-space] stille Anmeldung lieferte ${status.actorId.slice(0, 8)}…, Space gehoert ${ident.sub.slice(0, 8)}… → Token verworfen, Anmeldung fuer diesen Space`,
        );
        void auth
          .exportRefreshTokenTo(spaceDirFor(status.actorId))
          .then(() => auth.discardRestoredSession())
          .catch((err) => console.warn("[account-space] Verwerfen fehlgeschlagen:", err));
        return;
      }
    }
    if (status.signedIn && status.actorId && status.actorId !== lastSpaceSub) {
      lastSpaceSub = status.actorId;
      // O2 — Tenant-Wechsel seit dem letzten Lauf erkennen (Beitritt
      // freigegeben / entfernt), Anfragen-Waechter fuer Admins anwerfen.
      organisationSignedIn();
      // Konto-Spaces (ein Verzeichnis je Konto, Wechsel per Neustart) gibt es
      // nur in der Desktop-App; der Server hat genau ein Konto in AVA_DATA_DIR.
      const ergebnis = platform().kind !== "electron" ? "ok" : accountSpaceSignedIn(
        {
          sub: status.actorId,
          email: status.email ?? null,
          name: status.name ?? null,
          tenantId: status.tenantId ?? null,
          tenantName: status.tenantName ?? null,
        },
        { relaunchDelayMs: 1500 },
      );
      if (ergebnis === "relaunching") {
        // v0.1.533 — das eben erhaltene (Offline-)Token in den Ziel-Space
        // mitnehmen: nach dem Neustart ist das Konto sofort angemeldet.
        void auth.exportRefreshTokenTo(spaceDirFor(status.actorId)).then((ok) => {
          console.log(`[account-space] Refresh-Token in Ziel-Space uebernommen: ${ok}`);
        });
        console.log("[account-space] lokale Daten werden diesem Konto zugeordnet — AVA startet neu");
        windows().broadcast("accounts:relaunching", { sub: status.actorId });
      }
    }
    if (!status.signedIn) lastSpaceSub = null;
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
    windows().broadcast("alerts:changed");
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
    windows().broadcast("profile:changed", next);
  }
  userProfile.on("changed", () => broadcastProfileChanged());
  const freshness = new FreshnessScheduler({
    gateway: gatewayClient,
    prefs: freshnessPrefs,
    cursor: freshnessCursor,
    interest,
    // 2026-10-04: heisse Firmen frueher auffrischen (Relevanz-Rang 0-10).
    relevanz: async (ids) => {
      const w = await relevanz.werte("firma", ids);
      return new Map([...w].map(([id, x]) => [id, x.rang]));
    },
  });
  function broadcastFreshnessPrefsChanged(): void {
    const next = freshnessPrefs.get();
    windows().broadcast("freshness:prefs-changed", next);
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
    windows().broadcast("voice:status:changed", status);
  }
  function broadcastVoiceProgress(p: VoiceModelDownloadProgress): void {
    windows().broadcast("voice:download:progress", p);
  }
  whisper.on("status", broadcastVoiceStatus);
  whisper.on("progress", broadcastVoiceProgress);
  // 8.n1 follow-up — auto-install streams stdout/stderr lines so the
  // renderer can show "Brewing whisper-cpp …" in the Settings panel
  // while the install is in flight.
  whisper.on("installLog", (line: string) => {
    windows().broadcast("voice:install:log", line);
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

  // v0.1.225 — Knowledge-Manager als Singleton früh konstruieren, damit
  // sowohl die Chat-Tool-Registry (unten) als auch die IPC-Handler
  // (registerIpc-Aufruf später) dieselbe Instanz teilen.
  const knowledgeManager = KnowledgeManager.shared();

  // v0.1.236 — Skill-Store + Trust-Store werden weiter unten konstruiert
  // (initSkills ist async). Die Registry braucht die Referenzen JETZT,
  // also reichen wir Lazy-Getter rein, die zum Tool-Aufruf-Zeitpunkt die
  // aktuelle Instanz auflösen.
  let _skillStoreRef: import("../main/skills").SkillStore | null = null;
  let _skillsTrustRef: SkillsTrustStore | null = null;
  const skillsUserDir = join(paths().get("userData"), "skills");

  // v0.1.284 — Self-Correction-Feedback-Store. Lokal, kein Cloud-Upload.
  // Wird unten im Boot via .start() initialisiert.
  const selfCorrectionsStore = new SelfCorrectionsStore();

  // Phase 3 Firmen-Discovery (PLAN_FIRMEN_DISCOVERY.md) — ICP (privat,
  // lokal) + Match-Store (nutzerbezogene Scores). Von Tools UND den
  // Radar-IPC-Handlern unten geteilt.
  const icpStore = new IcpStore();
  const discoveryMatches = new MatchStore();
  // I5 — lokale Top-Kunden-Profile (Aehnlichkeits-Signal im Match).
  const customerProfiles = new CustomerProfileStore();

  const agentRegistry = buildReadOnlyRegistry({
    gateway: gatewayClient,
    providers,
    getResearchStand: () => ResearchFeaturesStore.shared().manuellerStand({ providerLocked: providers.isProviderLocked() }),
    sprache: {
      get: () => SpracheStore.shared().get(),
      setzen: (teil) => SpracheStore.shared().setzen(teil),
      stand: () => {
        const q = providers.keySource("openai");
        const hat = q === "organisation" ? Boolean(providers.getOrgProviders().openai) : providers.hasKey("openai") || Boolean(providers.getOrgProviders().openai);
        return { verfuegbar: hat, quelle: hat ? (q === "organisation" || !providers.hasKey("openai") ? "organisation" : "eigen") : null };
      },
    },
    icp: icpStore,
    discoveryMatches,
    discoveryCustomerProfiles: customerProfiles,
    getRadarAlerts: () => radarAlertEmitter,
    getTenantTier: () => getTenantTierCached(),
    getWatchlistStore: () => watchlistStore,
    getWatchlistSupervisor: () => watchlistSupervisor,
    // v0.1.576 — Radar-Config per Chat (radar_config).
    hatApifyZugang: async () => Boolean(await resolveApifyAccess()),
    getWorkflows: () => workflowService,
    getEmailMuster: () => emailMuster,
    getNutzerstand: () => nutzerstand,
    getVorschlaegeSettings: () => vorschlaegeSettings,
    getMithelfen: () => mithelfen,
    browserStand: () => eigenerBrowser?.aktuellerStand() ?? { zustand: "aus" },
    browserLaden: async () => (await eigenerBrowser?.stelleSicher()) ?? { zustand: "aus" },
    getRegisterQueueStatus: () => registerQueueStatus(),
    getRadar: () =>
      radarSupervisor
        ? {
            getConfig: () => radarSupervisor!.getConfig(),
            setConfig: (patch: { enabled?: boolean; intervalHours?: 6 | 24 | 168; profileSofort?: boolean; maxOffeneKandidaten?: number }) => {
              const next = radarSupervisor!.setConfig(patch);
              profileWorker?.setSofort(next.profileSofort);
              return next;
            },
            profileStatus: () => profileWorker?.getStatus() ?? null,
            deckel: () => radarSupervisor!.deckel(),
          }
        : null,
    getWatchlistKeyStore: () => watchlistKeyStore,
    onCompanyWindowChanged: () => recycleCompanyContactRef?.(),
    getPersonenRadarStore: () => personenRadarStore,
    getPersonenRadarSupervisor: () => personenRadarSupervisor,
    // T5 — account_info.
    getAuthStatus: () => auth.getStatus(),
    listAccounts: () => listAccounts(),
    refreshPolicy: () => checkTenantChange("Vorgaben per Chat geaendert").then(() => getOrgPolicy()),
    getTenantCompanyIds: () => collectTenantCompanyIds(gatewayClient, 250),
    getPublicationMode: () => publicationStore.getMode(),
    setPublicationMode: (mode: "lazy" | "eager") => publicationStore.setMode(mode),
    discoveryAudit: ({ action, severity, summary, metadata }) => {
      audit({
        actorType: "system",
        actorId: null,
        category: "import",
        action,
        severity,
        subjectType: null,
        subjectId: null,
        summary,
        metadata,
      });
    },
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
    knowledge: knowledgeManager,
    // v0.1.236 — Skill-Self-Authoring-Tools. Stores werden weiter unten
    // im Boot zugewiesen; bis dahin liefern die Getter null und die
    // skill_*-Tools melden „Skills-Store nicht initialisiert".
    getSkillStore: () => _skillStoreRef,
    getSkillsTrust: () => _skillsTrustRef,
    skillsUserDir,
    // v0.1.257 — Mail-Supervisor (Phase 9.m). Wird erst nach
    // ProviderConfigStore.shared() unten in der Boot-Sequenz instanziiert;
    // bis dahin liefert der Getter null und die Mail-Tools sind nicht
    // registriert.
    getMailSupervisor: () => mailSupervisor,
    // v0.1.267 — ScheduledJobs-Supervisor (Phase S). Analog Lazy-Pattern.
    getScheduledJobsSupervisor: () => scheduledJobsSupervisor,
    getLinkMonitorSupervisor: () => linkMonitorSupervisor,
    // v0.1.412 — Telegram: Store + Kanal stehen bereits vor dem Registry-Bau,
    // der Lazy-Getter hält das Muster der übrigen Supervisoren bei.
    getTelegramStore: () => telegramStore,
    getTelegramChannel: () => telegramChannel,
    // v0.1.284 — Self-Correction-Reporting (always-on Telemetrie).
    selfCorrectionsStore,
    getActiveConversationId: () => agent.getStatus().inFlightConversationId,
  });
  // v0.1.405 — Tages-Token-Limit-Status berechnen (Chat + Agent teilen
  // EINEN Tageszähler). `usedToday` ist die Summe aller heute (UTC-
  // Kalendertag) verbrauchten Tokens im lokalen UsageStore.
  async function computeDailyLimitStatus(): Promise<
    import("../shared/types").DailyTokenLimitStatus
  > {
    const limit = providers.getDailyTokenLimit();
    if (limit === null || limit <= 0) {
      return { limit: null, usedToday: 0, exceeded: false };
    }
    let usedToday = 0;
    try {
      usedToday = await usageStore.tokensUsedToday();
    } catch (err) {
      console.warn("[usage] tokensUsedToday failed:", err);
    }
    return { limit, usedToday, exceeded: usedToday >= limit };
  }

  // v0.1.405 — Status an alle Fenster pushen (Banner + Verbrauchs-Tab
  // aktualisieren sich live, sobald das Limit erreicht oder geändert wird).
  async function broadcastDailyLimitStatus(): Promise<void> {
    try {
      const status = await computeDailyLimitStatus();
      windows().broadcast("usage:dailyLimitStatus", status);
    } catch (err) {
      console.warn("[usage] broadcast daily-limit status failed:", err);
    }
  }

  // v0.1.468 — Globaler Autonomie-Modus (Schalter am Chat-Eingabefeld).
  const autonomyStore = new AutonomyStore();

  const agent = new AgentOrchestrator({
    providers,
    // v0.1.468 — EIN Modus fuer Chat, Telegram und Mail; der
    // Orchestrator klammert Mail selbst auf max. "additive".
    getAutonomyLevel: () => autonomyStore.asLevel(),
    // v0.1.462 — Vollmacht: jede autonome Bestätigung landet im
    // Audit-Trail (PLAN_VOLLMACHT.md §4.1).
    onAudit: (entry) =>
      audit({
        actorType: "system",
        actorId: null,
        category: "agent",
        action: entry.action,
        severity: entry.severity ?? "info",
        subjectType: null,
        subjectId: null,
        summary: entry.summary,
        metadata: entry.metadata,
      }),
    // v0.1.405 — Gate vor jedem Turn (Chat UND Agent laufen durch den
    // Orchestrator). Liefert den aktuellen Tagesstand; bei `exceeded`
    // blockt der Orchestrator den Turn mit Hinweis-Frame.
    checkDailyLimit: () => computeDailyLimitStatus(),
    registry: agentRegistry,
    // v0.1.649 (Chat-Vorschlaege V4) — Urteil nach dem Turn; lazy, weil chipErzeugung spaeter entsteht.
    vorschlaegeNachTurn: (ctx: { conversationId: string; nutzerText: string; antwortText: string; toolNamen: string[] }) =>
      chipErzeugung && featureEnabled("vorschlaege") && (vorschlaegeSettings?.get().gespraech ?? true) ? chipErzeugung.gespraech(ctx) : Promise.resolve([]),
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
    // ICP als passiver Lese-Kontext in jedem Agenten-Turn.
    getIcpText: () => (icpStore.isSet() ? icpStore.renderText() : null),
    // v0.1.161 — fold the long-term memory entries into the system
    // prompt on every turn. Previously the agent could only reach them
    // via `recall_memory`-tool-use; the auto-inject closes the failure
    // mode where it answered "I don't know anything about you" despite
    // the store containing entries.
    generalMemoryStore: generalMemory,
    // v0.1.210 — Sink für Token-Usage pro Chat-Turn. USD-Schätzung
    // läuft hier durch (Anthropic-OAuth-Subscription → USD=null, weil
    // keine API-Kosten anfallen; Ollama → USD=null, weil lokal). Fire-
    // and-forget; jeder Fehler wird intern gefangen, damit der Chat
    // niemals an einem Logging-Issue scheitert.
    estimateCost: ({ provider, model, inputTokens, outputTokens, cacheReadTokens, cacheWriteTokens }) => {
      if (provider === "ollama") return 0;
      // Abo-Zugaenge (Claude-/ChatGPT-Abo) zaehlen nicht gegen API-Guthaben.
      if (provider === "anthropic" && (providers.getConfig().anthropicAuthMode ?? "api-key") === "subscription") return null;
      if (provider === "openai" && (providers.getConfig().openaiAuthMode ?? "api-key") === "subscription") return null;
      return estimateUsd({ provider: provider as never, model, inputTokens, outputTokens, cacheReadTokens, cacheWriteTokens });
    },
    onUsage: ({ provider, model, conversationId, usage }) => {
      try {
        const inputTokens = usage.inputTokens ?? 0;
        const outputTokens = usage.outputTokens ?? 0;
        const cacheReadTokens = usage.cacheReadTokens ?? 0;
        const cacheWriteTokens = usage.cacheWriteTokens ?? 0;
        // USD nur schätzen, wenn:
        //   - kein Ollama (lokal, $0)
        //   - kein Anthropic-OAuth-Abo (Kosten gehen gegen Abo-Quota,
        //     nicht gegen API-Guthaben)
        let estimatedUsd: number | null = 0;
        if (provider === "ollama") {
          estimatedUsd = 0;
        } else if (
          provider === "anthropic" &&
          (providers.getConfig().anthropicAuthMode ?? "api-key") ===
            "subscription"
        ) {
          estimatedUsd = null;
        } else {
          estimatedUsd = estimateUsd({
            provider,
            model,
            inputTokens,
            outputTokens,
            cacheReadTokens,
            cacheWriteTokens,
          });
        }
        void usageStore
          .record({
            provider,
            model,
            source: { kind: "chat", conversationId },
            inputTokens,
            outputTokens,
            cacheReadTokens,
            cacheWriteTokens,
            estimatedUsd,
            ...(usage.quotaSnapshot
              ? { quotaSnapshot: usage.quotaSnapshot }
              : {}),
          })
          .then(() => {
            // v0.1.405 — nach jedem aufgezeichneten Turn den Limit-Status
            // neu pushen, damit das Banner sofort erscheint, sobald der
            // Tagesverbrauch das Limit erreicht (auch ohne neue Anfrage).
            void broadcastDailyLimitStatus();
          })
          .catch((err) => {
            console.warn("[usage] record failed:", err);
          });
      } catch (err) {
        console.warn("[usage] onUsage handler crashed:", err);
      }
    },
  });

  // v0.1.417 — Telegram-Eingang an den Orchestrator haengen (der existiert
  // erst ab hier) und gemaess gespeicherter Konfiguration starten.
  // MCP-Relais (docs/PLAN_AVA_CLOUD.md §11): dieselben Werkzeuge wie im Chat
  // fuer Claude/ChatGPT ueber mcp.ava.bi, solange dieser Kopf laeuft.
  // AVA_MCP_RELAIS=0 schaltet es ab; Organisationsschalter mcp.kopf im Gateway.
  const mcpRelais = new KopfRelais({
    gatewayUrl: GATEWAY_URL,
    getAccessToken: () => auth.getAccessToken(),
    istAngemeldet: () => auth.getStatus().signedIn,
    registry: agentRegistry,
    version: paths().version(),
    audit: (e) => audit({ actorType: "system", actorId: auth.getStatus().actorId ?? null, category: "agent", action: e.action, severity: "info", subjectType: null, subjectId: null, summary: e.summary, metadata: e.metadata }),
  });
  auth.on("status", (st: AuthStatus) => {
    if (st.signedIn && process.env.AVA_MCP_RELAIS !== "0") mcpRelais.start();
  });
  lifecycle().onBeforeQuit(() => quitStep("mcpRelais.stop", () => mcpRelais.stop()));

  telegramInbound = new TelegramInbound({
    store: telegramStore,
    orchestrator: agent,
    // Sprachantwort (docs/PLAN_TELEGRAM_SPRACHANTWORT.md): OpenAI-Stimme,
    // Schluessel wie im Chat (eigener zuerst, Organisation ueber den Proxy).
    openaiZugang: () => providers.openaiZugang(),
    providers,
    // W4 — Freigaben per Telegram (/freigaben, /ja <id>, /nein <id>).
    getWorkflows: () => workflowService,
    // v0.1.419 — Sprachnachrichten lokal transkribieren. Whisper ist bereits
    // gebuendelt; damit verlaesst auch die Sprache den Rechner nicht.
    // v0.1.470 — Boot-Rennen: Die Telegram-Schleife kann eine wartende
    // Sprachnachricht greifen, BEVOR der Whisper-Probe beim App-Start
    // durch ist ("nicht bereit (state=idle)"). start() ist ein
    // idempotenter Probe — bei nicht-ready einmal nachproben statt
    // sofort zu scheitern.
    transcribe: async (wav) => {
      if (whisper.getStatus().state !== "ready") {
        await whisper.start();
      }
      return whisper.transcribe(wav);
    },
    onAudit: ({ severity, summary, metadata }) => {
      audit({
        actorType: "system",
        actorId: null,
        category: "watch",
        action: "telegram.inbound",
        severity,
        subjectType: null,
        subjectId: null,
        summary,
        metadata,
      });
    },
  });
  if (featureEnabled("telegram")) telegramInbound.sync();
  else console.log("[telegram] nicht gestartet — Organisationsvorgabe: Telegram aus");
  lifecycle().onBeforeQuit(() => quitStep("telegramInbound.stop", () => telegramInbound?.stop()));

  alertPrefs.on("changed", (next: AlertPrefs) => {
    // Apply the new cadence immediately. push / quiet-hours / threshold
    // changes don't need a reschedule — `NotificationManager` re-reads
    // prefs on every send.
    heartbeat.setIntervalMs(next.cadenceMinutes * 60_000);
    windows().broadcast("alert-prefs:changed", next);
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
    windows().broadcast("agent:stream", frame);
  }
  function broadcastAgentStatus(status: AgentStatus): void {
    windows().broadcast("agent-status:changed", status);
  }
  agent.on("stream", broadcastAgentStream);
  agent.on("status", broadcastAgentStatus);

  // Hintergrundaufgaben (docs/PLAN_HINTERGRUNDAUFGABEN.md, 2026-10-03): laufende
  // Verarbeitungen im Chat verfolgen und bei Abschluss von selbst melden.
  const hintergrundAufgaben = new HintergrundAufgaben({
    gateway: gatewayClient,
    datei: join(paths().get("userData"), "hintergrund-aufgaben.json"),
    melden: (conversationId, text) => {
      try {
        // Ueber Telegram gestartet → Ergebnis aufs Handy (Stufe 2).
        if (conversationId.startsWith("telegram-") && telegramInbound && featureEnabled("telegram")) {
          return telegramInbound.meldeHintergrundaufgabe(conversationId, text);
        }
        return agent.meldeAufgabe(conversationId, text);
      } catch (err) {
        console.warn("[aufgaben] melden fehlgeschlagen:", err instanceof Error ? err.message : err);
        return false;
      }
    },
    benachrichtigen: (titel, text) => {
      if (windows().isAnyFocused()) return;
      // Systembenachrichtigung ist ein Zusatz; ohne Desktop zeigt die Plattform nichts.
      notifier().show({ title: titel, body: text });
    },
    aktiv: () => auth.getStatus().signedIn && !workerModus.aktiv(),
    log: (m) => console.log(m),
  });
  setzeAufgabenInstanz(hintergrundAufgaben);
  agent.on("werkzeug-ergebnis", (e) => {
    if (!e.ok) return;
    // aufgabe_beobachten registriert selbst; hier nur die Stelle im Verlauf merken.
    if (e.toolName === "aufgabe_beobachten") {
      const tx = typeof e.args.transactionId === "string" ? e.args.transactionId : "";
      if (tx) hintergrundAufgaben.verankern(e.conversationId, tx, e.toolCallId);
      return;
    }
    const titel = AUTO_WERKZEUGE[e.toolName];
    if (!titel) return;
    try {
      const r = JSON.parse(e.content) as { transactionId?: unknown; companyCount?: unknown; filename?: unknown };
      if (typeof r.transactionId !== "string" || !r.transactionId) return;
      const anzahl = typeof r.companyCount === "number" ? ` (${r.companyCount} Firmen)` : "";
      const datei = typeof r.filename === "string" ? ` ${r.filename}` : "";
      hintergrundAufgaben.registrieren({ conversationId: e.conversationId, transactionId: r.transactionId, titel: `${titel}${datei}${anzahl}`, quelle: e.toolName, ankerToolCallId: e.toolCallId });
    } catch {
      /* kein JSON → keine Transaktion */
    }
  });
  hintergrundAufgaben.on("aenderung", (liste) => {
    windows().broadcast("aufgaben:aenderung", liste);
  });
  hintergrundAufgaben.start();



  // ---- Verdrahtung (vormals app.whenReady) ----------------------------------
  // v0.1.395 — persistierten Verarbeitungs-Pause-Zustand laden, BEVOR die
  // Auth-Lifecycle-Logik die Producer startet (sonst würden sie trotz
  // gespeicherter Pause anlaufen).
  processingControl.load();
  // Wire the on-disk handler for the `ava-screenshot://` protocol we
  // pre-registered above. Also prune captures older than the TTL so
  // a long-running install doesn't accumulate gigabytes of frames.
  void pruneOldScreenshots();
  // v0.1.432 — P5: Prune nicht nur beim Boot, sondern taeglich — sonst
  // greift die Keep-Newest-Regel bei Dauerlaeufern nie.
  setInterval(() => void pruneOldScreenshots(), 24 * 60 * 60 * 1000);
  // L6 — same protocol pattern for LinkedIn media thumbnails.

  // v0.1.366 — verwaiste Temp-Artefakte aufräumen. Der lokale
  // structured-content-Producer lädt Handelsregister-Dokumente nach
  // `…/Temp/ava-handelsregister-downloads`; beim Producer-Crash (z. B. der
  // MAX_PATH-Loop) oder einem fehlgeschlagenen Cleanup blieben sie liegen
  // und summierten sich auf zig GB. Beim Boot einmal aufräumen (Backlog
  // abbauen) + danach stündlich. Die 30-min-Altersschwelle schützt eine
  // gerade laufende Download/Transkription.
  try {
    sweepManagedTemp();
  } catch {
    /* best-effort */
  }
  // Eigener Browser fuer die Hintergrundverarbeitung (chrome-for-testing.ts,
  // docs/ANALYSE_CHROME_PROZESSE.md L5). Erst nachsehen, ob schon eine Fassung
  // da ist; das ist billig und sagt sofort Bescheid. Das Laden selbst laeuft
  // danach im Hintergrund weiter, damit der Start nie darauf wartet.
  eigenerBrowser = new ChromeForTesting(
    join(paths().get("userData"), "chrome-for-testing"),
    (zeile) => writeLineSync("INFO ", zeile),
    (stand) => {
      windows().broadcast("browser:stand", stand);
    },
  );
  void eigenerBrowser
    .sucheVorhandene()
    .then((stand) => {
      if (stand.zustand === "bereit") {
        writeLineSync("INFO ", `[browser] eigener Browser bereit: Chrome for Testing ${stand.version}`);
        return;
      }
      if (stand.zustand === "aus") return; // Plattform ohne Fassung
      // Rund 160 MB, einmalig. Schlaegt es fehl, bleibt der Browser der Person.
      return eigenerBrowser?.stelleSicher().then(() => undefined);
    })
    .catch(() => undefined);

  // Verwaiste chromedriver/Headless-Chrome aus frueheren Sitzungen beenden (browser-sweep.ts).
  void beendeVerwaisteBrowser({ log: (z) => writeLineSync("INFO ", z) });
  setInterval(
    () => {
      void beendeVerwaisteBrowser({ log: (z) => writeLineSync("INFO ", z) });
      try {
        sweepManagedTemp();
      } catch {
        /* best-effort */
      }
    },
    60 * 60 * 1000,
  ).unref();

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
  workerModus.anmelden({ name: "Erreichbarkeit", anhalten: () => externalServiceMonitor.stop(), anlaufen: () => externalServiceMonitor.start() });

  // v0.1.181 — background OAuth refresh for the Anthropic In-App
  // subscription token. Without this, the access_token expires after
  // ~1h and every producer's LLM call returns "Invalid authentication
  // credentials" until the user manually clicks "Neu verbinden" in
  // Settings. The refresher silently swaps for a fresh access_token
  // ~15 min before expiry using the stored refresh_token. The first
  // tick runs synchronously inside start() so a long-stale token
  // gets refreshed at boot before any producer-spawn.
  // Claude-Abo-OAuth wurde entfernt — kein AnthropicTokenRefresher mehr.
  // Nur noch der ChatGPT-Abo-Refresher läuft.
  const { OpenAITokenRefresher } = await import("../main/auth/token-refresher");
  const { ProviderConfigStore } = await import("../main/agent/providers/store");
  const providerConfigStore = ProviderConfigStore.shared();
  const openaiTokenRefresher = new OpenAITokenRefresher(providerConfigStore);
  openaiTokenRefresher.start();
  lifecycle().onBeforeQuit(() => quitStep("openaiTokenRefresher.stop", () => openaiTokenRefresher.stop()));

  // v0.1.257 — Mail-Supervisor (Phase 9.m). Braucht providers + Provider-
  // Config-Store, beide jetzt verfügbar. start() lädt das Konto aus dem
  // Store; wenn keins konfiguriert → idle, keine IMAP-Connection.
  mailSupervisor = new MailSupervisor({
    providers,
    providerStore: providerConfigStore,
    // v0.1.465 — M5: Best-effort-Fehler sichtbar machen.
    onAudit: (entry) =>
      audit({
        actorType: "system",
        actorId: null,
        category: "watch",
        action: "mail.supervisor.warning",
        severity: entry.severity,
        subjectType: null,
        subjectId: null,
        summary: entry.summary,
        metadata: entry.metadata,
      }),
  });
  mailSupervisor.on("snapshot", broadcastMailSnapshot);
  // W4 — Workflow-Trigger mail.inbound (nur eingehende, fertig geladene Mails).
  mailSupervisor.on("messageFinalized", (msg: import("../shared/types").MailMessage) => {
    if (msg.direction !== "inbound") return;
    // M4 — Rueckmeldung fuer abgeleitete Adressen: Bounce deaktiviert, Antwort bestaetigt.
    void meldeAbgeleiteteAdressen(msg, (path, opts) => gatewayClient.request(path, opts as never)).catch(() => undefined);
    void workflowService?.emitEvent("mail.inbound", {
      messageId: msg.id,
      from: msg.from.address,
      fromName: msg.from.name,
      to: msg.to.map((t) => t.address),
      subject: msg.subject,
      date: msg.date,
      folder: msg.folder,
    });
  });
  try {
    if (featureEnabled("mail")) await mailSupervisor.start();
    else console.log("[mail/supervisor] nicht gestartet — Organisationsvorgabe: Mail-Anbindung aus");
    workerModus.anmelden({
      name: "Mail",
      // suspendConnections statt stop: stop() schliesst den eingebetteten
      // Speicher. Genau daran blieb AVA im Worker-Modus haengen — das
      // Protokoll endete dreimal reproduzierbar bei "> Mail anhalten".
      anhalten: () => mailSupervisor?.suspendConnections(),
      anlaufen: () => mailSupervisor?.start(),
      darfLaufen: () => featureEnabled("mail"),
    });
  } catch (err) {
    console.warn(
      "[mail/supervisor] start fehlgeschlagen:",
      err instanceof Error ? err.message : String(err),
    );
  }
  // v0.1.299 — Auto-Triage-Bridge. Lauscht auf messageFinalized-Events
  // und startet bei trusted Mails eine autonome Agent-Session. Toggle
  // im Mail-Account-Setting (autoTriageEnabled) — default off.
  try {
    const { MailAgentBridge } = await import("../main/mail/agent-bridge");
    const bridge = new MailAgentBridge({
      supervisor: mailSupervisor,
      store: mailSupervisor.getStore(),
      orchestrator: agent,
    });
    bridge.start();
  } catch (err) {
    console.warn(
      "[mail-agent-bridge] start fehlgeschlagen:",
      err instanceof Error ? err.message : String(err),
    );
  }
  lifecycle().onBeforeQuit(() => {
    // 2026-09-18 — Beim Beenden NICHT den eingebetteten Speicher schliessen.
    // PGlite laeuft als WebAssembly im Hauptprozess; sein close() blockiert die
    // Ereignisschleife. Genau daran hing das Beenden bisher JEDES Mal, der
    // Wachhund schoss AVA nach wenigen Sekunden ab, und dadurch blieben die
    // Hintergrund-Browser als Waisen stehen (docs/ANALYSE_CHROME_PROZESSE.md,
    // D11). Das close() wurde dabei ohnehin nie fertig — es weglassen ist
    // strikt besser. Die Daten liegen auf der Platte; PGlite stellt beim
    // naechsten Start wieder her, so wie nach jedem Absturz.
    quitStep("mailSupervisor.suspendConnections", () => mailSupervisor?.suspendConnections());
  });

  // v0.1.307 — Sleep/Wake-Handler. macOS-Sleep-Cycles lassen TCP-Sockets
  // (IMAP-IDLE, AMQP) in einem stuck-state zurück; beim Wake versucht
  // AVA close()/reconnect, hängt im Kernel-IORWLock und friert für
  // 60+ Sekunden. Real-Run-Hang-Report aus User-Logs zeigt genau dieses
  // Pattern (uv_close → __close_nocancel → IORWLockRead blocked).
  //
  // Strategy:
  //   suspend: Sockets PROAKTIV stoppen damit das System sie sauber
  //            schließen kann während es noch funktioniert.
  //   resume:  Mit 3s Grace-Period (damit macOS Netzwerk neu hochkommt)
  //            alle Services neu starten.
  //
  // Wir machen das best-effort — wenn .stop() langsam ist, blockiert
  // das den powerMonitor-Callback. macOS gibt aber nur ~2s vor dem
  // Sleep; deshalb fire-and-forget mit setImmediate.
  //
  // v0.1.313 — Erweitert. Bisher wurde nur der mailSupervisor pausiert.
  // Real-Run-Reports zeigen, dass auch ANDERE Hintergrund-Services nach
  // dem Wake hängen (warmer Mac, "AVA reagiert nicht"):
  //   - ExternalServiceMonitor: 15-Min-Probes auf unternehmensregister,
  //     mit 120s fetch-Timeout. Stale Socket nach Wake = bis zu 2 min
  //     blockierte Probe.
  //   - ScheduledJobsSupervisor: Timer feuern in stale-Cloud-Connections.
  //   - LinkedIn-Scheduler: Tick mitten im Wake = BrowserWindow-Spawn
  //     auf einem System, das gerade Strom-management macht. UI-Freeze.
  //   - Updater: setInterval feuert in stale GitHub-Connection.
  // Lösung: ALLE proaktiv pausieren auf suspend, mit 3s Grace nach
  // resume neu starten. Jeder Aufruf separat best-effort, damit ein
  // hängender stop() nicht die anderen blockiert.
  power().on("suspend", () => {
    // v0.1.485 — SYNCHRON als allererstes: Schlaf-Marker in die
    // Heartbeat-Datei, damit der Watchdog-Sidecar den Einschlaf-
    // Uebergang nicht als Main-Wedge fehlinterpretiert (er tickt
    // beim Einschlafen einige Sekunden laenger als Main).
    markHeartbeatSuspend();
    writeLineSync("INFO ", "[power] suspend begin");
    console.log("[power] suspend — proactively stopping background services");
    setImmediate(() => traceStep("[power]", "mailSupervisor", () => {
      void mailSupervisor?.suspendConnections().catch((err) => {
        console.warn("[power] suspend: mailSupervisor.stop failed:", err instanceof Error ? err.message : String(err));
      });
    }));
    setImmediate(() => traceStep("[power]", "externalServiceMonitor", () => {
      try {
        externalServiceMonitor.stop();
      } catch (err) {
        console.warn("[power] suspend: externalServiceMonitor.stop failed:", err instanceof Error ? err.message : String(err));
      }
    }));
    setImmediate(() => traceStep("[power]", "stopLinkedInScheduler", () => {
      try {
        stopLinkedInScheduler();
      } catch (err) {
        console.warn("[power] suspend: linkedinScheduler.stop failed:", err instanceof Error ? err.message : String(err));
      }
    }));
    setImmediate(() => traceStep("[power]", "scheduledJobsSupervisor", () => {
      try { scheduledJobsSupervisor?.suspendTimers(); } catch (err) {
        console.warn("[power] suspend: scheduledJobsSupervisor.stop failed:", err instanceof Error ? err.message : String(err));
      }
    }));
    setImmediate(() => traceStep("[power]", "updater", () => {
      try {
        updater.stop();
      } catch (err) {
        console.warn("[power] suspend: updater.stop failed:", err instanceof Error ? err.message : String(err));
      }
    }));
    // v0.1.538 — beim Suspend wird KEINE PGlite-Instanz mehr geschlossen
    // (Scheduler: suspendTimers(), Mail: suspendConnections()); nur Netzverbindungen
    // und Timer. Begruendung siehe ScheduledJobsSupervisor.suspendTimers.
    // v0.1.532 — postgres.stop() (v0.1.340) laeuft beim Suspend NICHT
    // mehr: es schloss den pg-gateway-Server UND alle PGlite-Instanzen
    // in dem ~2s-Fenster, das macOS vor dem Schlaf gewaehrt. Die Wedge-
    // Serie (2026-09-01/02/03) lag ausnahmslos in Quit-/Suspend-Ketten,
    // und seit die Quit-Kette per Breadcrumbs sauber durchlaeuft, bleibt
    // die Suspend-Kette als Tatort. Loopback-Verbindungen ueberstehen
    // den Schlaf; resume ruft postgres.start() ohnehin idempotent.
    // v0.1.532 — Telegram-Long-Polling vor dem Schlaf beenden (Netz
    // faellt weg); resume startet es per sync() wieder.
    setImmediate(() => traceStep("[power]", "telegramInbound", () => {
      telegramInbound?.stop();
    }));
  });
  power().on("resume", () => {
    // v0.1.554 — Netz nach dem Aufwachen oft erst spaeter da: stille
    // Anmeldung erneut versuchen, statt den Nutzer zur Maske zu schicken.
    setTimeout(() => void auth.retryRestore("resume").catch(() => undefined), 8_000);
    writeLineSync("INFO ", "[power] resume begin");
    console.log("[power] resume — re-arming services in 3s");
    setTimeout(() => {
      // v0.1.532 — Telegram-Eingang wieder starten (Konfiguration entscheidet).
      try {
        telegramInbound?.sync();
      } catch (err) {
        console.warn("[power] resume: telegramInbound.sync failed:", err instanceof Error ? err.message : String(err));
      }
      void mailSupervisor?.start().catch((err) => {
        console.warn("[power] resume: mailSupervisor.start failed:", err instanceof Error ? err.message : String(err));
      });
      try {
        externalServiceMonitor.start();
      } catch (err) {
        console.warn("[power] resume: externalServiceMonitor.start failed:", err instanceof Error ? err.message : String(err));
      }
      try {
        startLinkedInScheduler();
      } catch (err) {
        console.warn("[power] resume: linkedinScheduler.start failed:", err instanceof Error ? err.message : String(err));
      }
      void scheduledJobsSupervisor?.resumeTimers().catch((err) => {
        console.warn("[power] resume: scheduledJobsSupervisor.resumeTimers failed:", err instanceof Error ? err.message : String(err));
      });
      void updater.start().catch((err) => {
        console.warn("[power] resume: updater.start failed:", err instanceof Error ? err.message : String(err));
      });
      // v0.1.340 — pg-gateway/PGlite nach Wake neu starten (auf suspend
      // proaktiv geschlossen, s.o.). start() ist idempotent — wenn er nie
      // gestoppt wurde (suspend-stop noch in-flight), ist es ein No-Op.
      void postgres.start().catch((err) => {
        console.warn("[power] resume: postgres.start failed:", err instanceof Error ? err.message : String(err));
      });
      hooks.onResume?.();
    }, 3000);
  });





  // v0.1.284 — Self-Corrections-Store starten + 24h-Retention-Tick.
  try {
    await selfCorrectionsStore.start();
    void selfCorrectionsStore.purgeOlderThanRetention();
    setInterval(
      () => void selfCorrectionsStore.purgeOlderThanRetention(),
      24 * 60 * 60 * 1000,
    );
  } catch (err) {
    console.warn(
      "[self-corrections] start fehlgeschlagen:",
      err instanceof Error ? err.message : String(err),
    );
  }
  lifecycle().onBeforeQuit(() => {
    quitStep("selfCorrectionsStore.stop", () => selfCorrectionsStore.stop());
  });

  // v0.1.267 — ScheduledJobs-Supervisor (Phase S). Eigener PGlite-Store
  // unter userData/pglite/scheduler. Beim Boot werden alle active-Jobs
  // aus der DB gelesen und Timer neu armiert (Persistenz übersteht
  // App-Restart). Aktuell einziger registrierter Executor: mail-send
  // — ruft mailSupervisor.sendAndSync() pro fire-Event.
  const scheduledJobsStore = new ScheduledJobsStore();
  scheduledJobsSupervisor = new ScheduledJobsSupervisor(scheduledJobsStore);
  scheduledJobsSupervisor.registerExecutor("mail-send", async (job) => {
    if (!mailSupervisor) {
      throw new Error("Mail-Supervisor nicht bereit.");
    }
    const account = await mailSupervisor.getStore().getAccount();
    if (!account) throw new Error("Kein Mail-Konto konfiguriert.");
    if (!account.outboundEnabled) {
      throw new Error("Mail-Outbound ist deaktiviert.");
    }
    // v0.1.305 — Payload-Type ist jetzt Union (mail-send|reminder).
    // Cast nach kind-Check; supervisor garantiert kind="mail-send"
    // hier wegen registerExecutor("mail-send", …).
    const payload = job.payload as ScheduledMailSendPayload;
    await mailSupervisor.sendAndSync({
      to: payload.to,
      cc: payload.cc,
      subject: payload.subject,
      text: payload.text,
    });
  });

  // v0.1.305 — Reminder-Executor. Wird zur dueAt-Zeit gefeuert,
  // legt einen Alert mit kind="reminder" an und löst eine OS-
  // Notification aus (falls aktiviert + Quiet-Hours nicht aktiv).
  // Der Alert landet automatisch in der Meldungs-Liste der UI.
  scheduledJobsSupervisor.registerExecutor("reminder", async (job) => {
    const payload = job.payload as ScheduledReminderPayload;
    // sourceRef macht den Alert idempotent gegen Re-Fires durch
    // setTimeout-Cap-Re-Schedules. Pro Job + Run-Index 1 Alert.
    const sourceRef = `reminder:${job.id}:${job.runsCompleted}`;
    const alert = alerts.add({
      tenantId: null,
      companyId: payload.companyId ?? "",
      companyName: payload.companyName ?? "",
      kind: "reminder",
      severity: "warn",
      headline: job.label.slice(0, 120),
      rationale: payload.prompt.slice(0, 500),
      sourceRef,
    });
    if (alert) {
      console.log(
        `[reminder-executor] alert created (job=${job.id}, alert=${alert.id})`,
      );
      // OS-Notification + Renderer-Broadcast via dieselbe Pipeline,
      // die der Heartbeat nutzt.
      broadcastAlertsChanged();
      notifications.notifyForAlert(alert);
    } else {
      // Dedup: sourceRef hat schon einen Alert — kann passieren wenn
      // setTimeout den Job 2x feuert nach Schlaf/Wake. Best-effort log.
      console.log(
        `[reminder-executor] alert already exists for ${sourceRef} (dedup)`,
      );
    }
  });
  scheduledJobsSupervisor.on("changed", () => {
    void broadcastScheduledJobsChanged();
  });
  try {
    await scheduledJobsSupervisor.start();
    // Nur die Zeitgeber anhalten: stop() wuerde den eingebetteten Speicher
    // (PGlite/WASM) schliessen und dabei die Ereignisschleife blockieren.
    workerModus.anmelden({ name: "Geplante Aufgaben", anhalten: () => scheduledJobsSupervisor?.suspendTimers(), anlaufen: () => scheduledJobsSupervisor?.start() });
  } catch (err) {
    console.warn(
      "[scheduler] start fehlgeschlagen:",
      err instanceof Error ? err.message : String(err),
    );
  }
  lifecycle().onBeforeQuit(() => {
    quitStep("scheduledJobsSupervisor.suspendTimers", () => scheduledJobsSupervisor?.suspendTimers());
  });

  async function broadcastScheduledJobsChanged(): Promise<void> {
    if (!scheduledJobsSupervisor) return;
    try {
      const jobs = await scheduledJobsSupervisor.store.list();
      windows().broadcast("scheduler:jobs-changed", jobs);
    } catch {
      /* store nicht ready */
    }
  }

  // LM — Link-Monitor-Supervisor. Eigener PGlite-Store unter
  // userData/pglite/link-monitor. Boot-Rehydrate aller active-Monitore;
  // bei erkannter Änderung erzeugt der Supervisor einen Alert
  // (kind="link-change") + OS-Push über dieselbe Pipeline wie Reminder.
  const linkMonitorStore = new LinkMonitorStore();
  linkMonitorSupervisor = new LinkMonitorSupervisor({
    store: linkMonitorStore,
    providers,
    alerts,
    notify: (a) => {
      notifications.notifyForAlert(a);
    },
    onAlertsChanged: broadcastAlertsChanged,
    // v0.1.411 — Link-Überwachungs-Läufe im Audit-Trail protokollieren.
    onAudit: ({ action, severity, summary, metadata }) => {
      audit({
        actorType: "system",
        actorId: null,
        category: "watch",
        action,
        severity,
        subjectType: null,
        subjectId: null,
        summary,
        metadata,
      });
    },
  });
  linkMonitorSupervisor.on("changed", () => {
    void broadcastLinkMonitorsChanged();
  });
  try {
    await linkMonitorSupervisor.start();
    workerModus.anmelden({ name: "Link-Beobachter", anhalten: () => linkMonitorSupervisor?.suspendTimers(), anlaufen: () => linkMonitorSupervisor?.start() });
  } catch (err) {
    console.warn(
      "[link-monitor] start fehlgeschlagen:",
      err instanceof Error ? err.message : String(err),
    );
  }
  // Phase 4 Firmen-Discovery — Radar-Automatik (Opt-in, Default AUS).
  // Scan/Profile/Match nach Intervall; neue heisse ICP-Treffer laufen
  // als kind="radar-match" durch den normalen Alert-Fanout
  // (Glocke + OS-Push + Telegram).
  radarAlertEmitter = new RadarAlertEmitter({
    alerts,
    notify: (a) => {
      notifications.notifyForAlert(a);
    },
    onAlertsChanged: broadcastAlertsChanged,
    // v0.1.466 — Plan-Politik: Schwelle/Budget nach Abo-Stufe.
    getPolicy: () => policyForTier(getTenantTierCached()),
    // W4 — Workflow-Trigger radar.newHot (je Treffer ein Ereignis).
    onNeueHeisse: (rows) => {
      for (const r of rows) void workflowService?.emitEvent("radar.newHot", { discoveryId: r.discoveryId, name: r.name, ort: r.ort, score: r.score, begruendung: r.begruendung });
    },
  });
  // v0.1.474 — Paket a+c: kontinuierlicher Profil-Worker; nach jedem
  // Drain mit neuen Profilen laeuft ein INKREMENTELLER Match (nur die
  // neuen Kandidaten) und heisse Treffer gehen durch den Alert-Fanout.
  let incrementalMatchRunning = false;
  const runIncrementalMatch = async (): Promise<void> => {
    if (incrementalMatchRunning || !icpStore.isSet()) return;
    // Das Matching bewertet mit dem Modell und kostet damit Geld; im
    // Worker-Modus faellt es aus.
    if (workerModus.aktiv()) return;
    incrementalMatchRunning = true;
    try {
      const result = await runMatch(
        gatewayClient,
        providers,
        icpStore,
        discoveryMatches,
        customerProfiles,
        { mode: "incremental" },
      );
      if (!("error" in result) && result.bewertet > 0 && radarAlertEmitter) {
        radarAlertEmitter.emit(result.ergebnisse);
        broadcastAlertsChanged();
      }
    } catch (err) {
      console.warn("[discovery] inkrementeller Match fehlgeschlagen:", err);
    } finally {
      incrementalMatchRunning = false;
    }
  };
  profileWorker = new ProfileWorker({
    gateway: gatewayClient,
    providers,
    getPrioritizeTerms: () => icpStore.get().branchen,
    isSignedIn: () => auth.getStatus().signedIn,
    isLlmBusy: () => agent.getStatus().inFlightRequestId !== null,
    onDrained: () => void runIncrementalMatch(),
    onAudit: (entry) =>
      audit({
        actorType: "system",
        actorId: null,
        category: "import",
        action: "discovery.profileWorker",
        severity: entry.severity,
        subjectType: null,
        subjectId: null,
        summary: entry.summary,
        metadata: entry.metadata,
      }),
  });
  profileWorker.start();
  workerModus.anmelden({ name: "Mini-Profile", anhalten: () => profileWorker?.stop(), anlaufen: () => profileWorker?.start() });

  // WL3 (PLAN_LINKEDIN_WATCHLIST.md) — Personen-Watchlist: BYOK-
  // Beobachtung der oeffentlichen LinkedIn-Aktivitaet von
  // Zielkontakten. Opt-in (Key + enabled), Fokus-Priorisierung,
  // Alerts als kind="linkedin-signal" durch den normalen Fanout.
  watchlistKeyStore = new WatchlistKeyStore();
  watchlistStore = new WatchlistStore({
    getTier: () => getTenantTierCached(),
  });
  watchlistSupervisor = new WatchlistSupervisor({
    keyStore: watchlistKeyStore,
    getApifyAccess: resolveApifyAccess,
    watchlist: watchlistStore,
    providers,
    icp: icpStore,
    alerts,
    notify: (a) => {
      notifications.notifyForAlert(a);
    },
    onAlertsChanged: broadcastAlertsChanged,
    isSignedIn: () => auth.getStatus().signedIn,
    // v0.1.479 — Bestands-Rotation: Kontakte mit LinkedIn-Profil aus
    // ALLEN verarbeiteten Firmen (Tenant-Transaktionen → Firmen →
    // Gateway-Pool-Route).
    fetchBestandPool: async () => {
      try {
        const companyIds = await collectTenantCompanyIds(gatewayClient, 250);
        if (companyIds.length === 0) return [];
        const r = await gatewayClient.request<{
          items: Array<{ fullName: string; companyId: string; linkedinUrl: string }>;
        }>("/v1/contacts/linkedin-profiles", {
          method: "POST",
          body: { companyIds: companyIds.slice(0, 300) },
        });
        return r.items.map((i) => ({
          profileUrl: i.linkedinUrl,
          label: i.fullName,
          companyId: i.companyId,
        }));
      } catch (err) {
        console.warn("[watchlist] Bestands-Pool-Fetch fehlgeschlagen:", err);
        return null;
      }
    },
    onAudit: ({ action, severity, summary, metadata }) => {
      audit({
        actorType: "system",
        actorId: null,
        category: "linkedin",
        action,
        severity,
        subjectType: null,
        subjectId: null,
        summary,
        metadata: metadata ?? {},
      });
    },
  });
  if (featureEnabled("linkedin.watchlist")) watchlistSupervisor.start();
  else console.log("[watchlist] nicht gestartet — Organisationsvorgabe: Personen-Watchlist aus");
  workerModus.anmelden({
    name: "Beobachtungsliste",
    anhalten: () => watchlistSupervisor?.stop(),
    anlaufen: () => watchlistSupervisor?.start(),
    darfLaufen: () => featureEnabled("linkedin.watchlist"),
  });

  // §8 Personen-Radar: Engagement auf beobachteten Posts → Firmen in
  // den normalen Radar-Trichter (Direkt-Kandidaten). Teilt sich den
  // Apify-Key mit der Watchlist.
  personenRadarStore = new PersonenRadarStore();
  personenRadarSupervisor = new PersonenRadarSupervisor({
    providers,
    keyStore: watchlistKeyStore,
    getApifyAccess: resolveApifyAccess,
    store: personenRadarStore,
    gateway: gatewayClient,
    alerts,
    notify: (a) => {
      notifications.notifyForAlert(a);
    },
    onAlertsChanged: broadcastAlertsChanged,
    isSignedIn: () => auth.getStatus().signedIn,
    onCandidatesAdded: () => void profileWorker?.drain(),
    onAudit: ({ action, severity, summary, metadata }) => {
      audit({
        actorType: "system",
        actorId: null,
        category: "linkedin",
        action,
        severity,
        subjectType: null,
        subjectId: null,
        summary,
        metadata: metadata ?? {},
      });
    },
  });
  if (featureEnabled("linkedin.radar")) personenRadarSupervisor.start();
  else console.log("[personen-radar] nicht gestartet — Organisationsvorgabe: Personen-Radar aus");
  workerModus.anmelden({
    name: "Personen-Radar",
    anhalten: () => personenRadarSupervisor?.stop(),
    anlaufen: () => personenRadarSupervisor?.start(),
    darfLaufen: () => featureEnabled("linkedin.radar"),
  });

  // O3 — Vorgaben aendern sich zur Laufzeit (Admin schaltet um, Tenant-
  // Wechsel): Hintergrunddienste je Funktion stoppen bzw. starten.
  onOrgPolicyChange((neu, alt) => {
    // Apify-Vorgabe: Stellt die Organisation um, ob der eigene Token den ihren
    // ueberschreiben darf, muss die Auswahl sofort neu berechnet werden.
    if (
      (neu.apifyEigenerErlaubt !== false) !== (alt.apifyEigenerErlaubt !== false) ||
      (neu.chatgptPlanErlaubt !== false) !== (alt.chatgptPlanErlaubt !== false) ||
      (neu.chatgptPlanProducer === true) !== (alt.chatgptPlanProducer === true)
    ) {
      providers.setOrgContext({
        providers: providers.getOrgProviders(),
        gatewayUrl: APP_CONFIG.gatewayUrl,
        getToken: () => auth.getAccessToken(),
        apifyEigenerErlaubt: neu.apifyEigenerErlaubt !== false,
        chatgptPlanErlaubt: neu.chatgptPlanErlaubt !== false,
        chatgptPlanProducer: neu.chatgptPlanProducer === true,
      });
    }
    const an = (k: string) => neu.features[k] !== false;
    const war = (k: string) => alt.features[k] !== false;
    const umschalten = (k: string, start: () => void | Promise<void>, stop: () => void | Promise<void>) => {
      if (an(k) === war(k)) return;
      console.log(`[org-policy] ${k}: ${an(k) ? "freigegeben → starten" : "abgeschaltet → stoppen"}`);
      // Worker-Modus: abschalten ja, anlaufen nein (sonst liefen LinkedIn-
      // Dienste nach einer Aenderung der Orga-Vorgaben wieder, 2026-09-25).
      if (an(k) && workerModus.aktiv()) {
        console.log(`[org-policy] ${k}: Worker-Modus aktiv, Start zurueckgestellt`);
        return;
      }
      void Promise.resolve()
        .then(() => (an(k) ? start() : stop()))
        .catch((err) => console.warn(`[org-policy] ${k} umschalten fehlgeschlagen:`, err instanceof Error ? err.message : String(err)));
    };
    umschalten("mail", () => mailSupervisor?.start(), () => mailSupervisor?.stop());
    umschalten("telegram", () => telegramInbound?.sync(), () => telegramInbound?.stop());
    umschalten("linkedin.watchlist", () => watchlistSupervisor?.start(), () => watchlistSupervisor?.stop());
    umschalten("linkedin.radar", () => personenRadarSupervisor?.start(), () => personenRadarSupervisor?.stop());
    umschalten("linkedin.beobachter", () => startLinkedInScheduler(), () => stopLinkedInScheduler());
  });
  // v0.1.559 — Modellvorgabe der Organisation (providerLock, chatModel,
  // producerModel) wird von den Producern nur beim Spawn gelesen
  // (LLM_MODEL/AVA_LLM_VIA_GATEWAY aus getProducerLlmEnv). Trifft die
  // Policy erst nach dem Start ein (Erstinstallation, Neustart nach
  // Tenant-Wechsel, Admin aendert die Vorgabe zur Laufzeit), liefen die
  // Producer sonst bis zum naechsten App-Start mit dem alten Modell weiter.
  onOrgPolicyChange((neu, alt) => {
    if (neu.providerLock === alt.providerLock && neu.chatModel === alt.chatModel && neu.producerModel === alt.producerModel && (neu.researchModel ?? null) === (alt.researchModel ?? null)) return;
    console.log(`[org-policy] Modellvorgabe geaendert (lock=${neu.providerLock}, chat=${neu.chatModel ?? "-"}, producer=${neu.producerModel ?? "-"}, research=${neu.researchModel ?? "-"}) → Producer neu starten`);
    scheduleCredentialCycle("org-policy");
  });
  // v0.1.559 — Organisationsschluessel treffen ebenfalls erst nach dem
  // whoami-Abgleich ein; der Manager meldet das als configChanged, das
  // bisher niemand fuer den Producer-Cycle ausgewertet hat.
  providers.on("configChanged", () => scheduleCredentialCycle("org-context"));
  // v0.1.519 — einmalige Freigabe aller Ungeklaerten: der Positionen-
  // Bugfix (v0.1.518) hat die Kaskade repariert, aber die 90-Tage-
  // Sperre haette die betroffenen Personen bis Dezember blockiert.
  {
    const prs = personenRadarStore;
    if (!prs.getConfig().unklarFreigegebenAm) {
      void prs
        .releaseUnklar()
        .then((n) => {
          prs.setConfig({ unklarFreigegebenAm: new Date().toISOString() });
          if (n > 0) console.log(`[personen-radar] ${n} Ungeklaerte nach Bugfix freigegeben`);
        })
        .catch((err) => console.warn("[personen-radar] Freigabe fehlgeschlagen:", err));
    }
  }

  radarSupervisor = new RadarSupervisor({
    gateway: gatewayClient,
    providers,
    icp: icpStore,
    matchStore: discoveryMatches,
    customerStore: customerProfiles,
    radarAlerts: radarAlertEmitter,
    profileWorker,
    isSignedIn: () => auth.getStatus().signedIn,
    // v0.1.466 — Automatik-Klammer nach Plan (free: aus, 6h nur Pro).
    getTier: () => getTenantTierCached(),
    onAudit: ({ action, severity, summary, metadata }) => {
      audit({
        actorType: "system",
        actorId: null,
        category: "import",
        action,
        severity,
        subjectType: null,
        subjectId: null,
        summary,
        metadata: metadata ?? {},
      });
    },
  });
  radarSupervisor.start();
  workerModus.anmelden({ name: "Radar", anhalten: () => radarSupervisor?.stop(), anlaufen: () => radarSupervisor?.start() });
  {
    const rc = radarSupervisor.getConfig();
    radarActivity.letzterLauf(rc.lastRunAt, rc.lastOutcome);
  }
  // v0.1.576 — Sofort-Modus des Profil-Workers aus der Radar-Config.
  profileWorker.setSofort(radarSupervisor.getConfig().profileSofort);

  // W1 — Workflow-Service: Store, Engine, Zeitplan-Trigger, Freigaben.
  workflowService = new WorkflowService({
    registry: agentRegistry,
    providers,
    getAutonomyLevel: () => autonomyStore.asLevel(),
    getTier: () => getTenantTierCached(),
    isSignedIn: () => auth.getStatus().signedIn,
    featureEnabled: () => featureEnabled("workflows"),
    emit: (frame: WorkflowProgressFrame) => {
      windows().broadcast("workflows:progress", frame);
    },
    audit: (entry) =>
      audit({
        actorType: "system",
        actorId: null,
        category: "agent",
        action: entry.action,
        severity: entry.severity,
        subjectType: null,
        subjectId: (entry.metadata.workflowId as string | undefined) ?? null,
        summary: entry.summary,
        metadata: entry.metadata,
      }),
    // Meldung unter „Meldungen“ + OS-Toast + Telegram (ueber den Alert-Fanout).
    notify: (m) => {
      const alert = alerts.add({
        tenantId: null,
        companyId: "",
        companyName: "Workflow",
        kind: "workflow",
        severity: m.art === "freigabe" ? "warn" : m.art === "fehler" ? "warn" : "info",
        headline: m.title,
        rationale: m.body,
        sourceRef: `workflow:${m.executionId}:${m.approvalId ?? m.art}`,
      });
      if (alert) {
        broadcastAlertsChanged();
        notifications.notifyForAlert(alert);
      } else {
        notifier().show({ title: m.title, body: m.body.slice(0, 200) });
      }
    },
    gatewayRequest: (path, opts) => gatewayClient.request(path, opts ? { method: opts.method as "GET" | "POST" | "PUT" | "DELETE" | undefined, body: opts.body } : undefined),
    getActorId: () => auth.getStatus().actorId ?? null,
  });
  workflowService.start();
  workerModus.anmelden({ name: "Ablaeufe", anhalten: () => workflowService?.stop(), anlaufen: () => workflowService?.start() });
  // v0.1.593 — Vorgangs-Watcher: Meldung nach Abschluss eines Imports (mit
  // Fehleruebersicht) und Quelle fuer das Workflow-Ereignis import.finished.
  const transactionWatcher = new TransactionWatcher({
    gatewayRequest: (path) => gatewayClient.request(path),
    isSignedIn: () => auth.getStatus().signedIn,
    addAlert: (input) => alerts.add({ tenantId: null, companyId: "", companyName: "Vorgang", ...input }),
    notify: (a) => {
      broadcastAlertsChanged();
      notifications.notifyForAlert(a);
    },
    onCompleted: (tx, companies) => {
      for (const c of companies) {
        if (c.state !== "completed") continue;
        void workflowService?.emitEvent("import.finished", { transactionId: tx.transactionId, transactionName: tx.name, companyId: c.companyId, fehlgeschlageneStufen: c.fehlgeschlageneStufen });
      }
    },
    audit: ({ summary, severity, metadata }) =>
      audit({ actorType: "system", actorId: null, category: "import", action: "transaction.finished", severity, subjectType: null, subjectId: (metadata.transactionId as string) ?? null, summary, metadata }),
  });
  transactionWatcher.start();
  workerModus.anmelden({ name: "Vorgaenge", anhalten: () => transactionWatcher.stop(), anlaufen: () => transactionWatcher.start() });
  // M4 (docs/PLAN_EMAIL_MUSTER.md) — lokale E-Mail-Ableitung im Hintergrund.
  emailMuster = new EmailMusterSupervisor(
    {
      gatewayRequest: (path, opts) => gatewayClient.request(path, opts as never),
      isSignedIn: () => auth.getStatus().signedIn,
      isLlmBusy: () => agent.getStatus().inFlightRequestId !== null,
      isOnBattery: () => {
        try {
          return power().isOnBatteryPower();
        } catch {
          return false;
        }
      },
      audit: ({ summary, severity, metadata }) =>
        audit({ actorType: "system", actorId: null, category: "import", action: "email-muster.run", severity, subjectType: null, subjectId: (metadata.companyId as string) ?? null, summary, metadata }),
      log: (m) => console.log(m),
      onChanged: (cfg) => {
        windows().broadcast("emailMuster:changed", cfg);
      },
      // Stufe 2 (docs/PLAN_EMAIL_MUSTER_2.md): KI-Urteil fuer Zuordnung und Muster,
      // Hintergrund-Kanal (Budget der Organisation, zentrale KI-Sperre greift).
      urteil: async (system, user) => {
        try {
          const text = await hintergrundUrteil(
            providers,
            [
              { id: `em-sys-${Date.now()}`, role: "system", content: system, createdAt: Date.now() },
              { id: `em-usr-${Date.now()}`, role: "user", content: user, createdAt: Date.now() },
            ],
            { channel: "background", quelle: "email-zuordnung", timeoutMs: 30_000 },
          );
          return text || null;
        } catch (err) {
          console.log(`[email-muster] Urteil nicht moeglich: ${err instanceof Error ? err.message : String(err)}`);
          return null;
        }
      },
    },
    paths().get("userData"),
  );
  emailMuster.start();
  workerModus.anmelden({ name: "E-Mail-Muster", anhalten: () => emailMuster?.stop(), anlaufen: () => emailMuster?.start() });
  lifecycle().onBeforeQuit(() => quitStep("emailMuster.stop", () => emailMuster?.stop()));
  // W4 — Workflow-Trigger alert.created.
  alerts.onCreated = (a) => {
    void workflowService?.emitEvent("alert.created", { alertId: a.id, kind: a.kind, severity: a.severity, headline: a.headline, companyId: a.companyId, companyName: a.companyName });
    // Zentraler Fan-out: jede Meldung erreicht OS-Push und Telegram, auch wenn
    // der Ersteller (z. B. Watches) nicht selbst benachrichtigt. Idempotent.
    broadcastAlertsChanged();
    notifications.notifyForAlert(a);
  };
  // Firmenstatus-Waechter: Insolvenz, Loeschung, Loeschungsankuendigung, Liquidation bei "Meine Firmen".
  const statusWatcher = new StatusWatcher({
    gatewayRequest: (path) => gatewayClient.request(path),
    isSignedIn: () => auth.getStatus().signedIn,
    tenantId: () => auth.getStatus().tenantId ?? null,
    addAlert: (input) => alerts.add({ tenantId: auth.getStatus().tenantId ?? null, ...input }),
    notify: (a) => {
      broadcastAlertsChanged();
      notifications.notifyForAlert(a);
    },
    audit: (entry) =>
      audit({ actorType: "system", actorId: null, category: "watch", action: "status.check", severity: entry.severity, subjectType: "company", subjectId: null, summary: entry.summary, metadata: entry.metadata }),
  });
  statusWatcher.start();
  workerModus.anmelden({ name: "Statuswaechter", anhalten: () => statusWatcher.stop(), anlaufen: () => statusWatcher.start() });
  lifecycle().onBeforeQuit(() => quitStep("statusWatcher.stop", () => statusWatcher.stop()));
  lifecycle().onBeforeQuit(() => quitStep("radarSupervisor.stop", () => radarSupervisor?.stop()));

  lifecycle().onBeforeQuit(() => {
    quitStep("linkMonitorSupervisor.suspendTimers", () => linkMonitorSupervisor?.suspendTimers());
  });

  async function broadcastLinkMonitorsChanged(): Promise<void> {
    if (!linkMonitorSupervisor) return;
    try {
      const monitors = await linkMonitorSupervisor.store.list();
      const snapshot: LinkMonitorSnapshot = {
        monitors,
        activeCount: monitors.filter((m) => m.status === "active").length,
        cap: LINK_MONITOR_ACTIVE_CAP,
        runningIds: linkMonitorSupervisor.runningIds(),
      };
      windows().broadcast("link-monitor:changed", snapshot);
    } catch {
      /* store nicht ready */
    }
  }

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
    // v0.1.356 — Wenn ein OpenAI-/Anthropic-Key (neu) gesetzt wird und der
    // Nutzer Research nie selbst konfiguriert hat, Job-Postings + Deep-
    // Research nachträglich auf tier=standard aktivieren. Behebt den Fall
    // „Key später eingetragen → Features blieben still aus". Der dadurch
    // ausgelöste research configChanged cycelt den Website-Producer.
    if (kind === "openai" || kind === "anthropic") {
      try {
        ResearchFeaturesStore.shared().maybeAutoEnableFromGlobalKeys();
      } catch (err) {
        console.warn("[research-store] maybeAutoEnableFromGlobalKeys failed:", err);
      }
    }
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
  // Claude-Abo-OAuth entfernt — kein anthropicSubscriptionTokenChanged-
  // Listener mehr. Nur noch das ChatGPT-Abo.
  // docs/PLAN_CHATGPT_ABO_UEBERALL.md (E1): Der stuendliche Refresh des
  // Plan-Tokens ist KEIN Grund, die Producer neu zu starten — sie holen den
  // Token je Anfrage vom Loopback-Dienst. Neustart nur, wenn eine
  // Verbindung entsteht oder verschwindet.
  let planVerbunden = providerConfigStore.hasOpenAISubscriptionToken();
  providerConfigStore.on("openaiSubscriptionTokenChanged", () => {
    const jetzt = providerConfigStore.hasOpenAISubscriptionToken();
    if (jetzt !== planVerbunden) {
      planVerbunden = jetzt;
      scheduleCredentialCycle("openaiSubscriptionTokenChanged");
    } else {
      console.info("[providers] ChatGPT-Plan-Token erneuert — Producer laufen weiter (Loopback-Dienst)");
    }
    audit({
      actorType: "user",
      actorId: null,
      category: "auth",
      action: "credential.subscription.changed",
      severity: "info",
      subjectType: "credential",
      subjectId: "openai-subscription",
      summary: "ChatGPT-Subscription-Token aktualisiert",
      metadata: { provider: "openai", authMode: "subscription" },
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

  // v0.1.338 — separate in-flight guard for the GATEWAY-token recovery
  // path (handleProducerGatewayAuthError). Distinct from
  // authRecoveryInFlight so an LLM-credential refresh and a gateway-token
  // refresh triggered close together don't block each other.
  let gatewayAuthRecoveryInFlight = false;

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
    // Claude-Abo-OAuth wurde entfernt → kein Provider hat mehr ein
    // auto-refreshbares Credential. Jedes Producer-401 (egal welcher
    // Provider) ist ein „Key prüfen / neu anmelden"-Fall; wir weisen den
    // Nutzer hin statt einen (nicht mehr existierenden) Token-Refresh zu
    // versuchen.
    console.warn(
      `[providers] producer ${args.producerName} signalled auth failure for provider=${args.provider}; user must update the key in Settings.`,
    );
    void notifyUserAuthExpired(args.provider);
  }

  // v0.1.338 — reactive recovery for a rejected GATEWAY token.
  //
  // The website + company-contact producers carry PRODUCER_GATEWAY_TOKEN
  // (a 15-min Keycloak access token, captured at spawn) on their
  // operator-paid `/v1/proxy/*` calls. When it expires the gateway 401s
  // every redelivered message and — unlike the LLM-provider 401 path —
  // there was no recovery: the producer just looped on 401 until some
  // unrelated credential cycle happened to re-spawn it.
  //
  // The supervisor's `detectGatewayAuthError` watcher now fires
  // `gatewayAuthError` for that case. We respond by force-refreshing the
  // Keycloak access token (ignoring the lead-time window — the producer's
  // captured token can be stale even when main's local expiresAt still
  // looks valid) and scheduling a credential cycle so every producer
  // re-spawns with a fresh PRODUCER_GATEWAY_TOKEN via buildEnv().
  async function handleProducerGatewayAuthError(args: {
    producerName: string;
  }): Promise<void> {
    if (gatewayAuthRecoveryInFlight) return;
    if (!auth.getStatus().signedIn) {
      console.warn(
        `[providers] producer ${args.producerName} hit gateway-401 but user is signed out — skipping refresh.`,
      );
      return;
    }
    gatewayAuthRecoveryInFlight = true;
    audit({
      actorType: "producer",
      actorId: args.producerName,
      category: "auth",
      action: "credential.rejected",
      severity: "warning",
      subjectType: "credential",
      subjectId: "gateway-token",
      summary: `Producer ${args.producerName} meldet abgelehntes Gateway-Token (401)`,
      metadata: { producer: args.producerName, credential: "gateway-token" },
    });
    try {
      console.info(
        `[providers] producer ${args.producerName} signalled gateway-401; forcing Keycloak token refresh`,
      );
      const fresh = await auth.forceRefresh();
      audit({
        actorType: "system",
        actorId: "token-refresher",
        category: "auth",
        action: fresh ? "token.refresh.refreshed" : "token.refresh.failed",
        severity: fresh ? "info" : "warning",
        subjectType: "credential",
        subjectId: "gateway-token",
        summary: fresh
          ? "Keycloak-Access-Token erneuert (reaktiv nach Gateway-401)"
          : "Keycloak-Token-Refresh nach Gateway-401 fehlgeschlagen",
        metadata: { trigger: "producer-gateway-401", producer: args.producerName },
      });
      if (!fresh) {
        // Couldn't refresh (no refresh token / exchange failed). Cycling
        // would just re-inject the same rejected token — skip it and let
        // the supervisor's 30s debounce retry on the next 401.
        console.warn(
          `[providers] forced refresh after gateway-401 failed for ${args.producerName}; not cycling (would re-hit 401).`,
        );
        return;
      }
      // Fresh token in hand — cycle producers so they re-spawn with the
      // new PRODUCER_GATEWAY_TOKEN. scheduleCredentialCycle is debounced
      // (500ms) and idempotent.
      scheduleCredentialCycle(`gateway-401(${args.producerName})`);
    } finally {
      gatewayAuthRecoveryInFlight = false;
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
    notifier().show({ title: "AVA: Anmeldung erforderlich", body });
    // Also broadcast to any open windows so the renderer can show an
    // in-app banner / Settings nudge. Renderer-side handler is best-
    // effort; falling back to the OS notification covers the
    // app-in-background case.
    windows().broadcast("providers:authExpired", { provider });
  }

  for (const p of producers) {
    p.on(
      "authError",
      (args: { producerName: string; provider: string | null }) => {
        void handleProducerAuthError(args);
      },
    );
    // v0.1.338 — gateway-token (PRODUCER_GATEWAY_TOKEN) 401 recovery.
    p.on("gatewayAuthError", (args: { producerName: string }) => {
      void handleProducerGatewayAuthError(args);
    });
    // ChatGPT-Abo: Kontingent erschoepft → Producer wartet (E5); hier nur sichtbar machen.
    p.on("planLimit", (args: { producerName: string; status: number | null; versuch: number | null; warteSekunden: number | null }) => {
      console.warn(`[producer:${args.producerName}] ChatGPT-Abo: Kontingent erschoepft (HTTP ${args.status ?? "?"}), wartet ${args.warteSekunden ?? "?"} s (Versuch ${args.versuch ?? "?"})`);
      audit({
        actorType: "producer",
        actorId: args.producerName,
        category: "auth",
        action: "chatgpt-plan.limit",
        severity: "warning",
        subjectType: null,
        subjectId: null,
        summary: `ChatGPT-Abo: Kontingent erschoepft, ${args.producerName} wartet ${args.warteSekunden ?? "?"} s (ChatGPT → Settings → Usage)`,
        metadata: { status: args.status, versuch: args.versuch, warteSekunden: args.warteSekunden },
      });
    });
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
    // v0.1.566 — Absturz-Wiederholungen nicht je Versuch auditieren:
    // erster Absturz sofort, danach hoechstens alle 10 Minuten.
    let lastCrashAuditAt = 0;
    let fehlerOffen = false;
    p.on("status", (status: ProducerStatus) => {
      const cur = status.state;
      // v0.1.566 — "wieder bereit" auch nach Absturz-Neustart (error → starting → ready).
      if (cur === "error") fehlerOffen = true;
      const wasErrored = prevState === "error" || fehlerOffen;
      const istAbsturz = (status.crashCount ?? 0) > 0 && status.nextRetryAt != null;
      const absturzGedrosselt = istAbsturz && (status.crashCount ?? 0) > 1 && Date.now() - lastCrashAuditAt < 10 * 60_000;
      if (cur === "error" && prevState !== "error" && !absturzGedrosselt) {
        if (istAbsturz) lastCrashAuditAt = Date.now();
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
            crashCount: status.crashCount ?? 0,
            nextRetryAt: status.nextRetryAt ?? null,
          },
        });
      } else if (cur === "ready" && wasErrored) {
        fehlerOffen = false;
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
    windows().broadcast("crm-status:changed", status);
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




  // Relevanz (docs/PLAN_RELEVANZ.md) — Signale gebuendelt ans Gateway.
  // Standardmaessig an; die Organisation kann es abschalten oder
  // verbindlich setzen.
  relevanz.initRelevanz({
    gatewayUrl: APP_CONFIG.gatewayUrl,
    getAccessToken: () => auth.getAccessToken(),
  });
  // O6 — Limit der Organisation erreicht → Banner im Renderer.
  setOrgQuotaExceededHandler((info) => {
    windows().broadcast("org:quotaExceeded", info);
  });
  // O2 — Organisationen: Einladungslink, Tenant-Wechsel, Anfragen-Waechter.
  initOrganisation({
    gateway: gatewayClient,
    isSignedIn: () => auth.getStatus().signedIn,
    onOrgProviders: (provs) => {
      providers.setOrgContext({
        providers: provs as Partial<Record<LlmProviderKind | "apify", string>>,
        gatewayUrl: APP_CONFIG.gatewayUrl,
        getToken: () => auth.getAccessToken(),
        // Vorgabe der Organisation: Darf der eigene Apify-Token den der
        // Organisation ueberschreiben? Fehlt sie, gilt "ja" wie bisher.
        apifyEigenerErlaubt: getOrgPolicy().apifyEigenerErlaubt !== false,
        chatgptPlanErlaubt: getOrgPolicy().chatgptPlanErlaubt !== false,
        chatgptPlanProducer: getOrgPolicy().chatgptPlanProducer === true,
      });
      // Deep Research ueber den OpenAI-Schluessel der Organisation.
      ResearchFeaturesStore.shared().setOrgOpenaiAvailable(Boolean(provs.openai));
    },
    // O9 — Sammel-Meldung je Abgleich: „N neue Firmen aus der Organisation".
    onNeueRadarFreigaben: (shares) => {
      const zeilen = shares.slice(0, 10).map((x) => {
        const k = x.candidate;
        const ort = k ? [k.plz, k.city].filter(Boolean).join(" ") : "";
        const wer = x.sharedByName ?? x.sharedBy.slice(0, 8) + "…";
        return `- **${k?.name ?? x.refId}**${ort ? ` (${ort})` : ""}${k?.domain ? ` · ${k.domain}` : ""} · geteilt von ${wer}${x.note ? ` · „${x.note}"` : ""}`;
      });
      const mehr = shares.length > 10 ? `\n- … und ${shares.length - 10} weitere` : "";
      const alert = alerts.add({
        tenantId: auth.getStatus().tenantId ?? null,
        companyId: shares[0]?.candidate?.masterCompanyId ?? "",
        companyName: shares.length === 1 ? (shares[0]?.candidate?.name ?? "Organisation") : "Organisation",
        kind: "radar-match",
        severity: "info",
        headline: shares.length === 1 ? "1 neue Firma aus der Organisation im Radar" : `${shares.length} neue Firmen aus der Organisation im Radar`,
        rationale: `Kolleginnen und Kollegen haben Firmen mit dir geteilt:\n${zeilen.join("\n")}${mehr}\n\nEntscheiden unter [Firmen → Radar](#/radar).`,
        sourceRef: `org-share:radar:${shares.map((x) => x.id).sort().join(",").slice(0, 400)}`,
      });
      if (alert) {
        broadcastAlertsChanged();
        try {
          notifications.notifyForAlert(alert);
        } catch {
          /* best-effort */
        }
      }
    },
  });




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
  _skillsTrustRef = skillsTrust;
  const skillStore = await initSkills(paths(), {
    // (skillStoreRef wird direkt nach der Initialisierung gesetzt, s. u.)
    evaluateGate: skillGate,
    trustStore: skillsTrust,
  }).catch((err: unknown) => {
    console.error(
      `[skills] Initialisierung fehlgeschlagen: ${err instanceof Error ? err.message : String(err)}`,
    );
    return null;
  });
  skillStoreRef = skillStore;
  // v0.1.236 — backfill the lazy ref used by the skill_*-tools.
  _skillStoreRef = skillStore;
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
  function toSkillRow(s: import("../main/skills").LoadedSkill): SkillRow {
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
    windows().broadcast("skills:changed");
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
















  /** Open-file dialog wrapper so the renderer can stay browser-shaped
   *  and not need raw fs paths. Returns the path on accept, null on
   *  cancel. Filters to .zip and .md so the user can't pick noise. */


  // v0.1.365 — Speicher-Übersicht + Bereinigung (Settings → Speicher).
  // Hauptursache volllaufender Platten: alte Ollama-Modelle in
  // ~/.ollama/models, die über AVA-Versionen hinweg veralten und nie
  // aufgeräumt werden. Das Panel schlüsselt alle Ordner auf und erlaubt
  // gezieltes + automatisches Löschen (aktives/erforderliches Modell
  // immer geschützt).
  const storageDeps = (): import("../main/storage-usage").StorageDeps => ({
    ollama,
    whisper,
    providerStore: ProviderConfigStore.shared(),
  });








  producerLogBuffer.on("line", (event: ProducerLogEvent) => {
    windows().broadcast("producer-log:line", event);
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








  // Claude-Abo-OAuth wurde entfernt — keine Anthropic-Subscription-IPC
  // mehr (set/validate/clear/setAuthMode/connect). Anthropic läuft nur
  // noch per API-Key über die normale Key-IPC.

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
      orgOpenai: researchStore.hasOrgOpenai(),
      providerLock: providers.isProviderLocked(),
      researchModel: getOrgPolicy().researchModel ?? null,
    };
  }


  // ---- Sprachmodus (docs/PLAN_SPRACHMODUS.md) -----------------------------
  const spracheStore = SpracheStore.shared();
  const spracheRelay = new SpracheRelay(
    agent,
    (e) => windows().broadcast("sprache:ergebnis", e),
    (f) => windows().broadcast("sprache:fortschritt", f),
    (name) => agentRegistry.get(name)?.summary ?? name,
  );
  const spracheStand = () => {
    const q = providers.keySource("openai");
    const orgHat = Boolean(providers.getOrgProviders().openai);
    const eigenHat = providers.hasKey("openai");
    const verfuegbar = q === "organisation" ? orgHat : eigenHat || orgHat;
    const quelle: "eigen" | "organisation" | null = !verfuegbar ? null : q === "organisation" || !eigenHat ? "organisation" : "eigen";
    return { einstellungen: spracheStore.get(), verfuegbar, quelle, whisperBereit: whisper.getStatus().state === "ready" };
  };
  spracheStore.on("changed", () => {
    windows().broadcast("sprache:standChanged", spracheStand());
  });










  // Push bundle updates to all renderer windows when config/keys change.
  // Keeps Settings UI live-synced if another window (or future CLI tool)
  // mutates it.
  const broadcastResearchBundle = () => {
    const bundle = researchBundle();
    windows().broadcast("research:bundleChanged", bundle);
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

  // v0.1.424 — Publikations-Analyse-Modus (PB1). IPC + Restart-on-Change
  // nach exakt dem Research-Muster: Aenderung -> debounced Neustart des
  // company-publication-Producers, damit extraEnvAsync den frischen
  // AVA_PUBLICATION_ANALYSIS-Wert liefert.
  // Phase 3 Firmen-Discovery (PLAN_FIRMEN_DISCOVERY.md) — Radar-IPC
  // fuer die Kandidaten-Tabelle: Liste (mit lokalen Match-Scores),
  // Bulk-Entscheidung (Import/Ignorieren), Match-Lauf.
  // v0.1.646 — Nutzerstand + Faehigkeitsliste (Chat-Vorschlaege, V1).
  nutzerstand = new NutzerstandService({
    angemeldet: () => auth.getStatus().signedIn,
    gatewayRequest: (path) => gatewayClient.request(path),
    mailVerbunden: async () => (mailSupervisor ? (await mailSupervisor.snapshot()).account !== null : false),
    telegramVerbunden: () => telegramStore.hasToken() && telegramStore.getConfig().chatId !== null,
    crmStatus: () => crmManager.getAllStatuses().map((c) => ({ provider: String(c.provider), connected: c.connected })),
    knowledgeStatus: () => KnowledgeProviderStore.shared().snapshot().providers.map((p) => ({ kind: String(p.kind), connected: p.connected })),
    linkedinAktiv: () => readLinkedInSettings().enabled,
    icp: () => ({ gesetzt: icpStore.isSet(), vollstaendig: icpStore.isComplete() }),
    radarConfig: () => {
      const c = radarSupervisor?.getConfig();
      return { enabled: c?.enabled ?? false, lastRunAt: c?.lastRunAt ?? null };
    },
    matches: () => discoveryMatches.getAll(),
    workflows: () => workflowService?.list() ?? [],
    skillsEigene: () => skillStoreRef?.list().length ?? 0,
    watchlistAnzahl: async () => (watchlistStore ? (await watchlistStore.list()).length : 0),
    emailAbleitungAktiv: () => emailMuster?.getConfig().enabled ?? false,
    modell: () => {
      const s = providers.getStatus();
      return { ready: s.ready, kind: s.kind ?? null, model: s.model, sStufe: s.model ? pruefeModellstufe(String(s.kind), s.model).erlaubt : false };
    },
    tier: () => getTenantTierCached(),
    featureAn: (key) => featureEnabled(key as never),
    featureKeys: () => ORG_FEATURES.map((f) => f.key),
    organisation: () => (auth.getStatus().tenantId ?? "").startsWith("org_"),
  });
  // v0.1.647 (V2) — Chips fuer die Startseite: KI ueber Hintergrundkanal, gecacht, feste Rueckfalliste.
  chipErzeugung = new ChipErzeugung({
    providers,
    nutzerstand: () => nutzerstand!.get(),
    toolNamen: () => agentRegistry.list().map((t) => t.name),
    dir: join(paths().get("userData"), "suggestions"),
    log: (m) => console.log(m),
  });
  vorschlaegeSettings = new VorschlaegeSettingsStore(join(paths().get("userData"), "suggestions"));
  // Register-Delta S6 — Mithelfen: Kindprozess mit @ava/register-delta, Opt-in.
  mithelfen = new MithelfenSupervisor({
    userDataDir: paths().get("userData"),
    resourcesRoot: paths().isPackaged ? (paths().resources() ?? "") : join(paths().appPath(), "resources"),
    gatewayUrl: APP_CONFIG.gatewayUrl,
    getAccessToken: () => auth.getAccessToken(),
    getActorId: () => auth.getStatus().actorId ?? null,
    settings: new MithelfenSettingsStore(join(paths().get("userData"), "register-delta")),
    browserPfad: () => eigenerBrowser?.browserPfad() ?? null,
    treiberVerzeichnis: () => eigenerBrowser?.treiberVerzeichnis() ?? null,
  });
  mithelfen.on("status", (st) => {
    windows().broadcast("register-delta:status:changed", st);
  });
  auth.on("status", (st: AuthStatus) => mithelfen?.setSignedIn(Boolean(st.signedIn)));
  mithelfen.setSignedIn(Boolean(auth.getStatus().signedIn));
  mithelfen.on("verlauf", (v) => {
    windows().broadcast("register-delta:verlauf:changed", v);
  });
  radarActivity.on("changed", (state) => {
    windows().broadcast("discovery:activity:changed", state);
  });
  // §8b — Token-Aenderung muss den company-contact-Producer recyceln,
  // damit extraEnvAsync das frische APIFY_TOKEN-env injiziert (gleiches
  // Muster wie der publication-Analyse-Modus).
  const cycleCompanyContact = (): void => {
    const cc = producers.find(
      (p) => p.getStatus().name === "company-contact",
    );
    if (!cc) return;
    const st = cc.getStatus().state;
    if (st === "idle" || st === "stopping") return;
    console.info("[watchlist-key] Token geaendert — cycle company-contact");
    void (async () => {
      try {
        await cc.stop();
      } catch (err) {
        console.warn("[watchlist-key] stop() failed:", err);
      }
      if (!auth.getStatus().signedIn) return;
      try {
        await cc.start();
      } catch (err) {
        console.error("[watchlist-key] start() rejected:", err);
      }
    })();
  };
  recycleCompanyContactRef = cycleCompanyContact;

  // I2 ICP-Assistent — URL-Analyse ("deine Website + deine 5 besten
  // Kunden"). Fortschritt streamt per icpAssistant:progress an das
  // aufrufende Fenster; das Ergebnis ist NUR ein Entwurf (B6 — der
  // Review-Screen speichert explizit ueber discovery:setIcp).
  let icpAnalysisRunning = false;

  // ---- W1 Workflows -----------------------------------------------------------
  const wf = (): WorkflowService => {
    if (!workflowService) throw new Error("Workflows noch nicht initialisiert.");
    return workflowService;
  };


  let publicationRestartTimer: NodeJS.Timeout | null = null;
  publicationStore.on("changed", () => {
    if (publicationRestartTimer) clearTimeout(publicationRestartTimer);
    publicationRestartTimer = setTimeout(() => {
      publicationRestartTimer = null;
      const pub = producers.find(
        (p) => p.getStatus().name === "company-publication",
      );
      if (!pub) return;
      const st = pub.getStatus().state;
      if (st === "idle" || st === "stopping") return;
      console.info(
        "[publication-store] Modus geaendert — cycle company-publication",
      );
      void (async () => {
        try {
          await pub.stop();
        } catch (err) {
          console.warn("[publication-store] stop() failed:", err);
        }
        if (!auth.getStatus().signedIn) return;
        try {
          await pub.start();
        } catch (err) {
          console.error("[publication-store] start() rejected:", err);
        }
      })();
    }, 500);
  });

  // Claude-Abo-OAuth (connectAnthropicSubscription) wurde entfernt.









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


  // v0.1.412 — Telegram-Kanal.
  const telegramSnapshot = (): TelegramSnapshot => ({
    config: telegramStore.getConfig(),
    hasToken: telegramStore.hasToken(),
    encryptionAvailable: telegramStore.isEncryptionAvailable(),
    pendingCount: telegramChannel.pendingCount(),
    zustand: telegramChannel.zustand(),
  });
  /** Token speichern + sofort per getMe validieren. Gibt NIE den Token zurück. */
  /**
   * Chat-ID automatisch ermitteln: liest eingehende Nachrichten des Bots.
   * Der Nutzer schickt dem Bot einfach „/start" — kein Suchen numerischer IDs.
   */
  /** Testnachricht — der sichtbare Beweis, dass die Verbindung steht. */
  // Limit-Änderung über den Chat-Tool-Pfad (settings_set_daily_token_limit)
  // läuft über setConfig → configChanged. Hier an alle Fenster spiegeln.
  ProviderConfigStore.shared().on("configChanged", () => {
    void broadcastDailyLimitStatus();
  });
  void usageStore
    .purgeExpired()
    .then((n) => {
      if (n > 0)
        console.info(`[usage] startup retention sweep removed ${n} expired event(s)`);
    })
    .catch((err) =>
      console.warn("[usage] startup retention sweep failed:", err),
    );
  if (usagePurgeTimer) clearInterval(usagePurgeTimer);
  usagePurgeTimer = setInterval(() => {
    void usageStore
      .purgeExpired()
      .then((n) => {
        if (n > 0)
          console.info(`[usage] daily retention sweep removed ${n} expired event(s)`);
      })
      .catch((err) =>
        console.warn("[usage] daily retention sweep failed:", err),
      );
  }, RETENTION_INTERVAL_MS);

  // v0.1.224 — Knowledge-Integrations IPC (Phase 1: read-only Status).
  //
  // P1 ist Foundation: das Framework existiert, aber noch keine
  // Adapter sind angeschlossen. Renderer kann den Snapshot abfragen,
  // sieht "alle Provider disconnected". Connect/disconnect-IPCs kommen
  // mit P2 (Notion-Adapter), wenn es überhaupt etwas zu verbinden gibt.
  const knowledgeStore = KnowledgeProviderStore.shared();
  // Singleton — `knowledgeManager` wurde oben bereits angelegt.
  const knowledge = knowledgeManager;
  knowledgeStore.on("statusChanged", () => {
    windows().broadcast("knowledge:snapshotChanged", knowledgeStore.snapshot());
  });










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


  /** Hintergrunddienste starten; die Hülle ruft es nach dem Fenster auf. */
  async function startBackground(): Promise<void> {

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

    // Worker-Modus (docs/PLAN_WORKER_MODUS.md): AVA arbeitet dann nur noch
    // Handelsregister-Jobs ab. Alles, was von selbst wiederkehrt, meldet sich
    // hier an; der Modus haelt es an und laesst es beim Ausschalten wieder an.
    // Nicht angemeldet und deshalb weiter aktiv: Anmeldung (Mithelfen braucht
    // den Token), Mithelfen selbst, Aktualisierung der App, Wachhund und die
    // Aufraeumlaeufe, die nur einmal am Tag laufen.
    // Synchron schreiben: Blockiert ein Dienst die Ereignisschleife, waere eine
    // gepufferte Zeile verloren und man wuesste nicht, welcher es war.
    workerModus.protokoll((zeile) => writeLineSync("INFO ", `[worker-modus] ${zeile}`));
    if (process.env.AVA_MCP_RELAIS !== "0") mcpRelais.start();
  workerModus.anmelden({ name: "MCP-Relais", anhalten: () => mcpRelais.stop(), anlaufen: () => mcpRelais.start(), darfLaufen: () => process.env.AVA_MCP_RELAIS !== "0" });
  workerModus.anmelden({ name: "Herzschlag", anhalten: () => heartbeat.stop(), anlaufen: () => heartbeat.start() });
    // 2026-09-18 — Nachgezogen, damit im Worker-Modus wirklich keine Kosten
    // entstehen koennen: Der LinkedIn-Zeitplan startet Feed-Scans von selbst, und
    // der Telegram-Eingang kann ueber eine eingehende Nachricht den Agenten
    // anstossen. Beides sind Hintergrundwege, die ohne Zutun Geld kosten.
    workerModus.anmelden({
      name: "LinkedIn-Zeitplan",
      anhalten: () => stopLinkedInScheduler(),
      anlaufen: () => startLinkedInScheduler(),
      darfLaufen: () => featureEnabled("linkedin.beobachter"),
    });
    workerModus.anmelden({
      name: "Telegram-Eingang",
      anhalten: () => telegramInbound?.stop(),
      anlaufen: () => telegramInbound?.sync(),
      darfLaufen: () => featureEnabled("telegram"),
    });
    workerModus.anmelden({ name: "Wiederholungen", anhalten: () => retryTicker.stop(), anlaufen: () => retryTicker.start() });
    workerModus.anmelden({
      name: "Auffrischung",
      anhalten: () => freshness.stop(),
      anlaufen: () => freshness.start(),
      darfLaufen: () => freshnessPrefs.get().enabled,
    });
    workerModus.anmelden({ name: "Nachlauf haengender Schritte", anhalten: () => stopPeriodicResumeSweep(), anlaufen: () => startPeriodicResumeSweep() });
    workerModus.anmelden({
      name: "Producer",
      anhalten: () => {
        for (const p of producers) void p.stop();
      },
      // Wiederanlauf ueber denselben Weg wie der Verarbeitungs-Schalter: die
      // Sign-in-Logik beachtet Anmeldung, Pause und Erreichbarkeit.
      anlaufen: () => broadcastAuthStatus(auth.getStatus()),
      darfLaufen: () => !processingControl.isPaused(),
    });
    // Stand aus den Einstellungen herstellen: bei aktivem Worker-Modus faellt
    // gleich nach dem Start alles wieder in Ruhe, was oben angelaufen ist.
    //
    // Zwei Vorkehrungen aus dem Vorfall vom 2026-09-18 (v0.1.678 startete im
    // Worker-Modus nicht mehr; die App hing, der Wachhund startete sie endlos neu
    // und der Schalter war nur noch von aussen in der Einstellungsdatei
    // erreichbar):
    //   1. Erst anwenden, wenn die App oben ist. Der Start darf davon nie abhaengen.
    //   2. Ein Merker haelt fest, dass gerade im Worker-Modus gestartet wird. Steht
    //      er beim naechsten Start noch da, ist der letzte Versuch gescheitert:
    //      dann startet AVA ohne den Modus und schaltet ihn in den Einstellungen ab.
    // Merker: "Es wird gerade versucht, den Worker-Modus anzuwenden." Bleibt er
    // liegen, hat die App den Versuch nicht ueberlebt. Wird beim Start UND beim
    // Einschalten gesetzt, damit ein Absturz in beiden Faellen erkannt wird.
    workerModusMerkerPfad = join(paths().get("userData"), "worker-modus-start.flag");
    const workerModusMerker = workerModusMerkerPfad;
    if (mithelfen?.status().nurRegister === true) {
      let letzterStartGescheitert = false;
      try {
        letzterStartGescheitert = existsSyncMain(workerModusMerker);
      } catch {
        /* Merker nicht lesbar: dann eben starten */
      }
      if (letzterStartGescheitert) {
        writeLineSync("WARN ", "[worker-modus] Der letzte Start im Worker-Modus ist gescheitert — Modus wird abgeschaltet.");
        try {
          rmSyncMain(workerModusMerker, { force: true });
        } catch {
          /* egal */
        }
        mithelfen?.setSettings({ nurRegister: false });
        windows().broadcast("register-delta:status:changed", mithelfen?.status());
      } else {
        setTimeout(() => {
          workerModusMerkerSetzen();
          void workerModus
            .setzen(true)
            .catch((err) => writeLineSync("WARN ", `[worker-modus] Anwenden fehlgeschlagen: ${err instanceof Error ? err.message : String(err)}`))
            .finally(() => {
              // Die App hat den Modus ueberstanden: Merker weg, damit der naechste
              // Start ihn nicht faelschlich als Absturz wertet.
              workerModusMerkerLoeschen();
            });
        }, 5000).unref?.();
      }
    }


  }

  return {
    APP_CONFIG,
    GATEWAY_URL,
    agent,
    agentRegistry,
    alertPrefs,
    alerts,
    apifyZugangInfo,
    attachments,
    audit,
    auditStore,
    auth,
    autonomyStore,
    broadcastAlertsChanged,
    broadcastDailyLimitStatus,
    broadcastMailSnapshot,
    broadcastMissingProducers,
    broadcastWatchesChanged,
    computeDailyLimitStatus,
    crmManager,
    customerProfiles,
    cycleCompanyContact,
    discoveryMatches,
    externalServiceMonitor,
    freshness,
    freshnessPrefs,
    gatewayClient,
    generalMemory,
    getTenantTierCached,
    heartbeat,
    hintergrundAufgaben,
    icpStore,
    interest,
    knowledge,
    knowledgeStore,
    memory,
    memoryProbe,
    notifications,
    ollama,
    ollamaUpdater,
    postgres,
    producers,
    providerConfigStore,
    providers,
    publicationStore,
    registerQueueStatus,
    researchBundle,
    researchStore,
    resolveApifyAccess,
    retryTicker,
    selfCorrectionsStore,
    skillStore,
    skillsPrefs,
    skillsTrust,
    spracheRelay,
    spracheStand,
    spracheStore,
    statusWatcher,
    storageDeps,
    telegramSnapshot,
    telegramStore,
    toSkillRow,
    updater,
    usageStore,
    userProfile,
    watchStore,
    wf,
    whisper,
    workerModusMerkerLoeschen,
    workerModusMerkerSetzen,
    chipErzeugung: { get current() { return chipErzeugung; } },
    eigenerBrowser: { get current() { return eigenerBrowser; } },
    emailMuster: { get current() { return emailMuster; } },
    icpAnalysisRunning: { get current() { return icpAnalysisRunning; }, set current(v: boolean) { icpAnalysisRunning = v; } },
    linkMonitorSupervisor: { get current() { return linkMonitorSupervisor; } },
    mailSupervisor: { get current() { return mailSupervisor; } },
    mithelfen: { get current() { return mithelfen; } },
    nutzerstand: { get current() { return nutzerstand; } },
    personenRadarStore: { get current() { return personenRadarStore; } },
    personenRadarSupervisor: { get current() { return personenRadarSupervisor; } },
    profileWorker: { get current() { return profileWorker; } },
    radarAlertEmitter: { get current() { return radarAlertEmitter; } },
    radarSupervisor: { get current() { return radarSupervisor; } },
    scheduledJobsSupervisor: { get current() { return scheduledJobsSupervisor; } },
    vorschlaegeSettings: { get current() { return vorschlaegeSettings; } },
    watchlistKeyStore: { get current() { return watchlistKeyStore; } },
    watchlistStore: { get current() { return watchlistStore; } },
    watchlistSupervisor: { get current() { return watchlistSupervisor; } },
    mcpRelais,
    startBackground,
  };
}

export type Core = Awaited<ReturnType<typeof bootstrapCore>>;

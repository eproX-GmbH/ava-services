import type { GatewayClient } from "../gateway-client";
import type { LlmProviderManager } from "../providers";
import type { GeneralMemoryStore } from "../general-memory";
import type { AttachmentStore } from "../attachment-store";
import type { AlertsStore } from "../alerts-store";
import type { AlertPrefsStore } from "../alert-prefs-store";
import type { Heartbeat } from "../heartbeat";
import type { FreshnessScheduler } from "../freshness-scheduler";
import type { FreshnessPrefsStore } from "../freshness-prefs-store";
import type { UserProfileStore } from "../profile-store";
import type { WatchStore } from "../watch-store";
import type { CrmManager } from "../../crm";
import type { OllamaSupervisor } from "../../ollama-supervisor";
import type { WhisperSidecar } from "../../voice/whisper-sidecar";
import type { Updater } from "../../updater";
import type { ExternalServiceMonitor } from "../../external-service-monitor";
import type { ProducerSupervisor } from "../../producer-supervisor";
import type { ProducerLogLine } from "../../../shared/types";
import type { MemoryStore } from "../memory";
import { ToolRegistry } from "../tool-registry";
import { buildCompanyTools } from "./companies";
import { buildTransactionTools } from "./transactions";
import { buildEvaluationTools } from "./evaluations";
import { buildUiTools } from "./ui";
import { buildSettingsTools } from "./settings";
import { buildMemoryTools } from "./memory";
import { buildImportTools } from "./imports";
import { buildAlertsTools } from "./alerts";
import { buildFreshnessTools } from "./freshness";
import { buildProfileTools } from "./profile";
import { buildWatchesTools } from "./watches";
import { buildCrmTools } from "./crm";
import { buildLinkedInTools } from "./linkedin";
import { buildOllamaTools } from "./ollama";
import { buildVoiceTools } from "./voice";
import { buildUpdaterTools } from "./updater";
import { buildReachabilityTools } from "./reachability";
import { buildProducerTools } from "./producers";
import { buildChatHistoryTools } from "./chat-history";
import { buildNotionTools } from "./notion";
import { buildObsidianTools } from "./obsidian";
import { buildSkillsTools } from "./skills";
import { buildMailTools } from "./mail";
import { buildSchedulerTools } from "./scheduler";
import { buildSelfCorrectionTools } from "./self-correction";
import type { MailSupervisor } from "../../mail/supervisor";
import type { ScheduledJobsSupervisor } from "../../scheduler/supervisor";
import type { SelfCorrectionsStore } from "../self-corrections-store";
import type { KnowledgeManager } from "../../knowledge/manager";
import type { SkillStore } from "../../skills/store";
import type { SkillsTrustStore } from "../../skills/trust-store";

// Tool factory.
//
// Phase 8.b: read-only proxies into the gateway.
// Phase 8.c: UI tools (askUser, navigate, notify).
// Phase 8.j: settings tools — provider switch + OpenAI key management.
// Phase 8.k10h: memory tools (recall_memory, remember) — long-term
//   facts the agent should look up across conversations. The "read-only"
//   name is now a slight misnomer (`remember` writes), but every other
//   write is still gated behind 8.e + Idempotency-Key — memory writes
//   are local-only, no gateway round-trip, so they live here.
// Phase 8.e (later): gateway writes with Idempotency-Key.
//
// Keeping the assembly here means main/index.ts only sees
// `buildReadOnlyRegistry(...)`.

export function buildReadOnlyRegistry(deps: {
  gateway: GatewayClient;
  providers: LlmProviderManager;
  generalMemory: GeneralMemoryStore;
  attachments: AttachmentStore;
  alerts: AlertsStore;
  alertPrefs: AlertPrefsStore;
  heartbeat: Heartbeat;
  freshness: FreshnessScheduler;
  freshnessPrefs: FreshnessPrefsStore;
  profile: UserProfileStore;
  watches: WatchStore;
  crm: CrmManager;
  /** Phase T2 — local-LLM management tools (`ollama_*`). */
  ollama: OllamaSupervisor;
  /** Phase T2 — voice / whisper.cpp setup tools (`voice_*`). */
  whisper: WhisperSidecar;
  /** Phase T2 — OTA updater tools (`updater_*`). */
  updater: Updater;
  /** Phase T3 — reachability monitor tools (`reachability_*`). */
  externalServiceMonitor: ExternalServiceMonitor;
  /** Phase T3 — producer-supervisor diagnostics tools (`producers_*`). */
  producers: ProducerSupervisor[];
  /** Phase T3 — producer log ring-buffer (`producers_logs_tail`). */
  producerLogBuffer: {
    tail: (producer: string, limit?: number) => ProducerLogLine[];
  };
  /** Phase T3 — chat-history tools (`chat_history_*`). Uses the same
   *  MemoryStore the `agent:listConversations` IPC handler reads. */
  memory: MemoryStore;
  /** Bearer-token getter for CRM tools that POST through the gateway
   *  (Phase T1: `crm_enrich_now` pushes the live HubSpot payload to
   *  the gateway cache endpoint). Same source as `auth.getAccessToken()`. */
  getBearer: () => Promise<string | null>;
  /** Gateway base URL — needed by `crm_enrich_now` for the cache POST. */
  gatewayUrl: string;
  /** Fired by the alerts tools after every mutation so the renderer's
   *  bell + /alerts list refresh live. main/index.ts wires this to the
   *  IPC `alerts:changed` broadcast. */
  onAlertsChanged: () => void;
  /** Fired by the freshness tools after a prefs mutation so the
   *  Settings panel re-syncs via `freshness:prefs-changed`. */
  onFreshnessPrefsChanged: () => void;
  /** Fired by the profile tools after every mutation so Settings +
   *  the system-prompt builder re-read. */
  onProfileChanged: () => void;
  /** Fired by the watch tools after every mutation so the topbar chip
   *  + Settings panel re-sync. */
  onWatchesChanged: () => void;
  /** v0.1.225 — Knowledge-Integrations (Notion in P2, Obsidian in P3). */
  knowledge: KnowledgeManager;
  /** v0.1.236 — Self-Authoring Skills (Knowledge P4). Lazy-Getter weil
   *  die SkillStore-Instanz erst nach dem Registry-Build im Boot
   *  konstruiert wird (initSkills ist async). */
  getSkillStore: () => SkillStore | null;
  getSkillsTrust: () => SkillsTrustStore | null;
  skillsUserDir: string;
  /** v0.1.257 — Mail-Supervisor für die Mail-Tools (Phase 9.m). Lazy-Getter
   *  weil der Supervisor möglicherweise erst nach dem Registry-Build
   *  hochfährt (Konto nicht konfiguriert → Supervisor steht idle). Wenn
   *  null, melden die Mail-Tools "Mail-Konto nicht konfiguriert". */
  getMailSupervisor: () => MailSupervisor | null;
  /** v0.1.267 — ScheduledJobsSupervisor für wiederkehrende Aktionen
   *  (Phase S). Lazy-Getter analog Mail. */
  getScheduledJobsSupervisor: () => ScheduledJobsSupervisor | null;
  /** v0.1.284 — Self-Correction-Reporting-Store. */
  selfCorrectionsStore: SelfCorrectionsStore;
  /** Aktive Conversation-ID, vom Orchestrator gesetzt. */
  getActiveConversationId: () => string | null;
}): ToolRegistry {
  const registry = new ToolRegistry();
  const ctx = { gateway: deps.gateway };
  for (const t of buildCompanyTools(ctx)) registry.register(t);
  for (const t of buildTransactionTools(ctx)) registry.register(t);
  for (const t of buildEvaluationTools(ctx)) registry.register(t);
  for (const t of buildUiTools()) registry.register(t);
  for (const t of buildSettingsTools({ providers: deps.providers }))
    registry.register(t);
  for (const t of buildMemoryTools({ generalMemory: deps.generalMemory }))
    registry.register(t);
  for (const t of buildNotionTools({ knowledge: deps.knowledge }))
    registry.register(t);
  for (const t of buildObsidianTools({ knowledge: deps.knowledge }))
    registry.register(t);
  for (const t of buildImportTools({
    gateway: deps.gateway,
    attachments: deps.attachments,
    crm: deps.crm,
  }))
    registry.register(t);
  for (const t of buildAlertsTools({
    alerts: deps.alerts,
    prefs: deps.alertPrefs,
    heartbeat: deps.heartbeat,
    onChanged: deps.onAlertsChanged,
  }))
    registry.register(t);
  for (const t of buildFreshnessTools({
    scheduler: deps.freshness,
    prefs: deps.freshnessPrefs,
    onPrefsChanged: deps.onFreshnessPrefsChanged,
  }))
    registry.register(t);
  for (const t of buildProfileTools({
    store: deps.profile,
    onChanged: deps.onProfileChanged,
  }))
    registry.register(t);
  for (const t of buildWatchesTools({
    store: deps.watches,
    onChanged: deps.onWatchesChanged,
  }))
    registry.register(t);
  // v0.1.261 Hotfix — Mail-Tools UNKONDITIONAL registrieren mit Lazy-
  // Getter. buildReadOnlyRegistry läuft VOR der MailSupervisor-Instan-
  // ziierung in main/index.ts, d.h. getMailSupervisor() würde hier
  // immer null liefern → Tools wären nie registriert. Jetzt registrieren
  // wir die Tools immer und prüfen Verfügbarkeit beim run().
  for (const t of buildMailTools({ getSupervisor: deps.getMailSupervisor }))
    registry.register(t);
  // v0.1.267 — Scheduler-Tools, gleiche Lazy-Getter-Logik.
  for (const t of buildSchedulerTools({
    getSupervisor: deps.getScheduledJobsSupervisor,
    getMailSupervisor: deps.getMailSupervisor,
  }))
    registry.register(t);
  // v0.1.284 — Self-Correction-Reporting (always-on Telemetrie).
  for (const t of buildSelfCorrectionTools({
    store: deps.selfCorrectionsStore,
    getActiveConversationId: deps.getActiveConversationId,
  }))
    registry.register(t);
  for (const t of buildCrmTools({
    crm: deps.crm,
    gateway: deps.gateway,
    getBearer: deps.getBearer,
    gatewayUrl: deps.gatewayUrl,
  }))
    registry.register(t);
  for (const t of buildLinkedInTools()) registry.register(t);
  for (const t of buildOllamaTools({ ollama: deps.ollama }))
    registry.register(t);
  for (const t of buildVoiceTools({ whisper: deps.whisper }))
    registry.register(t);
  for (const t of buildUpdaterTools({ updater: deps.updater }))
    registry.register(t);
  for (const t of buildReachabilityTools({ monitor: deps.externalServiceMonitor }))
    registry.register(t);
  for (const t of buildProducerTools({
    producers: deps.producers,
    logBuffer: deps.producerLogBuffer,
  }))
    registry.register(t);
  for (const t of buildChatHistoryTools({ memory: deps.memory }))
    registry.register(t);
  for (const t of buildSkillsTools({
    getSkillStore: deps.getSkillStore,
    getTrustStore: deps.getSkillsTrust,
    userDir: deps.skillsUserDir,
    availableTools: () => registry.list().map((tool) => tool.name),
  }))
    registry.register(t);
  return registry;
}

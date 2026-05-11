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
  for (const t of buildCrmTools({
    crm: deps.crm,
    gateway: deps.gateway,
    getBearer: deps.getBearer,
    gatewayUrl: deps.gatewayUrl,
  }))
    registry.register(t);
  for (const t of buildLinkedInTools()) registry.register(t);
  return registry;
}

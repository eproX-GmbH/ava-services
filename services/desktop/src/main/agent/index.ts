// Public surface for the agent module — main/index.ts only ever pulls
// from here so the internal layout (ollama-client, prompts, types) can be
// rearranged without touching IPC wiring.

export { AgentOrchestrator } from "./orchestrator";
export type { AgentOrchestratorOptions } from "./orchestrator";
export { ToolRegistry } from "./tool-registry";
export type { Tool, ToolContext, OllamaToolSpec } from "./types";
export { GatewayClient } from "./gateway-client";
export { defineTool } from "./define-tool";
export { buildReadOnlyRegistry } from "./tools";
export { LlmProviderManager, ProviderConfigStore } from "./providers";
export type { KeyValidation } from "./providers";
export { MemoryStore } from "./memory";
export type { MemoryProbeResult, MemoryListEntry } from "./memory";
export { AttachmentStore } from "./attachment-store";
export type {
  StagedAttachment,
  StagedSheetSummary,
  StageAttachmentInput,
} from "./attachment-store";
export { GeneralMemoryStore } from "./general-memory";
export type {
  GeneralMemoryEntry,
  GeneralMemoryProbeResult,
} from "./general-memory";
export { AlertsStore } from "./alerts-store";
export type { AlertsProbeResult, AlertCreateInput } from "./alerts-store";
export { Heartbeat } from "./heartbeat";
export type {
  HeartbeatCandidate,
  HeartbeatOptions,
  Judge,
  CandidateSource,
  JudgeVerdict,
  TickInfo,
} from "./heartbeat";
export { buildLlmAlertJudge, JudgeProviderUnavailable } from "./alert-judge";
export { AlertPrefsStore } from "./alert-prefs-store";
export { buildRealCandidateSource } from "./real-candidate-source";
export { FreshnessScheduler } from "./freshness-scheduler";
export type { FreshnessSchedulerOptions } from "./freshness-scheduler";
export { FreshnessPrefsStore } from "./freshness-prefs-store";
export { FreshnessCursorStore } from "./freshness-cursor-store";
export type {
  FreshnessCursor,
  InFlightEntry,
} from "./freshness-cursor-store";
export { InterestStore } from "./interest-store";
export { UserProfileStore } from "./profile-store";
export { WatchStore } from "./watch-store";
export type { WatchCreateInput } from "./watch-store";
export { WatchExecutor } from "./watch-executor";
export type { WatchExecutorOptions } from "./watch-executor";
export type {
  LlmProvider,
  LlmProviderKind,
  LlmProviderStatus,
  ProviderConfig,
} from "./providers";

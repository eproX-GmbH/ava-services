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
export type {
  LlmProvider,
  LlmProviderKind,
  LlmProviderStatus,
  ProviderConfig,
} from "./providers";

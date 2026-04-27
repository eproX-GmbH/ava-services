import type { GatewayClient } from "../gateway-client";
import type { LlmProviderManager } from "../providers";
import { ToolRegistry } from "../tool-registry";
import { buildCompanyTools } from "./companies";
import { buildTransactionTools } from "./transactions";
import { buildEvaluationTools } from "./evaluations";
import { buildUiTools } from "./ui";
import { buildSettingsTools } from "./settings";

// Tool factory.
//
// Phase 8.b: read-only proxies into the gateway.
// Phase 8.c: UI tools (askUser, navigate, notify).
// Phase 8.j: settings tools — provider switch + OpenAI key management.
// Phase 8.e (later): writes with Idempotency-Key.
// Keeping the assembly here means main/index.ts only sees
// `buildReadOnlyRegistry(...)`.

export function buildReadOnlyRegistry(deps: {
  gateway: GatewayClient;
  providers: LlmProviderManager;
}): ToolRegistry {
  const registry = new ToolRegistry();
  const ctx = { gateway: deps.gateway };
  for (const t of buildCompanyTools(ctx)) registry.register(t);
  for (const t of buildTransactionTools(ctx)) registry.register(t);
  for (const t of buildEvaluationTools(ctx)) registry.register(t);
  for (const t of buildUiTools()) registry.register(t);
  for (const t of buildSettingsTools({ providers: deps.providers }))
    registry.register(t);
  return registry;
}

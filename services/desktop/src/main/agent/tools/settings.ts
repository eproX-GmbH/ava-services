import * as yup from "yup";
import { defineTool } from "../define-tool";
import type { LlmProviderManager } from "../providers";
import type { Tool } from "../types";

// Settings tools (Phase 8.j).
//
// These are the agent's self-service surface for the provider switch.
// They map onto the LlmProviderManager 1:1, and exist as tools (not
// only IPC) because the user can request "switch me to OpenAI, here is
// my key" in chat — the model needs callable functions that perform the
// change atomically and report the resulting status.
//
// Security: the key arrives in chat as plaintext. We accept that risk
// because it's the same channel where the user typed it; once stored
// it's encrypted via safeStorage. The Settings → Agent panel (8.g) is
// the recommended UX, but the chat path stays open as the fallback.

export interface SettingsToolDeps {
  providers: LlmProviderManager;
}

export function buildSettingsTools(deps: SettingsToolDeps): Tool[] {
  const { providers } = deps;

  const getProvider = defineTool({
    name: "settings_get_provider",
    description:
      "Read the active LLM provider configuration. Use this BEFORE proposing a switch so you can confirm what's currently set.",
    parameters: { type: "object", properties: {} },
    schema: yup.object({}),
    run: async () => {
      const cfg = providers.getConfig();
      const status = providers.getStatus();
      return {
        kind: cfg.kind,
        ollamaModel: cfg.ollamaModel,
        openaiModel: cfg.openaiModel,
        ready: status.ready,
        hasOpenAiKey: providers.hasOpenAiKey(),
        encryptionAvailable: providers.isEncryptionAvailable(),
        errorMessage: status.errorMessage,
      };
    },
    preview: (r) =>
      `provider: ${r.kind}${r.ready ? "" : " (not ready)"}${
        r.kind === "openai" && !r.hasOpenAiKey ? " — key missing" : ""
      }`,
  });

  const setProvider = defineTool({
    name: "settings_set_provider",
    description:
      "Switch the active LLM provider. Pass `kind:'openai'` to use the cloud model (requires an API key set via `settings_set_openai_key`) or `kind:'ollama'` for the bundled local model. Optionally override the model tag.",
    parameters: {
      type: "object",
      properties: {
        kind: {
          type: "string",
          enum: ["ollama", "openai"],
          description: "Provider to make active.",
        },
        model: {
          type: "string",
          description:
            "Optional model tag override (e.g. 'qwen2.5:7b' for ollama, 'gpt-4o-mini' for openai).",
        },
      },
      required: ["kind"],
    },
    schema: yup.object({
      kind: yup.string().oneOf(["ollama", "openai"]).required(),
      model: yup.string().trim().optional(),
    }),
    run: async (args) => {
      const next = providers.setProvider(args.kind, { model: args.model });
      const status = providers.getStatus();
      return {
        kind: next.kind,
        model: status.model,
        ready: status.ready,
        errorMessage: status.errorMessage,
      };
    },
    preview: (r) =>
      `switched to ${r.kind}${r.model ? ` (${r.model})` : ""}${
        r.ready ? "" : " — not ready"
      }`,
  });

  const setKey = defineTool({
    name: "settings_set_openai_key",
    description:
      "Store the user's OpenAI API key. Encrypted at rest via the OS keychain (safeStorage). Call this BEFORE switching to the OpenAI provider. Never echo the key back in your reply.",
    parameters: {
      type: "object",
      properties: {
        apiKey: {
          type: "string",
          description: "The user's OpenAI API key (sk-…).",
        },
      },
      required: ["apiKey"],
    },
    schema: yup.object({
      apiKey: yup
        .string()
        .trim()
        .min(20, "API key looks too short")
        .matches(/^sk-/i, "OpenAI keys start with 'sk-'")
        .required(),
    }),
    run: async (args) => {
      providers.setOpenAiKey(args.apiKey);
      return {
        ok: true,
        encryptionAvailable: providers.isEncryptionAvailable(),
      };
    },
    // Mask the value entirely in the timeline preview — the args toggle
    // would still expose it, but `summarizeArgs` truncates at 80 chars
    // and the key is longer; either way the preview itself never carries it.
    preview: (r) =>
      r.encryptionAvailable
        ? "key stored (OS keychain)"
        : "key stored (basic cipher — keychain unavailable)",
  });

  const clearKey = defineTool({
    name: "settings_clear_openai_key",
    description:
      "Forget the stored OpenAI API key. If the OpenAI provider was active it auto-falls-back to the local Ollama model.",
    parameters: { type: "object", properties: {} },
    schema: yup.object({}),
    run: async () => {
      providers.clearOpenAiKey();
      return { kind: providers.getConfig().kind };
    },
    preview: (r) => `key cleared, now using ${r.kind}`,
  });

  return [getProvider, setProvider, setKey, clearKey];
}

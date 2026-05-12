import * as yup from "yup";
import { defineTool } from "../define-tool";
import type { LlmProviderManager } from "../providers";
import type { Tool } from "../types";
import type {
  HostedProviderKind,
  LlmProviderKind,
} from "../../../shared/types";

// Settings tools (Phase 8.j, expanded in 8.k1).
//
// These are the agent's self-service surface for the provider switch.
// They map onto the LlmProviderManager 1:1, and exist as tools (not
// only IPC) because the user can request "switch me to OpenAI, here is
// my key" in chat — the model needs callable functions that perform the
// change atomically and report the resulting status.
//
// 8.k1: tools generalised across all five hosted-or-local providers
// (ollama, openai, anthropic, google, mistral). The api-key tools take
// `{provider, apiKey}` so a single tool surface handles every vendor.
//
// Security: the key arrives in chat as plaintext. We accept that risk
// because it's the same channel where the user typed it; once stored
// it's encrypted via safeStorage. The Settings → Agent panel (8.g) is
// the recommended UX, but the chat path stays open as the fallback.

const ALL_KINDS: readonly LlmProviderKind[] = [
  "ollama",
  "openai",
  "anthropic",
  "google",
  "mistral",
];

const HOSTED_KINDS: readonly HostedProviderKind[] = [
  "openai",
  "anthropic",
  "google",
  "mistral",
];

/**
 * Per-vendor key-format hint. Kept loose on purpose — vendors rotate
 * formats and we'd rather store an unrecognised-but-valid key than
 * reject a legitimate one. The substring/prefix checks below catch the
 * obvious "user pasted the wrong thing" mistake without being strict
 * about exact length.
 */
function validateApiKey(provider: HostedProviderKind, key: string): void {
  if (key.length < 16) {
    throw new Error(`${provider} key looks too short`);
  }
  switch (provider) {
    case "openai":
      if (!/^sk-/i.test(key)) {
        throw new Error("OpenAI keys start with 'sk-'");
      }
      break;
    case "anthropic":
      if (!/^sk-ant-/i.test(key)) {
        throw new Error("Anthropic keys start with 'sk-ant-'");
      }
      break;
    case "google":
      // Google AI Studio keys typically start with "AIza" but the SDK
      // also accepts service-account tokens — leave the prefix as a
      // soft hint via the message rather than a hard reject.
      if (!/^[A-Za-z0-9_\-]{20,}$/.test(key)) {
        throw new Error("Google API key looks malformed");
      }
      break;
    case "mistral":
      // Mistral keys are opaque hex-ish tokens; just check shape.
      if (!/^[A-Za-z0-9_\-]{20,}$/.test(key)) {
        throw new Error("Mistral API key looks malformed");
      }
      break;
  }
}

export interface SettingsToolDeps {
  providers: LlmProviderManager;
}

export function buildSettingsTools(deps: SettingsToolDeps): Tool[] {
  const { providers } = deps;

  const getProvider = defineTool({
    name: "settings_get_provider",
    description:
      "Read the active LLM provider configuration plus per-provider key presence. Use this BEFORE proposing a switch so you can confirm what's currently set and which providers are usable.",
    parameters: { type: "object", properties: {} },
    schema: yup.object({}),
    run: async () => {
      const bundle = providers.getConfigBundle();
      return {
        kind: bundle.config.kind,
        models: bundle.config.models,
        ready: bundle.status.ready,
        model: bundle.status.model,
        hasKey: bundle.hasKey,
        encryptionAvailable: bundle.encryptionAvailable,
        errorMessage: bundle.status.errorMessage,
      };
    },
    preview: (r) => {
      const missing = HOSTED_KINDS.filter((k) => !r.hasKey[k]);
      const missingNote = missing.length > 0
        ? `, missing keys: ${missing.join(", ")}`
        : "";
      return `provider: ${r.kind}${r.ready ? "" : " (not ready)"}${missingNote}`;
    },
  });

  const setProvider = defineTool({
    name: "settings_set_provider",
    description:
      "Switch the active LLM provider. `kind` is one of 'ollama', 'openai', 'anthropic', 'google', 'mistral'. Hosted providers require their API key to be stored first via `settings_set_api_key`. Optionally override the model tag for the chosen provider.",
    parameters: {
      type: "object",
      properties: {
        kind: {
          type: "string",
          enum: [...ALL_KINDS],
          description: "Provider to make active.",
        },
        model: {
          type: "string",
          description:
            "Optional model id for this provider (e.g. 'llama3.2:3b', 'gpt-4o-mini', 'claude-sonnet-4-6', 'gemini-2.5-pro', 'mistral-large-latest').",
        },
      },
      required: ["kind"],
    },
    schema: yup.object({
      kind: yup.string().oneOf([...ALL_KINDS]).required(),
      model: yup.string().trim().optional(),
    }),
    run: async (args) => {
      const next = providers.setProvider(args.kind as LlmProviderKind, {
        model: args.model,
      });
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
        r.ready ? "" : " (not ready)"
      }`,
  });

  const setKey = defineTool({
    name: "settings_set_api_key",
    description:
      "Store the user's API key for a hosted provider. Encrypted at rest via the OS keychain (safeStorage). Call this BEFORE switching to that provider. Never echo the key back in your reply.",
    parameters: {
      type: "object",
      properties: {
        provider: {
          type: "string",
          enum: [...HOSTED_KINDS],
          description: "Hosted provider to store the key for.",
        },
        apiKey: {
          type: "string",
          description: "The user's API key for the chosen provider.",
        },
      },
      required: ["provider", "apiKey"],
    },
    schema: yup.object({
      provider: yup.string().oneOf([...HOSTED_KINDS]).required(),
      apiKey: yup.string().trim().min(16, "API key looks too short").required(),
    }),
    run: async (args) => {
      const provider = args.provider as HostedProviderKind;
      validateApiKey(provider, args.apiKey);
      providers.setApiKey(provider, args.apiKey);
      return {
        ok: true,
        provider,
        encryptionAvailable: providers.isEncryptionAvailable(),
      };
    },
    // Mask the value entirely in the timeline preview — the args toggle
    // would still expose it, but `summarizeArgs` truncates at 80 chars
    // and the key is longer; either way the preview itself never carries it.
    preview: (r) =>
      `${r.provider} key stored (${
        r.encryptionAvailable ? "OS keychain" : "basic cipher, keychain unavailable"
      })`,
  });

  const clearKey = defineTool({
    name: "settings_clear_api_key",
    description:
      "Forget the stored API key for a hosted provider. If that provider was active it auto-falls-back to the local Ollama model.",
    parameters: {
      type: "object",
      properties: {
        provider: {
          type: "string",
          enum: [...HOSTED_KINDS],
          description: "Hosted provider whose key should be cleared.",
        },
      },
      required: ["provider"],
    },
    schema: yup.object({
      provider: yup.string().oneOf([...HOSTED_KINDS]).required(),
    }),
    run: async (args) => {
      const provider = args.provider as HostedProviderKind;
      providers.clearApiKey(provider);
      return { provider, kind: providers.getConfig().kind };
    },
    preview: (r) => `${r.provider} key cleared, now using ${r.kind}`,
  });

  // ---- Phase A1 — Anthropic subscription auth tools -----------------------

  const setAnthropicSubscriptionToken = defineTool({
    name: "settings_set_anthropic_subscription_token",
    description:
      "Speichert einen Claude.ai-Subscription-OAuth-Token (vom `claude setup-token`-CLI erzeugt). Nutzt das Pro/Max-Abo des Nutzers statt Api-Credits. Der Token wird verschlüsselt im OS-Schlüsselbund abgelegt; gleichzeitig wird der Anthropic-Auth-Modus auf 'subscription' geschaltet. Niemals den Token in der Antwort wiedergeben.",
    parameters: {
      type: "object",
      properties: {
        token: {
          type: "string",
          description:
            "Der Subscription-Token, beginnend mit 'sk-ant-oat01-'.",
        },
      },
      required: ["token"],
    },
    schema: yup.object({
      token: yup
        .string()
        .trim()
        .min(30, "Token wirkt zu kurz")
        .required(),
    }),
    run: async (args) => {
      providers.setAnthropicSubscriptionToken(args.token);
      return {
        ok: true,
        provider: "anthropic" as const,
        authMode: "subscription" as const,
        encryptionAvailable: providers.isEncryptionAvailable(),
      };
    },
    preview: (r) =>
      `anthropic subscription token stored (${
        r.encryptionAvailable
          ? "OS keychain"
          : "basic cipher, keychain unavailable"
      })`,
  });

  const clearAnthropicSubscriptionToken = defineTool({
    name: "settings_clear_anthropic_subscription_token",
    description:
      "Entfernt den gespeicherten Anthropic-Subscription-OAuth-Token. Falls Subscription der aktive Anthropic-Auth-Modus war, wird auf 'api-key' zurückgeschaltet (sofern ein Api-Schlüssel hinterlegt ist) oder der aktive Provider auf Ollama gewechselt.",
    parameters: { type: "object", properties: {} },
    schema: yup.object({}),
    run: async () => {
      providers.clearAnthropicSubscriptionToken();
      return {
        ok: true,
        kind: providers.getConfig().kind,
        anthropicAuthMode:
          providers.getConfig().anthropicAuthMode ?? "api-key",
      };
    },
    preview: (r) =>
      `anthropic subscription token cleared, now using ${r.kind} (mode=${r.anthropicAuthMode})`,
  });

  return [
    getProvider,
    setProvider,
    setKey,
    clearKey,
    setAnthropicSubscriptionToken,
    clearAnthropicSubscriptionToken,
  ];
}

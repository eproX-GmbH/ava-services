import { EventEmitter } from "node:events";
import type { OllamaSupervisor } from "../../ollama-supervisor";
import { OllamaProvider } from "./ollama";
import { OpenAiProvider } from "./openai";
import { ProviderConfigStore, type ProviderConfig } from "./store";
import type {
  LlmProvider,
  LlmProviderKind,
  LlmProviderStatus,
  LlmStreamFrame,
  LlmStreamRequest,
} from "./types";

// LlmProviderManager (Phase 8.j).
//
// Holds both providers, picks the active one off the persisted config,
// and re-emits a unified status whenever EITHER the active provider's
// inner state OR the config changes.
//
// The orchestrator delegates `streamChat` to the manager rather than
// holding a provider directly — this lets the user flip provider
// mid-conversation (e.g. "switch to OpenAI" from a tool call) without
// the orchestrator caring.
//
// Switching contract:
//   - `setProvider("openai")` only succeeds if the OpenAI key is set.
//     We surface the failure via thrown Error so the calling tool can
//     report it back to the model.
//   - Switching does NOT abort the in-flight request. The orchestrator
//     captured a reference to the active provider when it started the
//     turn; the new provider only takes over on the next turn.

export class LlmProviderManager extends EventEmitter {
  private readonly store: ProviderConfigStore;
  private readonly ollama: OllamaProvider;
  private readonly openai: OpenAiProvider;
  /** Keeps current status so getStatus() is sync. */
  private status: LlmProviderStatus;

  constructor(supervisor: OllamaSupervisor) {
    super();
    this.store = ProviderConfigStore.shared();
    const cfg = this.store.getConfig();
    this.ollama = new OllamaProvider({
      supervisor,
      modelOverride: cfg.ollamaModel,
    });
    this.openai = new OpenAiProvider({
      model: cfg.openaiModel,
      getApiKey: () => this.store.getOpenAiKey(),
      onKeyChanged: (cb) => {
        this.store.on("keyChanged", cb);
        return () => this.store.off("keyChanged", cb);
      },
    });

    this.status = this.activeProvider().getStatus();

    // Re-emit downstream status whenever the chosen provider's status
    // moves OR the config selects a different provider.
    this.ollama.onStatusChanged(() => this.recompute());
    this.openai.onStatusChanged(() => this.recompute());
    this.store.on("configChanged", (next) => {
      this.ollama.setModelOverride(next.ollamaModel);
      this.openai.setModel(next.openaiModel);
      this.recompute();
    });
    this.store.on("keyChanged", () => this.recompute());
  }

  // ---- Public surface -------------------------------------------------------

  getStatus(): LlmProviderStatus {
    return { ...this.status };
  }

  getConfig(): ProviderConfig {
    return this.store.getConfig();
  }

  onStatusChanged(listener: (s: LlmProviderStatus) => void): () => void {
    const handler = (s: LlmProviderStatus): void => listener(s);
    this.on("status", handler);
    return () => this.off("status", handler);
  }

  /**
   * Flip the active provider. Validates preconditions (key present for
   * OpenAI) and persists. Throws on failure with a model-friendly message.
   */
  setProvider(
    kind: LlmProviderKind,
    overrides?: { model?: string },
  ): ProviderConfig {
    if (kind === "openai" && !this.store.hasOpenAiKey()) {
      throw new Error(
        "OpenAI API key is not set. Set it via `settings_set_openai_key` or the Settings → Agent panel before switching.",
      );
    }
    const patch: Partial<ProviderConfig> = { kind };
    if (overrides?.model) {
      if (kind === "ollama") patch.ollamaModel = overrides.model;
      else patch.openaiModel = overrides.model;
    }
    return this.store.setConfig(patch);
  }

  setOpenAiKey(plaintext: string): void {
    this.store.setOpenAiKey(plaintext);
  }

  clearOpenAiKey(): void {
    // If the user cleared the key while OpenAI was active, fall back to
    // Ollama so the agent stays usable. The model can prompt them to
    // re-enter on the next turn.
    const cfg = this.store.getConfig();
    this.store.clearOpenAiKey();
    if (cfg.kind === "openai") {
      this.store.setConfig({ kind: "ollama" });
    }
  }

  isEncryptionAvailable(): boolean {
    return this.store.isEncryptionAvailable();
  }

  hasOpenAiKey(): boolean {
    return this.store.hasOpenAiKey();
  }

  // ---- Streaming ------------------------------------------------------------

  /**
   * Returns the provider that should service the *next* turn. Captured
   * by the orchestrator before it starts streaming so a mid-turn switch
   * can't swap engines underneath an in-flight loop.
   */
  activeProvider(): LlmProvider {
    return this.store.getConfig().kind === "openai" ? this.openai : this.ollama;
  }

  async *streamChat(
    req: LlmStreamRequest,
  ): AsyncGenerator<LlmStreamFrame, void, void> {
    yield* this.activeProvider().streamChat(req);
  }

  dispose(): void {
    this.openai.dispose();
    this.removeAllListeners();
  }

  // ---- Internal -------------------------------------------------------------

  private recompute(): void {
    const next = this.activeProvider().getStatus();
    if (statusEqual(this.status, next)) return;
    this.status = next;
    this.emit("status", { ...next });
  }
}

function statusEqual(a: LlmProviderStatus, b: LlmProviderStatus): boolean {
  return (
    a.kind === b.kind &&
    a.model === b.model &&
    a.ready === b.ready &&
    a.errorMessage === b.errorMessage
  );
}

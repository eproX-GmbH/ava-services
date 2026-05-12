import { EventEmitter } from "node:events";
import { listCatalog, recommendedFor } from "@ava/ai-provider";
import type { CatalogEntry, CatalogProvider } from "@ava/ai-provider";
import type { OllamaSupervisor } from "../../ollama-supervisor";
import { AiSdkProvider } from "./ai-sdk-provider";
import { ProviderConfigStore } from "./store";
import {
  probeAnthropicSubscription,
  validateApiKey,
  type KeyValidation,
} from "./validate-key";
import type {
  AnthropicAuthMode,
  HostedProviderKind,
  LlmProviderKind,
  ProviderCatalogEntry,
  ProviderConfig,
} from "../../../shared/types";
import type {
  LlmProvider,
  LlmProviderStatus,
  LlmStreamFrame,
  LlmStreamRequest,
} from "./types";

// LlmProviderManager (Phase 8.j, expanded in 8.k1).
//
// Holds one `AiSdkProvider` per supported kind, picks the active one off
// the persisted config, and re-emits a unified status whenever EITHER
// the active provider's inner state OR the config changes.
//
// The orchestrator delegates `streamChat` to the manager rather than
// holding a provider directly — this lets the user flip provider
// mid-conversation (e.g. "switch to Anthropic" from a tool call) without
// the orchestrator caring.
//
// Switching contract:
//   - `setProvider(kind)` only succeeds for hosted providers if the key
//     is set. We surface the failure via thrown Error so the calling
//     tool can report it back to the model.
//   - Switching does NOT abort the in-flight request. The orchestrator
//     captured a reference to the active provider when it started the
//     turn; the new provider only takes over on the next turn.

const ALL_KINDS: readonly LlmProviderKind[] = [
  "ollama",
  "openai",
  "anthropic",
  "google",
  "mistral",
];

export class LlmProviderManager extends EventEmitter {
  private readonly store: ProviderConfigStore;
  private readonly providers: Record<LlmProviderKind, AiSdkProvider>;
  /** Keeps current status so getStatus() is sync. */
  private status: LlmProviderStatus;

  constructor(supervisor: OllamaSupervisor) {
    super();
    this.store = ProviderConfigStore.shared();

    // Build all five providers up-front. They're cheap (no I/O at
    // construction) and pre-wiring lets `setProvider()` flip without
    // touching the network or filesystem.
    const make = (kind: LlmProviderKind): AiSdkProvider =>
      new AiSdkProvider({
        kind,
        getModel: () => this.resolveModel(kind),
        getApiKey:
          kind === "ollama"
            ? async () => null
            : () => this.store.getKey(kind as HostedProviderKind),
        hasStoredKey:
          kind === "ollama"
            ? () => true
            : () => this.store.hasKey(kind as HostedProviderKind),
        onKeyChanged: (cb) => {
          const handler = (changedKind: HostedProviderKind): void => {
            // Only fire the per-provider listener when its own key moved.
            if (kind !== "ollama" && changedKind === kind) cb();
          };
          this.store.on("keyChanged", handler);
          return () => this.store.off("keyChanged", handler);
        },
        ...(kind === "ollama" ? { supervisor } : {}),
        // Phase A1 — Anthropic-only auth-mode resolvers. Other kinds
        // pass them through as undefined and fall back to the legacy
        // api-key path.
        ...(kind === "anthropic"
          ? {
              getAnthropicAuthMode: () =>
                this.store.getConfig().anthropicAuthMode ?? "api-key",
              getAnthropicSubscriptionToken: () =>
                this.store.getAnthropicSubscriptionToken(),
              hasStoredAnthropicSubscriptionToken: () =>
                this.store.hasAnthropicSubscriptionToken(),
              onAnthropicSubscriptionTokenChanged: (cb: () => void) => {
                this.store.on("anthropicSubscriptionTokenChanged", cb);
                return () =>
                  this.store.off("anthropicSubscriptionTokenChanged", cb);
              },
            }
          : {}),
      });

    this.providers = {
      ollama: make("ollama"),
      openai: make("openai"),
      anthropic: make("anthropic"),
      google: make("google"),
      mistral: make("mistral"),
    };

    this.status = this.activeProvider().getStatus();

    for (const kind of ALL_KINDS) {
      this.providers[kind].onStatusChanged(() => this.recompute());
    }
    this.store.on("configChanged", () => this.recompute());
    this.store.on("keyChanged", () => this.recompute());
    this.store.on("anthropicSubscriptionTokenChanged", () =>
      this.recompute(),
    );
  }

  // ---- Public surface -------------------------------------------------------

  getStatus(): LlmProviderStatus {
    return { ...this.status };
  }

  getConfig(): ProviderConfig {
    return this.store.getConfig();
  }

  /**
   * Active provider's key + model — Option D BYO-key passthrough.
   *
   * Returns null when:
   *   - no provider is configured (first-run wizard not done), or
   *   - the active provider is `ollama` (keyless local), or
   *   - the active provider's key is missing/unreadable.
   *
   * Producers fall back to their env-baked LLM in those cases. We
   * decrypt on demand each call so plaintext key material isn't held
   * in memory between dispatches.
   */
  async getActiveUserLlm(): Promise<{
    provider: string;
    key: string;
    model?: string;
  } | null> {
    const config = this.store.getConfig();
    const kind = config.kind;
    if (!kind || kind === "ollama") return null;
    // Phase A1 — BYO-key passthrough to producer subprocesses runs
    // against env-driven @ava/ai-provider. Subscription mode isn't
    // (yet) plumbed through the env shape, so when Anthropic is active
    // in subscription mode we behave as if no key were set — producers
    // fall back to their env-baked LLM. The chat agent (in-process)
    // keeps using the OAuth token correctly via streamChat above.
    if (
      kind === "anthropic" &&
      (config.anthropicAuthMode ?? "api-key") === "subscription"
    ) {
      return null;
    }
    const key = await this.store.getKey(kind as HostedProviderKind);
    if (!key) return null;
    const model = config.models?.[kind] || undefined;
    return { provider: kind, key, model };
  }

  /**
   * Project the persisted config + per-provider key presence + active
   * status into the IPC-shaped bundle the renderer (and Settings panel)
   * consume. Centralised so all surfaces see the same view.
   */
  getConfigBundle(): {
    config: ProviderConfig;
    status: LlmProviderStatus;
    hasKey: Record<LlmProviderKind, boolean>;
    hasAnthropicSubscriptionToken: boolean;
    encryptionAvailable: boolean;
  } {
    return {
      config: this.getConfig(),
      status: this.getStatus(),
      hasKey: this.store.hasAllKeys(),
      hasAnthropicSubscriptionToken:
        this.store.hasAnthropicSubscriptionToken(),
      encryptionAvailable: this.store.isEncryptionAvailable(),
    };
  }

  onStatusChanged(listener: (s: LlmProviderStatus) => void): () => void {
    const handler = (s: LlmProviderStatus): void => listener(s);
    this.on("status", handler);
    return () => this.off("status", handler);
  }

  /**
   * Flip the active provider. Validates preconditions (key present for
   * hosted providers) and persists. Throws on failure with a
   * model-friendly message.
   */
  setProvider(
    kind: LlmProviderKind,
    overrides?: { model?: string },
  ): ProviderConfig {
    if (kind === "anthropic") {
      // Phase A1 — either auth mode counts. The active mode is whatever
      // the user last saved (the store flips `anthropicAuthMode` when
      // either credential is set). We pick the available one if the
      // currently-configured mode has no credential yet.
      const hasKey = this.store.hasKey("anthropic");
      const hasToken = this.store.hasAnthropicSubscriptionToken();
      if (!hasKey && !hasToken) {
        throw new Error(
          `Anthropic credential is not set. Save an API key or a subscription token first via Settings → Provider or the chat tool.`,
        );
      }
      const mode = this.store.getConfig().anthropicAuthMode ?? "api-key";
      if (mode === "subscription" && !hasToken) {
        this.store.setConfig({ anthropicAuthMode: "api-key" });
      } else if (mode === "api-key" && !hasKey) {
        this.store.setConfig({ anthropicAuthMode: "subscription" });
      }
    } else if (kind !== "ollama" && !this.store.hasKey(kind as HostedProviderKind)) {
      throw new Error(
        `${labelFor(kind)} API key is not set. Save it first via the Settings → Provider tab or the chat tool.`,
      );
    }
    const patch: { kind: LlmProviderKind; models?: Partial<Record<LlmProviderKind, string>> } = {
      kind,
    };
    if (overrides?.model !== undefined) {
      patch.models = { [kind]: overrides.model };
    }
    return this.store.setConfig(patch);
  }

  /**
   * Update the model for a specific provider without flipping the active
   * one. Used by the model dropdown in Settings.
   */
  setModel(kind: LlmProviderKind, model: string): ProviderConfig {
    return this.store.setConfig({ models: { [kind]: model } });
  }

  setApiKey(kind: HostedProviderKind, plaintext: string): void {
    this.store.setKey(kind, plaintext);
    // Phase A1 — match the subscription-side "most recently saved
    // wins" UX. Saving the Anthropic API key flips the active auth
    // mode back to "api-key".
    if (kind === "anthropic") {
      this.store.setConfig({ anthropicAuthMode: "api-key" });
    }
  }

  /**
   * Validate a hosted-provider API key against the provider's cheapest
   * auth-checked endpoint (usually `GET /v1/models`). Does NOT persist
   * — callers (the FirstRunWizard skip flow, the Settings panel) decide
   * what to do based on the result. See validate-key.ts for the exact
   * probes and rationale.
   */
  validateApiKey(
    kind: HostedProviderKind,
    apiKey: string,
  ): Promise<KeyValidation> {
    return validateApiKey(kind, apiKey);
  }

  clearApiKey(kind: HostedProviderKind): void {
    // If we're clearing the key for the ACTIVE provider, demote to
    // ollama so the agent stays usable. The user/model can prompt for
    // a fresh key later.
    const cfg = this.store.getConfig();
    this.store.clearKey(kind);
    if (cfg.kind === kind) {
      // Phase A1 — for Anthropic, if a subscription token is still
      // around, prefer keeping the user on Anthropic via subscription
      // rather than dropping all the way back to Ollama.
      if (
        kind === "anthropic" &&
        this.store.hasAnthropicSubscriptionToken()
      ) {
        this.store.setConfig({ anthropicAuthMode: "subscription" });
        return;
      }
      this.store.setConfig({ kind: "ollama" });
    }
  }

  // ---- Anthropic subscription token (Phase A1) -----------------------------

  hasAnthropicSubscriptionToken(): boolean {
    return this.store.hasAnthropicSubscriptionToken();
  }

  getAnthropicSubscriptionToken(): Promise<string | null> {
    return this.store.getAnthropicSubscriptionToken();
  }

  /**
   * Validate a candidate Anthropic OAuth subscription token. Same
   * contract as `validateApiKey` but probes the Bearer-auth path. Does
   * NOT persist — callers decide what to do with the result.
   */
  validateAnthropicSubscriptionToken(token: string): Promise<KeyValidation> {
    const trimmed = token.trim();
    if (trimmed.length === 0) {
      return Promise.resolve({ ok: false, reason: "Token ist leer." });
    }
    if (trimmed.length < 30) {
      return Promise.resolve({
        ok: false,
        reason: "Token wirkt zu kurz (erwartet ≥ 30 Zeichen).",
      });
    }
    if (!/^sk-ant-oat01-/i.test(trimmed)) {
      return Promise.resolve({
        ok: false,
        reason:
          "Token sollte mit 'sk-ant-oat01-' beginnen (vom `claude setup-token`-CLI erzeugt).",
      });
    }
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), 4_000);
    return probeAnthropicSubscription(trimmed, ctrl.signal)
      .catch((err: unknown) => {
        if (err instanceof Error && err.name === "AbortError") {
          return {
            ok: false as const,
            reason: "Zeitüberschreitung nach 4 s. Netzwerk prüfen.",
          };
        }
        return {
          ok: false as const,
          reason: `Netzwerkfehler: ${err instanceof Error ? err.message : String(err)}`,
        };
      })
      .finally(() => clearTimeout(timer));
  }

  /**
   * Persist a candidate Anthropic subscription token. Mirrors
   * `setApiKey` semantics but writes into the parallel
   * `anthropic-subscription.enc` blob so the API-key entry stays
   * untouched.
   */
  setAnthropicSubscriptionToken(plaintext: string): void {
    const trimmed = plaintext.trim();
    if (trimmed.length === 0) throw new Error("Token ist leer.");
    if (trimmed.length < 30) {
      throw new Error("Token wirkt zu kurz.");
    }
    if (!/^sk-ant-oat01-/i.test(trimmed)) {
      throw new Error(
        "Token sollte mit 'sk-ant-oat01-' beginnen (vom `claude setup-token`-CLI erzeugt).",
      );
    }
    this.store.setAnthropicSubscriptionToken(trimmed);
    // Saving a token also flips the active Anthropic auth mode to
    // "subscription" — matches the "whichever was most recently saved
    // wins" UX contract.
    this.store.setConfig({ anthropicAuthMode: "subscription" });
  }

  clearAnthropicSubscriptionToken(): void {
    this.store.clearAnthropicSubscriptionToken();
    // If subscription was the active anthropic auth mode, demote to
    // api-key. If the api-key isn't set either, the existing
    // `clearApiKey` demote-to-ollama rule already keeps the agent
    // usable — but we don't touch `kind` here, only the auth mode.
    const cfg = this.store.getConfig();
    if (cfg.anthropicAuthMode === "subscription") {
      this.store.setConfig({ anthropicAuthMode: "api-key" });
    }
  }

  /**
   * Phase A1 — flip between Anthropic API-key and subscription auth
   * without changing keys. Used by the Settings UI when the user wants
   * to deactivate one credential without deleting it. Throws when the
   * requested mode has no credential on disk.
   */
  setAnthropicAuthMode(mode: AnthropicAuthMode): ProviderConfig {
    if (mode === "subscription" && !this.store.hasAnthropicSubscriptionToken()) {
      throw new Error(
        "Subscription-Token ist nicht gespeichert. Erst über Settings → Anbieter speichern.",
      );
    }
    if (mode === "api-key" && !this.store.hasKey("anthropic")) {
      throw new Error(
        "Anthropic-API-Schlüssel ist nicht gespeichert. Erst über Settings → Anbieter speichern.",
      );
    }
    return this.store.setConfig({ anthropicAuthMode: mode });
  }

  isEncryptionAvailable(): boolean {
    return this.store.isEncryptionAvailable();
  }

  hasKey(kind: HostedProviderKind): boolean {
    return this.store.hasKey(kind);
  }

  hasAllKeys(): Record<LlmProviderKind, boolean> {
    return this.store.hasAllKeys();
  }

  /**
   * Project the catalog into the IPC shape the renderer's model picker
   * consumes (Phase 8.k2). Always filters to:
   *   - role: "llm" — embeddings are deliberately NOT user-switchable
   *     (vector compatibility across users; see catalog.ts header).
   *   - tools: true — the agent calls tool_use on every turn; a model
   *     that ignores tools[] would silently break the whole flow. We'd
   *     rather hide it than let the user pick a foot-gun. (Override via
   *     `toolsOnly: false` for a future "loose chat" mode.)
   *
   * Order matches the catalog (curated by us — Ollama defaults first,
   * then hosted in cost-tier order). The renderer can group by
   * `provider` to render per-provider sections.
   */
  listModels(opts?: { toolsOnly?: boolean }): ProviderCatalogEntry[] {
    const toolsOnly = opts?.toolsOnly ?? true;
    const entries = listCatalog({ role: "llm", toolsOnly });
    return entries.map(projectCatalogEntry);
  }

  // ---- Streaming ------------------------------------------------------------

  /**
   * Returns the provider that should service the *next* turn. Captured
   * by the orchestrator before it starts streaming so a mid-turn switch
   * can't swap engines underneath an in-flight loop.
   */
  activeProvider(): LlmProvider {
    return this.providers[this.store.getConfig().kind];
  }

  async *streamChat(
    req: LlmStreamRequest,
  ): AsyncGenerator<LlmStreamFrame, void, void> {
    yield* this.activeProvider().streamChat(req);
  }

  dispose(): void {
    for (const kind of ALL_KINDS) {
      this.providers[kind].dispose();
    }
    this.removeAllListeners();
  }

  // ---- Producer-subprocess env (Phase 8.v1.3) -----------------------------
  //
  // Surface the user's saved LLM config in the env-shape the
  // local producer Node services expect (LLM_PROVIDER, LLM_MODEL,
  // OPENAI_API_KEY, …). The producer's @ava/ai-provider reads
  // these directly. Returns null when no provider is configured
  // yet; the supervisor then leaves the producer in `error`
  // state with a wait-for-config message.
  async getProducerLlmEnv(): Promise<{
    provider: string;
    model?: string;
    openaiApiKey?: string;
    anthropicApiKey?: string;
    googleApiKey?: string;
    mistralApiKey?: string;
    ollamaUrl?: string;
  } | null> {
    const cfg = this.store.getConfig();
    const kind = cfg.kind;
    const model = this.resolveModel(kind);
    const env: Awaited<ReturnType<typeof this.getProducerLlmEnv>> = {
      provider: kind,
      model: model || undefined,
    };
    if (kind === "ollama") {
      // The producer's @ava/ai-provider getLLM defaults Ollama to
      // http://localhost:11434/api which matches the bundled
      // Ollama supervisor's default port. No explicit override
      // needed for the pilot.
      return env;
    }
    // Phase A1 — see `getActiveUserLlm`: subscription mode isn't
    // plumbed through the producer env yet. Return null so the
    // supervisor treats the producer as "wait for config".
    if (
      kind === "anthropic" &&
      (cfg.anthropicAuthMode ?? "api-key") === "subscription"
    ) {
      return null;
    }
    const key = await this.store.getKey(kind as HostedProviderKind);
    if (!key) return null;
    if (kind === "openai") env.openaiApiKey = key;
    else if (kind === "anthropic") env.anthropicApiKey = key;
    else if (kind === "google") env.googleApiKey = key;
    else if (kind === "mistral") env.mistralApiKey = key;
    return env;
  }

  // ---- Internal -------------------------------------------------------------

  /**
   * Resolve "config models[kind]" into a concrete model id, falling back
   * to the catalog's recommended default when the user hasn't picked one
   * for this provider yet.
   */
  private resolveModel(kind: LlmProviderKind): string {
    const explicit = this.store.getConfig().models[kind];
    if (explicit && explicit.length > 0) return explicit;
    const rec = recommendedFor(kind as CatalogProvider, "llm");
    return rec?.id ?? "";
  }

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

/**
 * Lossy projection of a CatalogEntry into the IPC shape. Drops embedding
 * dimensions and the role enum (renderer only sees LLM rows). Narrows
 * `provider` from the wider `CatalogProvider` to `LlmProviderKind` —
 * safe because we filter to role="llm" before calling this and every
 * provider in our LLM list is also a LlmProviderKind.
 */
function projectCatalogEntry(e: CatalogEntry): ProviderCatalogEntry {
  return {
    provider: e.provider as LlmProviderKind,
    id: e.id,
    label: e.label,
    tools: e.capabilities.tools,
    vision: e.capabilities.vision,
    contextWindow: e.capabilities.contextWindow,
    costClass: e.costClass,
    recommended: e.recommended ?? false,
    ...(e.approxBytes !== undefined ? { approxBytes: e.approxBytes } : {}),
  };
}

function labelFor(kind: LlmProviderKind): string {
  switch (kind) {
    case "ollama":
      return "Ollama";
    case "openai":
      return "OpenAI";
    case "anthropic":
      return "Anthropic";
    case "google":
      return "Google";
    case "mistral":
      return "Mistral";
  }
}

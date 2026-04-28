import { useEffect, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { gatewayFetch } from "../api/gateway";
import { pullModelTracked, useOllamaStore } from "../store/ollama";
import type {
  HostedProviderKind,
  LlmProviderKind,
  ProviderCatalogEntry,
  ProviderConfigBundle,
} from "../../../shared/types";

// Whoami screen — two sections:
//
//   1. Identity — gateway-side `/v1/whoami`. Smoke-tests auth + the
//      gateway URL wiring (kept since Step 6).
//
//   2. Provider — model picker (Phase 8.k2/8.k4). Shows the active
//      provider, lets the user flip to any other supported provider,
//      pick a tool-capable model from the catalog, and paste API keys
//      for hosted providers. Mirrors the in-chat `settings_*` tools so
//      users who aren't comfortable talking to the agent still have a
//      surface.
//
// Embeddings are deliberately absent — see catalog.ts header for why
// (vector-space lock-in across users).

interface WhoamiResponse {
  tenantId: string;
  actorId: string;
  scopes: string[];
}

const PROVIDER_LABEL: Record<LlmProviderKind, string> = {
  ollama: "Ollama (local)",
  openai: "OpenAI",
  anthropic: "Anthropic",
  google: "Google",
  mistral: "Mistral",
};

const HOSTED_KINDS: HostedProviderKind[] = [
  "openai",
  "anthropic",
  "google",
  "mistral",
];

export function Whoami() {
  const whoami = useQuery({
    queryKey: ["whoami"],
    queryFn: () => gatewayFetch<WhoamiResponse>("/v1/whoami"),
  });

  return (
    <section>
      <h2>Whoami</h2>
      {whoami.isLoading && <p>Loading…</p>}
      {whoami.error && (
        <p className="error">Error: {(whoami.error as Error).message}</p>
      )}
      {whoami.data && (
        <dl>
          <dt>Tenant</dt>
          <dd>{whoami.data.tenantId}</dd>
          <dt>Actor</dt>
          <dd>{whoami.data.actorId}</dd>
          <dt>Scopes</dt>
          <dd>{whoami.data.scopes.join(" · ")}</dd>
        </dl>
      )}

      <ProviderSection />
    </section>
  );
}

// -- Provider section -------------------------------------------------

function ProviderSection() {
  const qc = useQueryClient();

  const cfg = useQuery<ProviderConfigBundle>({
    queryKey: ["agent", "providerConfig"],
    queryFn: () => window.api.agent.getProviderConfig(),
  });

  const models = useQuery<ProviderCatalogEntry[]>({
    queryKey: ["agent", "models"],
    queryFn: () => window.api.agent.listModels(),
    // Catalog is process-static (frozen object); no need to ever refetch.
    staleTime: Infinity,
  });

  const setProvider = useMutation({
    mutationFn: (args: { kind: LlmProviderKind; model?: string }) =>
      window.api.agent.setProvider(args),
    onSuccess: () => qc.invalidateQueries({ queryKey: ["agent", "providerConfig"] }),
  });

  const setModel = useMutation({
    mutationFn: (args: { kind: LlmProviderKind; model: string }) =>
      window.api.agent.setModel(args),
    onSuccess: () => qc.invalidateQueries({ queryKey: ["agent", "providerConfig"] }),
  });

  if (cfg.isLoading || models.isLoading) {
    return (
      <section className="provider-section">
        <h3>Agent provider</h3>
        <p className="muted">Loading…</p>
      </section>
    );
  }
  if (cfg.error || models.error) {
    return (
      <section className="provider-section">
        <h3>Agent provider</h3>
        <p className="error">
          {((cfg.error || models.error) as Error)?.message ?? "Failed to load"}
        </p>
      </section>
    );
  }
  if (!cfg.data || !models.data) return null;

  const { config, status, hasKey, encryptionAvailable } = cfg.data;
  const activeKind = config.kind;
  const activeModelId = config.models[activeKind] || "";
  const modelsByKind = groupBy(models.data, (m) => m.provider);
  const activeList = modelsByKind[activeKind] ?? [];
  const activeEntry = activeList.find((m) => m.id === activeModelId);

  // Phase 8.k10c — let the user kick a pull for an Ollama model that
  // isn't on disk yet. We only surface the affordance when the active
  // provider is Ollama AND the picked model isn't in `installed`. The
  // dock then takes over the progress UI; no need for inline progress
  // here.
  const showOllamaDownload =
    activeKind === "ollama" &&
    activeEntry !== undefined &&
    activeEntry.provider === "ollama";

  return (
    <section className="provider-section">
      <h3>Agent provider</h3>
      <p className="muted">
        Status:{" "}
        <span className={`badge ${status.ready ? "ok" : "warn"}`}>
          {status.ready ? "ready" : "not ready"}
        </span>{" "}
        {status.errorMessage && (
          <span className="error">{status.errorMessage}</span>
        )}
      </p>

      <div className="provider-grid">
        <label className="field">
          <span>Provider</span>
          <select
            value={activeKind}
            onChange={(e) => {
              const kind = e.target.value as LlmProviderKind;
              // Don't pass `model` — the manager keeps each provider's
              // last-picked model in `config.models[kind]`, falling back
              // to the catalog's recommendation. Letting that flow
              // through means the dropdown remembers your preference
              // across switches.
              setProvider.mutate({ kind });
            }}
            disabled={setProvider.isPending}
          >
            {(Object.keys(PROVIDER_LABEL) as LlmProviderKind[]).map((k) => (
              <option
                key={k}
                value={k}
                disabled={k !== "ollama" && !hasKey[k]}
              >
                {PROVIDER_LABEL[k]}
                {k !== "ollama" && !hasKey[k] ? " (no key)" : ""}
              </option>
            ))}
          </select>
        </label>

        <label className="field">
          <span>Model</span>
          <select
            value={activeModelId || (activeList.find((m) => m.recommended)?.id ?? activeList[0]?.id ?? "")}
            onChange={(e) => {
              setModel.mutate({ kind: activeKind, model: e.target.value });
            }}
            disabled={setModel.isPending || activeList.length === 0}
          >
            {activeList.map((m) => (
              <option key={m.id} value={m.id}>
                {m.label}
                {m.recommended ? " ★" : ""} ·{" "}
                {formatContext(m.contextWindow)}
                {m.costClass !== "free" ? ` · ${m.costClass}` : ""}
                {m.vision ? " · vision" : ""}
              </option>
            ))}
          </select>
        </label>
      </div>

      {activeEntry && (
        <p className="muted small">
          {activeEntry.label} — context {formatContext(activeEntry.contextWindow)}
          {activeEntry.approxBytes
            ? ` · ${formatBytes(activeEntry.approxBytes)} on disk`
            : ""}
        </p>
      )}

      {showOllamaDownload && (
        <OllamaDownloadAffordance modelId={activeEntry.id} />
      )}

      {setProvider.error && (
        <p className="error">{(setProvider.error as Error).message}</p>
      )}
      {setModel.error && (
        <p className="error">{(setModel.error as Error).message}</p>
      )}

      <h4>API keys</h4>
      {!encryptionAvailable && (
        <p className="muted">
          ⚠ OS keychain unavailable — keys will be stored unencrypted in
          your user-data folder. Hosted providers still work but consider
          this a dev-only setup.
        </p>
      )}
      <div className="api-keys">
        {HOSTED_KINDS.map((kind) => (
          <ApiKeyRow key={kind} kind={kind} hasKey={hasKey[kind]} />
        ))}
      </div>
    </section>
  );
}

// -- Ollama download affordance ---------------------------------------

function OllamaDownloadAffordance({ modelId }: { modelId: string }) {
  const installed = useOllamaStore((s) => s.status.installed);
  const activePulls = useOllamaStore((s) => s.activePulls);
  const pullProgress = useOllamaStore((s) => s.pullProgress);

  const isInstalled = installed.some((m) => m.name === modelId);
  const isPulling =
    activePulls[modelId] === true ||
    (pullProgress[modelId] !== undefined && pullProgress[modelId]?.done !== true);

  // Once the model is on disk, surface a tiny green confirmation rather
  // than nothing — the user just clicked through a dropdown change and
  // wants to know the picked model is actually usable. Stays subtle to
  // not crowd the existing "active model" line above.
  if (isInstalled) {
    return <p className="muted small ok">On disk ✓</p>;
  }
  if (isPulling) {
    return (
      <p className="muted small">
        Downloading… see the dock in the bottom-right corner for progress.
      </p>
    );
  }

  return (
    <div className="ollama-dl">
      <p className="muted small warn">
        This model isn't on disk yet. Downloading runs in the background;
        you can keep using the app.
      </p>
      <button
        type="button"
        onClick={() => {
          // Fire-and-forget — the dock owns the progress UI and reports
          // both success and failure. We swallow the rejection so React
          // Query doesn't surface it as an unhandled promise.
          void pullModelTracked(modelId).catch(() => undefined);
        }}
      >
        Download model
      </button>
    </div>
  );
}

// -- API key row ------------------------------------------------------

interface ApiKeyRowProps {
  kind: HostedProviderKind;
  hasKey: boolean;
}

function ApiKeyRow({ kind, hasKey }: ApiKeyRowProps) {
  const qc = useQueryClient();
  const [draft, setDraft] = useState("");
  // Reset the input whenever the persisted "has key" flips, so a
  // successful save clears the field without us having to manage a
  // separate post-save state machine.
  useEffect(() => setDraft(""), [hasKey]);

  const save = useMutation({
    mutationFn: (apiKey: string) => window.api.agent.setApiKey({ kind, apiKey }),
    onSuccess: () =>
      qc.invalidateQueries({ queryKey: ["agent", "providerConfig"] }),
  });
  const clear = useMutation({
    mutationFn: () => window.api.agent.clearApiKey({ kind }),
    onSuccess: () =>
      qc.invalidateQueries({ queryKey: ["agent", "providerConfig"] }),
  });

  return (
    <div className="api-key-row">
      <span className="api-key-label">{PROVIDER_LABEL[kind]}</span>
      <input
        type="password"
        placeholder={hasKey ? "•••• stored — paste a new key to replace" : "API key"}
        value={draft}
        onChange={(e) => setDraft(e.target.value)}
        autoComplete="off"
        spellCheck={false}
      />
      <button
        type="button"
        onClick={() => save.mutate(draft)}
        disabled={draft.length === 0 || save.isPending}
      >
        {save.isPending ? "Saving…" : "Save"}
      </button>
      {hasKey && (
        <button
          type="button"
          className="link"
          onClick={() => clear.mutate()}
          disabled={clear.isPending}
          title="Remove the stored key for this provider"
        >
          {clear.isPending ? "Clearing…" : "clear"}
        </button>
      )}
      {(save.error || clear.error) && (
        <span className="error">
          {((save.error || clear.error) as Error).message}
        </span>
      )}
    </div>
  );
}

// -- helpers ----------------------------------------------------------

function groupBy<T, K extends string>(
  arr: T[],
  keyFn: (t: T) => K,
): Record<K, T[]> {
  const out = {} as Record<K, T[]>;
  for (const item of arr) {
    const k = keyFn(item);
    (out[k] ??= []).push(item);
  }
  return out;
}

function formatContext(tokens: number): string {
  if (tokens >= 1_000_000) return `${(tokens / 1_000_000).toFixed(1)}M ctx`;
  if (tokens >= 1_000) return `${Math.round(tokens / 1_000)}k ctx`;
  return `${tokens} ctx`;
}

function formatBytes(bytes: number): string {
  const gb = bytes / 1_000_000_000;
  if (gb >= 1) return `${gb.toFixed(1)} GB`;
  const mb = bytes / 1_000_000;
  return `${Math.round(mb)} MB`;
}

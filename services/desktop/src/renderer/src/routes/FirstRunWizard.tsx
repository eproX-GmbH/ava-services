import { useEffect, useState } from "react";
import { pullModelTracked, useOllamaStore } from "../store/ollama";
import type {
  ApiKeyValidation,
  HostedProviderKind,
  LlmProviderKind,
  OllamaModelSpec,
  OllamaPullProgress,
  ProviderConfigBundle,
} from "../../../shared/types";

// First-run wizard (D7, expanded in Phase 8.k10b).
//
// Two paths into a usable agent on first launch:
//
//   1. Local — download the bundled Gemma 4 LLM (~9.6 GB) and the
//      EmbeddingGemma embedder (~600 MB). What we recommend; everything
//      stays on-device.
//
//   2. Skip → cloud — paste an API key for OpenAI / Anthropic / Google /
//      Mistral. The key is validated up-front against the provider's
//      cheapest auth endpoint (see validate-key.ts) so we don't persist
//      a typo. The LLM pull is dropped from the required-models list,
//      but the EMBEDDING pull is still required: every other provider in
//      our stack uses a different vector space, and switching embedders
//      mid-corpus would silently break RAG. We make this lock-in cost
//      explicit by always keeping `embeddinggemma:latest` on the local
//      runtime regardless of LLM choice.
//
// The wizard stays a blocking screen for the duration of Phase 8.k10b —
// 8.k10c lifts that and turns this into a launcher-style overlay with a
// minimisable Download Dock. Until then the user waits for at least the
// embedding pull to finish.

interface MemoryProbe {
  writable: boolean;
  reason?: string;
  path: string;
}

type ViewState = "intro" | "chooser";

const PROVIDER_LABEL: Record<HostedProviderKind, string> = {
  openai: "OpenAI",
  anthropic: "Anthropic",
  google: "Google",
  mistral: "Mistral",
};

export function FirstRunWizard({
  memoryProbe,
  onPathChosen,
  onProviderConfigChanged,
}: {
  memoryProbe?: MemoryProbe | null;
  /** Fires once the user has either kicked off "Download all" or
   *  successfully completed "Skip → cloud". App.tsx flips its
   *  `pathChosen` state on this so the wizard stops being a hard modal
   *  and the routed app + DownloadDock take over. */
  onPathChosen?: () => void;
  /** Fires whenever the wizard refreshes the persisted provider bundle
   *  (currently: after a successful "Skip → cloud" save). Lets App.tsx
   *  update its mirror of `providerKind` without a separate IPC poll. */
  onProviderConfigChanged?: (bundle: ProviderConfigBundle) => void;
} = {}) {
  const status = useOllamaStore((s) => s.status);
  const pullProgress = useOllamaStore((s) => s.pullProgress);
  const pullRate = useOllamaStore((s) => s.pullRate);
  const [running, setRunning] = useState(false);
  const [errorMessage, setErrorMessage] = useState<string | null>(null);
  const [view, setView] = useState<ViewState>("intro");
  const [config, setConfig] = useState<ProviderConfigBundle | null>(null);

  // Read the persisted provider config once on mount so we know whether
  // the user already chose "skip → cloud" on a previous run. We refresh
  // it after a successful skip below so the renders that follow filter
  // the model list correctly.
  useEffect(() => {
    let cancelled = false;
    void window.api.agent
      .getProviderConfig()
      .then((bundle) => {
        if (!cancelled) setConfig(bundle);
      })
      .catch(() => {
        // Non-fatal — we just won't know the provider kind. Default to
        // "treat as local", which is the safer behaviour (LLM stays in
        // the missing list).
      });
    return () => {
      cancelled = true;
    };
  }, []);

  if (status.state === "error") {
    return (
      <div className="first-run">
        <div className="first-run__card">
          <h1>Lokale Modell-Laufzeit nicht verfügbar</h1>
          <p className="bad">{status.errorMessage ?? "Unbekannter Fehler"}</p>
          <p className="muted">
            Installiere die App neu oder setze <code>OLLAMA_BIN</code> auf
            eine funktionierende Ollama-Binary, falls du eine Entwickler-
            Version verwendest. Die App bleibt deaktiviert, bis das behoben
            ist.
          </p>
        </div>
      </div>
    );
  }

  if (status.state === "starting" || status.state === "idle") {
    return (
      <div className="first-run">
        <div className="first-run__card">
          <h1>Lokale Modell-Laufzeit wird gestartet…</h1>
          <p className="muted">
            Dauert beim ersten Start meist einige Sekunden.
          </p>
        </div>
      </div>
    );
  }

  // If the user has already chosen a hosted LLM (e.g. revisiting after a
  // restart), drop the LLM rows from the missing list — the only thing
  // left to download is the embedding model.
  const usingHostedLlm = config?.config.kind && config.config.kind !== "ollama";
  const visibleMissing = usingHostedLlm
    ? status.missing.filter((m) => m.role !== "llm")
    : status.missing;

  const onDownloadAll = async () => {
    setRunning(true);
    setErrorMessage(null);
    // Tell App.tsx the user has committed to a path BEFORE we await the
    // first pull. Otherwise the wizard would stay full-screen for the
    // entire ~9 GB download instead of collapsing into the dock.
    onPathChosen?.();
    // Sequential. The per-model progress is broadcast over IPC so we
    // don't need to thread it through the await chain. We use the
    // tracked wrapper so the DownloadDock renders a "Queued…" row
    // immediately, before Ollama emits the first frame.
    //
    // We deliberately *don't* break on a per-model failure here —
    // Phase 8.k10d. The supervisor already retried internally; if it
    // gave up, the dock surfaces a per-row Retry button and the user
    // can also retry siblings independently. Aborting the loop on one
    // failure would leave the user stuck if a later model would have
    // pulled fine (e.g. embedding succeeds but LLM hits a CDN snag).
    const failures: string[] = [];
    for (const model of visibleMissing) {
      try {
        await pullModelTracked(model.name);
      } catch (err) {
        failures.push(
          `${model.name}: ${err instanceof Error ? err.message : String(err)}`,
        );
      }
    }
    if (failures.length > 0) {
      setErrorMessage(
        `${failures.length === 1 ? "1 Download fehlgeschlagen" : `${failures.length} Downloads fehlgeschlagen`} — über den „Erneut versuchen“-Button im Dock (unten rechts) erneut starten.`,
      );
    }
    setRunning(false);
  };

  // Memory-dir probe failure is non-blocking — we still let the user
  // download models and use the app. We just flag that transcripts won't
  // persist so they aren't surprised after a restart.
  const memoryWarning =
    memoryProbe && !memoryProbe.writable ? (
      <p className="warn">
        Konversationsspeicher deaktiviert — konnte nicht in{" "}
        <code>{memoryProbe.path}</code> schreiben
        {memoryProbe.reason ? <> ({memoryProbe.reason})</> : null}. Der Agent
        funktioniert weiterhin, Verläufe überleben aber keinen Neustart.
      </p>
    ) : null;

  if (view === "chooser") {
    return (
      <div className="first-run">
        <div className="first-run__card">
          <h1>Cloud-Anbieter verwenden</h1>
          {memoryWarning}
          <ChooseExternalProvider
            onCancel={() => setView("intro")}
            onDone={async () => {
              // Refresh the bundle so usingHostedLlm flips and the next
              // render filters the LLM out of the missing list.
              const next = await window.api.agent.getProviderConfig();
              setConfig(next);
              onProviderConfigChanged?.(next);
              // Kick off any still-required pulls (the embedding model)
              // so they run in the dock while the user explores the app.
              // We deliberately do this BEFORE onPathChosen() so the
              // dock has a "Queued" row to render the moment the gate
              // flips — otherwise the user sees a blank routed app for
              // a few seconds while Ollama resolves the manifest.
              const stillNeeded = status.missing.filter((m) => m.role !== "llm");
              for (const m of stillNeeded) {
                // Fire-and-forget — the dock subscribes to the same
                // store and reports progress + final state. We don't
                // surface errors here because by this point the user
                // is already in the routed app; failures show up in
                // the dock row.
                void pullModelTracked(m.name).catch(() => undefined);
              }
              // The user has committed to the cloud path — tell App.tsx
              // it can drop into the routed app while the embedding
              // download (still required) finishes in the dock.
              onPathChosen?.();
              setView("intro");
            }}
          />
          <p className="muted small">
            EmbeddingGemma (~600 MB) muss trotzdem heruntergeladen werden —
            jeder Anbieter nutzt einen eigenen Embedding-Raum. Wir halten
            deinen lokal, damit ein späterer LLM-Wechsel deine Indizes nicht
            entwertet.
          </p>
        </div>
      </div>
    );
  }

  // intro view
  const cloudOk = !!usingHostedLlm;
  // If user has previously stored a hosted-provider key but never
  // flipped `kind` away from "ollama" (e.g. they pasted a key in
  // Whoami without using the Save+Switch flow), surface a one-click
  // affordance to adopt that key. Without this, "Skip → cloud" makes
  // them re-enter a key they already provided. Picks the first hosted
  // provider with a key — order doesn't really matter, but openai
  // first matches the chooser default.
  const savedHostedKey: HostedProviderKind | null =
    config && !cloudOk
      ? (Object.keys(PROVIDER_LABEL) as HostedProviderKind[]).find(
          (k) => config.hasKey[k],
        ) ?? null
      : null;

  const onUseSavedKey = async (kind: HostedProviderKind) => {
    setRunning(true);
    setErrorMessage(null);
    try {
      await window.api.agent.setProvider({ kind });
      const next = await window.api.agent.getProviderConfig();
      setConfig(next);
      onProviderConfigChanged?.(next);
      // Kick the still-required embedding pull so it streams in the dock.
      const stillNeeded = status.missing.filter((m) => m.role !== "llm");
      for (const m of stillNeeded) {
        void pullModelTracked(m.name).catch(() => undefined);
      }
      onPathChosen?.();
    } catch (err) {
      setErrorMessage(err instanceof Error ? err.message : String(err));
    } finally {
      setRunning(false);
    }
  };
  return (
    <div className="first-run">
      <div className="first-run__card">
        <h1>{cloudOk ? "Fast bereit" : "Lokale Modelle herunterladen"}</h1>
        {memoryWarning}
        {cloudOk ? (
          <p className="muted">
            Du bist mit <strong>{labelFor(config!.config.kind)}</strong>{" "}
            eingerichtet. Es {visibleMissing.length === 1 ? "fehlt" : "fehlen"}{" "}
            noch {visibleMissing.length}{" "}
            {visibleMissing.length === 1 ? "Modell" : "Modelle"} (Embedding)
            auf der Festplatte, dann kann es losgehen.
          </p>
        ) : (
          <p className="muted">
            AVA Desktop führt Sprach- und Embedding-Modelle lokal über Ollama
            aus. Wir laden {visibleMissing.length}{" "}
            {visibleMissing.length === 1 ? "Modell" : "Modelle"} herunter,
            bevor es losgehen kann. Das passiert einmal pro Rechner.
          </p>
        )}

        <ul className="first-run__list">
          {visibleMissing.map((model) => (
            <li key={model.name}>
              <ModelRow
                model={model}
                progress={pullProgress[model.name]}
                bytesPerSec={pullRate[model.name]?.bytesPerSec ?? 0}
                running={running}
              />
            </li>
          ))}
        </ul>

        {errorMessage && <p className="bad">{errorMessage}</p>}

        {savedHostedKey && (
          <p className="muted small">
            Auf diesem Rechner ist bereits ein {PROVIDER_LABEL[savedHostedKey]}
            -API-Key gespeichert. Damit kannst du den LLM-Download
            überspringen.
          </p>
        )}

        <div className="first-run__actions">
          {savedHostedKey ? (
            <button
              type="button"
              onClick={() => void onUseSavedKey(savedHostedKey)}
              disabled={running}
              title={`Agent mit dem gespeicherten Key auf ${PROVIDER_LABEL[savedHostedKey]} umstellen`}
            >
              {running
                ? "Wechsle…"
                : `Gespeicherten ${PROVIDER_LABEL[savedHostedKey]}-Key verwenden`}
            </button>
          ) : (
            <button
              type="button"
              onClick={onDownloadAll}
              disabled={running || visibleMissing.length === 0}
            >
              {running
                ? "Lädt…"
                : visibleMissing.length === 0
                  ? "Alle Modelle vorhanden ✓"
                  : `${cloudOk ? "Embedding" : "Alle"} herunterladen (${visibleMissing.length})`}
            </button>
          )}
          {savedHostedKey && (
            <button
              type="button"
              className="link"
              onClick={onDownloadAll}
              disabled={running || visibleMissing.length === 0}
              title="Stattdessen die lokalen Modelle herunterladen"
            >
              Stattdessen lokale Modelle laden
            </button>
          )}
          {!cloudOk && !savedHostedKey && (
            <button
              type="button"
              className="link"
              onClick={() => setView("chooser")}
              disabled={running}
              title="LLM-Download überspringen und einen Cloud-Anbieter (OpenAI, Anthropic, Google, Mistral) verwenden"
            >
              Überspringen — Cloud-Anbieter verwenden
            </button>
          )}
        </div>
      </div>
    </div>
  );
}

// -- Chooser sub-view -------------------------------------------------

function ChooseExternalProvider({
  onCancel,
  onDone,
}: {
  onCancel: () => void;
  onDone: () => Promise<void> | void;
}) {
  const [kind, setKind] = useState<HostedProviderKind>("openai");
  const [apiKey, setApiKey] = useState("");
  const [busy, setBusy] = useState(false);
  // null = no probe yet, otherwise the result of the most recent probe
  // for the current `(kind, apiKey)` pair. Cleared on edit so we don't
  // let stale "ok" states bleed into a new key.
  const [result, setResult] = useState<ApiKeyValidation | null>(null);

  const onTest = async () => {
    setBusy(true);
    setResult(null);
    try {
      const res = await window.api.agent.validateApiKey({ kind, apiKey });
      setResult(res);
      if (res.ok) {
        // Persist + flip to the chosen provider only after a green probe.
        // setApiKey throws if the key store is broken — surface that as
        // a probe failure so the user sees a single error surface.
        await window.api.agent.setApiKey({ kind, apiKey });
        await window.api.agent.setProvider({ kind });
        await onDone();
      }
    } catch (err) {
      setResult({
        ok: false,
        reason: err instanceof Error ? err.message : String(err),
      });
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="first-run__chooser">
      <label className="field">
        <span>Anbieter</span>
        <select
          value={kind}
          onChange={(e) => {
            setKind(e.target.value as HostedProviderKind);
            setResult(null);
          }}
          disabled={busy}
        >
          {(Object.keys(PROVIDER_LABEL) as HostedProviderKind[]).map((k) => (
            <option key={k} value={k}>
              {PROVIDER_LABEL[k]}
            </option>
          ))}
        </select>
      </label>
      <label className="field">
        <span>API-Key</span>
        <input
          type="password"
          value={apiKey}
          onChange={(e) => {
            setApiKey(e.target.value);
            setResult(null);
          }}
          placeholder={
            kind === "openai"
              ? "sk-…"
              : kind === "anthropic"
                ? "sk-ant-…"
                : "API-Key"
          }
          autoComplete="off"
          spellCheck={false}
          disabled={busy}
        />
      </label>
      {result?.ok === false && (
        <p className="bad">{result.reason}</p>
      )}
      <div className="first-run__actions">
        <button
          type="button"
          onClick={onTest}
          disabled={busy || apiKey.trim().length === 0}
        >
          {busy ? "Teste…" : "Testen & fortfahren"}
        </button>
        <button
          type="button"
          className="link"
          onClick={onCancel}
          disabled={busy}
        >
          Zurück
        </button>
      </div>
    </div>
  );
}

// -- ModelRow ---------------------------------------------------------

function ModelRow({
  model,
  progress,
  bytesPerSec,
  running,
}: {
  model: OllamaModelSpec;
  progress: OllamaPullProgress | undefined;
  /** Smoothed download rate from the renderer-side EMA. 0 means
   *  "not transferring right now" (queued, paused, finishing up). */
  bytesPerSec: number;
  running: boolean;
}) {
  const total = progress?.total ?? model.approxBytes;
  const completed = progress?.completed ?? 0;
  const pct = total > 0 ? Math.min(100, (completed / total) * 100) : 0;
  const done = progress?.done === true && !progress.errorMessage;
  const failed = progress?.done === true && Boolean(progress.errorMessage);
  const retrying = progress?.retrying === true;
  const attemptSuffix =
    progress?.attempt && progress.maxAttempts && progress.attempt > 1
      ? ` (Versuch ${progress.attempt}/${progress.maxAttempts})`
      : "";

  // The "byte progress" line is the one the user actually scans for —
  // they want to see numbers move. We always show it once a pull frame
  // exists (even if Ollama hasn't reported `total` yet, falling back to
  // the catalog's approxBytes), so the user immediately sees this isn't
  // stuck. While idle/queued we hide the line and just show the size.
  const showBytes = running && !failed && !done && completed > 0;
  // Speed must sustain >0 to display — see the EMA reset rules in the
  // store. We also skip "bytes/sec" once we're in the final post-stream
  // phase ("verifying digest", "extracting") where data has stopped
  // flowing but the row is still active.
  const showSpeed = showBytes && bytesPerSec > 0;
  const remaining = Math.max(total - completed, 0);
  const etaSec = showSpeed && bytesPerSec > 0 ? remaining / bytesPerSec : null;

  return (
    <div className="first-run__model">
      <div className="first-run__model-head">
        <span className="first-run__model-name">
          <code>{model.name}</code>{" "}
          <span className="muted">({model.role})</span>
        </span>
        <span className="muted first-run__model-status">
          {failed
            ? `Fehlgeschlagen${attemptSuffix}: ${progress?.errorMessage}`
            : done
              ? "Fertig ✓"
              : retrying
                ? `Verbinde erneut${attemptSuffix}…`
                : running
                  ? `${progress?.status ?? "Wartet"}${attemptSuffix}`
                  : `≈${formatBytes(model.approxBytes)} Download`}
        </span>
      </div>
      <div className="first-run__bar">
        <div
          className={`first-run__bar-fill ${
            failed ? "bad" : done ? "ok" : running ? "warn" : ""
          }`}
          style={{ width: `${done ? 100 : pct}%` }}
        />
      </div>
      {showBytes && (
        <div className="first-run__model-meter muted">
          <span>
            {formatBytes(completed)} / {formatBytes(total)} ({pct.toFixed(1)}%)
          </span>
          {showSpeed && (
            <>
              <span className="first-run__model-sep">·</span>
              <span>{formatBytes(bytesPerSec)}/s</span>
            </>
          )}
          {etaSec !== null && Number.isFinite(etaSec) && (
            <>
              <span className="first-run__model-sep">·</span>
              <span>ETA {formatDuration(etaSec)}</span>
            </>
          )}
        </div>
      )}
    </div>
  );
}

function formatBytes(n: number): string {
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
  if (n < 1024 * 1024 * 1024) return `${(n / 1024 / 1024).toFixed(1)} MB`;
  return `${(n / 1024 / 1024 / 1024).toFixed(1)} GB`;
}

function formatDuration(sec: number): string {
  if (!Number.isFinite(sec) || sec < 0) return "—";
  if (sec < 60) return `${Math.round(sec)}s`;
  if (sec < 3600) {
    const m = Math.floor(sec / 60);
    const s = Math.round(sec % 60);
    return s === 0 ? `${m}m` : `${m}m ${s}s`;
  }
  const h = Math.floor(sec / 3600);
  const m = Math.round((sec % 3600) / 60);
  return m === 0 ? `${h}h` : `${h}h ${m}m`;
}

function labelFor(kind: LlmProviderKind): string {
  switch (kind) {
    case "ollama":
      return "Ollama (lokal)";
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

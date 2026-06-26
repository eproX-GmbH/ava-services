import { useEffect, useState } from "react";
import { pullModelTracked, useOllamaStore } from "../store/ollama";
import { AnthropicTierBanner } from "../components/AnthropicTierBanner";
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
type ChooserSubForm = null | "apiKey" | "subscription";

const PROVIDER_LABEL: Record<HostedProviderKind, string> = {
  openai: "OpenAI",
  anthropic: "Anthropic",
  google: "Google",
  mistral: "Mistral",
};

const PROVIDER_KEY_DOCS: Record<HostedProviderKind, string> = {
  openai: "https://platform.openai.com/api-keys",
  anthropic: "https://console.anthropic.com/settings/keys",
  google: "https://aistudio.google.com/app/apikey",
  mistral: "https://console.mistral.ai/api-keys",
};

const PROVIDER_KEY_DOC_LABEL: Record<HostedProviderKind, string> = {
  openai: "OpenAI-Schlüssel erstellen",
  anthropic: "Anthropic-Schlüssel erstellen",
  google: "Google Gemini-Schlüssel erstellen",
  mistral: "Mistral-Schlüssel erstellen",
};

const OLLAMA_LIBRARY_URL = "https://ollama.com/library";
const ANTHROPIC_TOKEN_DOCS_URL =
  "https://code.claude.com/docs/en/authentication#generate-a-long-lived-token";
const ANTHROPIC_AUTH_DOC_URL =
  "https://github.com/eproX-GmbH/ava-services/blob/main/ANTHROPIC_AUTH.md";

function openExternal(url: string): void {
  void window.api.shell.openExternal(url);
}

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
  // v0.1.219 — Default-View ist jetzt der Chooser. Vorher landeten
  // Erstnutzer direkt in der „lokale Modelle herunterladen"-Maske,
  // wodurch der Default-Pfad lokal war (was auf Standard-Hardware zu
  // schlechter Qualität führte). Neue Reihenfolge: aktive Wahl
  // zwischen Abo (prominent) → API → Lokal (kollabiert).
  const [view, setView] = useState<ViewState>("chooser");
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

  // v0.1.169 — moved up so the Ollama-error escape branch (which now
  // renders the chooser) can also surface it without forward-ref errors.
  const memoryWarning =
    memoryProbe && !memoryProbe.writable ? (
      <p className="warn">
        Konversationsspeicher deaktiviert: konnte nicht in{" "}
        <code>{memoryProbe.path}</code> schreiben
        {memoryProbe.reason ? <> ({memoryProbe.reason})</> : null}. Der Agent
        funktioniert weiterhin, Verläufe überleben aber keinen Neustart.
      </p>
    ) : null;

  if (status.state === "error") {
    // v0.1.169 — Escape-hatch via ProviderChooserGrid. Pre-v0.1.169
    // this branch showed a dead-end "install again" screen with no
    // way out, locking Windows users whose bundled Ollama binary
    // wasn't extractable into a permanent modal. Now: same diagnostic
    // info at the top, then the standard three-card chooser so the
    // user can route AVA through a hosted LLM (BYO-Key or Claude Pro
    // OAuth) and proceed without ever fixing Ollama. The chooser's
    // `onApiKeyDone` / `onSubscriptionDone` callbacks set
    // `usingHostedLlm`, which trips App.tsx's escape clause and lets
    // the app boot normally.
    const onCloudDone = async () => {
      const next = await window.api.agent.getProviderConfig();
      setConfig(next);
      onProviderConfigChanged?.(next);
      onPathChosen?.();
    };
    return (
      <div className="first-run">
        <div className="first-run__card first-run__card--wide">
          <h1 className="first-run__title">
            <span className="ct-gradient-text">Lokale Modell-Laufzeit</span> nicht verfügbar
          </h1>
          <p className="bad">{status.errorMessage ?? "Unbekannter Fehler"}</p>
          <p className="muted">
            Kein Problem — AVA läuft auch ohne lokale Modell-Laufzeit.
            Wähle unten einen Hosted-Anbieter (eigener API-Key oder
            Claude-Pro-/Max-Abo) und du kannst direkt loslegen. Die
            lokale Laufzeit kannst du jederzeit später unter
            Einstellungen → Anbieter nachrüsten oder reparieren.
          </p>
          {memoryWarning}
          <ProviderChooserGrid
            // Local path stays disabled — the runtime that backs it
            // is exactly what's broken. The chooser's helper hides
            // the "local" section when `disableLocal` is set.
            onPickLocal={() => undefined}
            disableLocal
            onApiKeyDone={onCloudDone}
            onSubscriptionDone={onCloudDone}
            onBack={() => undefined}
            hideBack
          />
        </div>
      </div>
    );
  }

  if (status.state === "starting" || status.state === "idle") {
    return (
      <div className="first-run">
        <div className="first-run__card">
          <h1 className="first-run__title">
            <span className="ct-gradient-text">Lokale Modell-Laufzeit</span> wird gestartet…
          </h1>
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
        `${failures.length === 1 ? "1 Download fehlgeschlagen" : `${failures.length} Downloads fehlgeschlagen`}. Über den „Erneut versuchen“-Button im Dock (unten rechts) erneut starten.`,
      );
    }
    setRunning(false);
  };

  // Memory-dir probe failure is non-blocking — we still let the user
  // download models and use the app. We just flag that transcripts won't
  // persist so they aren't surprised after a restart.
  // v0.1.169 — declared above the error-branch return so the
  // escape-hatch chooser can also render this warning if it applies.
  // (Already moved further up — see top of function.)

  if (view === "chooser") {
    const onCloudDone = async () => {
      const next = await window.api.agent.getProviderConfig();
      setConfig(next);
      onProviderConfigChanged?.(next);
      const stillNeeded = status.missing.filter((m) => m.role !== "llm");
      for (const m of stillNeeded) {
        void pullModelTracked(m.name).catch(() => undefined);
      }
      onPathChosen?.();
      setView("intro");
    };
    // v0.1.219 — User wählt im Local-Section ein konkretes Modell. Wir
    // setzen Provider+Model, kicken Pull an, wechseln in die Intro-
    // View, damit der Nutzer den Download-Fortschritt sieht.
    const onPickLocalModel = async (modelId: string) => {
      try {
        // setProvider akzeptiert "model" als override und schreibt
        // beides atomar in den Store.
        await window.api.agent.setProvider({ kind: "ollama", model: modelId });
        const next = await window.api.agent.getProviderConfig();
        setConfig(next);
        onProviderConfigChanged?.(next);
        // Pull anstoßen — fire-and-forget, der DownloadDock zeigt
        // Fortschritt. Embedding wird in der Intro-View auch
        // gestartet (über visibleMissing/onDownloadAll), aber sicher
        // ist sicher.
        void pullModelTracked(modelId).catch(() => undefined);
        setView("intro");
      } catch (err) {
        setErrorMessage(err instanceof Error ? err.message : String(err));
      }
    };
    return (
      <div className="first-run">
        <div className="first-run__card first-run__card--wide">
          <h1 className="first-run__title">
            <span className="ct-gradient-text">Wie startest du mit AVA?</span>
          </h1>
          <p className="muted">
            Wir empfehlen das Claude-Abo — beste Qualität, fixe Kosten.
            Eigene API-Keys oder lokales Hosting sind weitere Wege. Du
            kannst die Wahl später in Einstellungen → Modelle jederzeit
            ändern.
          </p>
          {memoryWarning}
          <ProviderChooserGrid
            onPickLocal={onPickLocalModel}
            onApiKeyDone={onCloudDone}
            onSubscriptionDone={onCloudDone}
            onBack={() => setView("intro")}
            hideBack
          />
          <p className="muted small">
            EmbeddingGemma (~600 MB) muss in jedem Fall heruntergeladen
            werden — jeder Anbieter nutzt einen eigenen Embedding-Raum.
            Wir halten deinen lokal, damit ein späterer LLM-Wechsel
            deine Indizes nicht entwertet.
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
        <h1 className="first-run__title">
          <span className="ct-gradient-text">
            {cloudOk ? "Fast bereit" : "Lokale Modelle herunterladen"}
          </span>
        </h1>
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
            AVA führt Sprach- und Embedding-Modelle lokal über Ollama
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
              title="Stattdessen einen Cloud-Anbieter (eigener Schlüssel oder Claude-Abo) wählen"
            >
              Stattdessen Cloud-Anbieter wählen
            </button>
          )}
        </div>
      </div>
    </div>
  );
}

// -- Chooser sub-view -------------------------------------------------

// v0.1.219 — Kuratierte Liste lokaler Modelle für den Wizard. Sync
// zum Katalog in `@ava/ai-provider/catalog.ts` (manuell gehalten, weil
// der Renderer das Pricing-/Catalog-Modul nicht importieren kann ohne
// einen IPC-Roundtrip; für die Wizard-UI ist eine handgepflegte Kopie
// pragmatischer und stabiler).
interface LocalModelOption {
  id: string;
  label: string;
  sizeBytes: number;
  ramGb: string;
  note: string;
}

const LOCAL_MODEL_OPTIONS: LocalModelOption[] = [
  {
    id: "qwen3:8b",
    label: "Qwen 3 8B",
    sizeBytes: 5_200_000_000,
    ramGb: "ab 16 GB",
    note: "Einstieg. Tool-Calls stabil, deutsche Sprache solide.",
  },
  {
    id: "gemma4:e4b",
    label: "Gemma 4 E4B",
    sizeBytes: 9_600_000_000,
    ramGb: "16–24 GB",
    note: "Multimodal (Bilder + OCR), 128 K Context.",
  },
  {
    id: "qwen3:14b",
    label: "Qwen 3 14B",
    sizeBytes: 9_300_000_000,
    ramGb: "ab 16 GB",
    note: "Stärker bei mehrstufigen Recherchen als 8B.",
  },
  {
    id: "gemma4:26b",
    label: "Gemma 4 26B MoE",
    sizeBytes: 18_000_000_000,
    ramGb: "ab 24 GB",
    note: "Multimodal, 256 K Context. Schnell trotz Größe (MoE).",
  },
  {
    id: "qwen3:30b",
    label: "Qwen 3 30B-A3B MoE",
    sizeBytes: 19_000_000_000,
    ramGb: "ab 32 GB",
    note: "Sweet Spot für M-Series. 3,3 B aktive Parameter → schnell.",
  },
  {
    id: "llama3.3:70b",
    label: "Llama 3.3 70B (Q4)",
    sizeBytes: 42_000_000_000,
    ramGb: "ab 48 GB",
    note: "Workstation-Klasse. Höchste lokale Qualität.",
  },
];

function ProviderChooserGrid({
  onPickLocal,
  onApiKeyDone,
  onSubscriptionDone,
  onBack,
  /** v0.1.169 — hide the "Local" card entirely. Used by the
   *  Ollama-error escape-hatch path where local is exactly what's
   *  broken; showing it would invite the user to pick the same
   *  dead-end again. */
  disableLocal = false,
  /** v0.1.169 — hide the "back" affordance when there's nowhere to
   *  go back to (e.g. error-state landing, no prior view). */
  hideBack = false,
}: {
  /** v0.1.219 — bekommt jetzt die User-gewählte Modell-Id mit. Vorher
   *  parameterlos, weil der lokale Pfad immer denselben Default
   *  herunterlud. */
  onPickLocal: (modelId: string) => void;
  onApiKeyDone: () => Promise<void> | void;
  onSubscriptionDone: () => Promise<void> | void;
  onBack: () => void;
  disableLocal?: boolean;
  hideBack?: boolean;
}) {
  const [active, setActive] = useState<ChooserSubForm>(null);

  // When a card's primary button is clicked we expand the matching
  // sub-form inline below the grid and scroll it into view so the
  // user doesn't have to hunt for the next field on a tall screen.
  useEffect(() => {
    if (active === null) return;
    requestAnimationFrame(() => {
      document
        .getElementById("first-run-subform")
        ?.scrollIntoView({ behavior: "smooth", block: "nearest" });
    });
  }, [active]);

  return (
    <>
      {/* v0.1.381 — Reihenfolge nach Empfehlung:
          1. Hero-Reihe: ChatGPT-Abo UND Claude-Abo nebeneinander —
             Abo-Verbindung ist der empfohlene Standardweg und steht
             visuell hervorgehoben ganz oben. ChatGPT zuerst (ab
             15.06.2026 wird die Claude-Abo-Verbindung in AVA separat
             abgerechnet).
          2. Sekundär: API-Key OpenAI/Google/Mistral
          3. Tertiär kollabiert: Lokale Modelle (mit Sysreq-Warnung)
       */}

      {/* Sektion 1 — Abo-Heroes (ChatGPT + Claude) */}
      <div className="first-run__hero-grid">
        <div className="first-run__hero">
          <div className="first-run__hero-glyph" aria-hidden="true">⌬</div>
          <div className="first-run__hero-body">
            <h3 className="first-run__hero-title">
              Mit ChatGPT-Abo verbinden
            </h3>
            <p className="first-run__hero-sub">
              Nutze dein ChatGPT-Plus/Pro/Team-Abo direkt in AVA — ohne
              API-Schlüssel, ohne Extra-Kosten. Anmeldung per Klick
              („Sign in with ChatGPT“). Empfohlener Weg.
            </p>
            <OpenAISubscriptionHeroCTA onDone={onSubscriptionDone} />
          </div>
        </div>

        {/* Das Claude-Abo (OAuth) wurde entfernt — Anthropic läuft nur
            noch per API-Key (siehe „Eigener API-Schlüssel" unten). */}
      </div>

      {/* Sektion 2 — API-Key bei externem Provider */}
      <div className="first-run__option-card">
        <div className="first-run__option-glyph" aria-hidden="true">⌘</div>
        <h3 className="first-run__option-title">
          Eigener API-Schlüssel (OpenAI, Anthropic, Google, Mistral)
        </h3>
        <p className="first-run__option-sub">
          Bezahle direkt beim Anbieter nach Token-Verbrauch. Schnell
          eingerichtet, gut kontrollierbar.
        </p>
        <div className="first-run__option-docs">
          {(Object.keys(PROVIDER_KEY_DOCS) as HostedProviderKind[])
            .filter((k) => k !== "anthropic")
            .map((k) => (
              <button
                key={k}
                type="button"
                className="link small"
                onClick={() => openExternal(PROVIDER_KEY_DOCS[k])}
              >
                {PROVIDER_KEY_DOC_LABEL[k]}
              </button>
            ))}
        </div>
        <button
          type="button"
          className="first-run__option-cta"
          onClick={() => setActive("apiKey")}
        >
          Schlüssel hinterlegen
        </button>
      </div>

      {/* Sektion 3 — Lokal hosten (kollabiert, mit Modell-Liste) */}
      {!disableLocal && (
        <details className="first-run__local">
          <summary className="first-run__local-summary">
            <span className="first-run__local-glyph" aria-hidden="true">◉</span>
            <span className="first-run__local-title">
              Lokal hosten (für Fortgeschrittene)
            </span>
            <span className="first-run__local-hint">
              Daten bleiben offline, dafür höhere Hardware-Anforderungen
              und merklich schwächere Qualität als Cloud-Optionen
            </span>
          </summary>
          <div className="first-run__local-body">
            <p className="muted small">
              AVA lädt die Modelle einmalig über Ollama auf deinen
              Rechner. Wähle ein Modell entsprechend deines verfügbaren
              Arbeitsspeichers — selbst die größeren erreichen
              <strong> nicht </strong>die Qualität von Claude Pro oder
              GPT-4o, vor allem bei mehrstufigen Tool-Calls.
            </p>
            <ul className="first-run__local-models">
              {LOCAL_MODEL_OPTIONS.map((m) => (
                <li key={m.id} className="first-run__local-model">
                  <div className="first-run__local-model-head">
                    <span className="first-run__local-model-name">
                      {m.label}
                    </span>
                    <span className="first-run__local-model-ram">
                      {m.ramGb} RAM
                    </span>
                  </div>
                  <p className="first-run__local-model-note">{m.note}</p>
                  <div className="first-run__local-model-foot">
                    <span className="muted small">
                      Download: {formatBytes(m.sizeBytes)}
                    </span>
                    <button
                      type="button"
                      className="first-run__local-model-cta"
                      onClick={() => onPickLocal(m.id)}
                    >
                      {m.label} wählen
                    </button>
                  </div>
                </li>
              ))}
            </ul>
            <p className="muted small">
              Nach der Wahl startet der Download im Hintergrund (siehe
              Mini-Fenster unten rechts). Du kannst dein Modell jederzeit
              unter Einstellungen → Modelle wechseln.
            </p>
            <button
              type="button"
              className="link small"
              onClick={() => openExternal(OLLAMA_LIBRARY_URL)}
            >
              Vollständige Ollama-Bibliothek ansehen →
            </button>
          </div>
        </details>
      )}

      {active && (
        <div id="first-run-subform" className="first-run__subform">
          {active === "apiKey" && (
            <ApiKeySubForm
              onCancel={() => setActive(null)}
              onDone={async () => {
                setActive(null);
                await onApiKeyDone();
              }}
            />
          )}
        </div>
      )}

      {!active && !hideBack && (
        <div className="first-run__actions">
          <button type="button" className="link" onClick={onBack}>
            Zurück
          </button>
        </div>
      )}
    </>
  );
}

function ApiKeySubForm({
  onCancel,
  onDone,
}: {
  onCancel: () => void;
  onDone: () => Promise<void> | void;
}) {
  const [kind, setKind] = useState<HostedProviderKind>("openai");
  const [apiKey, setApiKey] = useState("");
  const [busy, setBusy] = useState(false);
  const [result, setResult] = useState<ApiKeyValidation | null>(null);

  const onTest = async () => {
    setBusy(true);
    setResult(null);
    try {
      const res = await window.api.agent.validateApiKey({ kind, apiKey });
      setResult(res);
      if (res.ok) {
        await window.api.agent.setApiKey({ kind, apiKey });
        await window.api.agent.setProvider({ kind });
        // v0.1.209 — Wenn der Anthropic-Probe Tier-1 ergeben hat,
        // pausieren wir hier und zeigen den Hinweisbanner. Der Nutzer
        // muss "Verstanden" klicken, bevor wir den Wizard
        // schließen — sonst sieht er den Tipp nie und rennt im
        // ersten Chat-Turn in eine 429.
        if (res.tierInfo && res.tierInfo.tierLabel === "tier-1") {
          return; // bleibt mit gesetztem `result` stehen, Button-Bar unten zeigt "Weiter"
        }
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
      <h3 className="first-run__subform-title">API-Schlüssel hinterlegen</h3>
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
          {/* Anthropic-API-Key wieder aktiv (Claude-Abo-OAuth entfernt) —
              alle Hosted-Provider sind wählbar. */}
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
      <p className="muted small">
        <button
          type="button"
          className="link small"
          onClick={() => openExternal(PROVIDER_KEY_DOCS[kind])}
        >
          Wo bekomme ich einen Schlüssel für {PROVIDER_LABEL[kind]}?
        </button>
      </p>
      {result?.ok === false && <p className="bad">{result.reason}</p>}
      {/* v0.1.209 — Tier-1-Banner direkt unter dem Test-Button.
          Erscheint nur bei Anthropic-Tier-1 (validate liefert dann
          tierInfo). Bei Tier 2 / Tier 3+ oder nicht-Anthropic
          Providern wird das auto-Advance unverändert ausgeführt. */}
      {result?.ok === true && result.tierInfo?.tierLabel === "tier-1" && (
        <AnthropicTierBanner tier={result.tierInfo} />
      )}
      <div className="first-run__actions">
        {result?.ok === true && result.tierInfo?.tierLabel === "tier-1" ? (
          <button type="button" onClick={() => void onDone()}>
            Verstanden, weiter
          </button>
        ) : (
          <button
            type="button"
            onClick={onTest}
            disabled={busy || apiKey.trim().length === 0}
          >
            {busy ? "Teste…" : "Testen & fortfahren"}
          </button>
        )}
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

/**
 * v0.1.381 — ChatGPT-Abo-CTA direkt in der Hero-Karte. Anders als beim
 * Claude-Pfad (Subform mit Advanced-Token-Paste) ist der OpenAI-Flow ein
 * einzelner OAuth-Klick — der Main-Process-Handler setzt nach Erfolg
 * selbst `setProvider("openai")`, hier reicht Connect + onDone.
 */
function OpenAISubscriptionHeroCTA({
  onDone,
}: {
  onDone: () => Promise<void> | void;
}) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const onConnect = async (): Promise<void> => {
    setBusy(true);
    setError(null);
    try {
      const result = await window.api.agent.connectOpenAISubscription();
      if (result.ok) {
        await onDone();
        return;
      }
      setError(result.error);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  };

  return (
    <>
      <button
        type="button"
        className="first-run__hero-cta"
        onClick={() => void onConnect()}
        disabled={busy}
      >
        {busy ? "Öffne Anmeldung…" : "Mit ChatGPT verbinden →"}
      </button>
      {error && <p className="error small">{error}</p>}
    </>
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
  if (!Number.isFinite(sec) || sec < 0) return "";
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

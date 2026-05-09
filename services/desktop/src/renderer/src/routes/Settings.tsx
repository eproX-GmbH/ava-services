import { useEffect, useMemo, useState } from "react";
import { Link, useLocation } from "react-router-dom";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { gatewayFetch } from "../api/gateway";
import { useUsage, isUnlimited, type BillingTier } from "../api/usage";
import { pullModelTracked, useOllamaStore } from "../store/ollama";
import { useVoiceStore } from "../store/voice";
import { useProfileStore } from "../store/profile";
import { usePostgresStore } from "../store/postgres";
import { useProducersStore } from "../store/producers";
import { useConfigStore } from "../store/config";
import { useUpdaterStore } from "../store/updater";
import type {
  AlertCadenceMinutes,
  AlertCandidateDecision,
  AlertPrefs,
  AlertSeverity,
  AlertTickInfo,
  FreshnessPrefs,
  FreshnessStage,
  FreshnessTickInfo,
  HostedProviderKind,
  LlmProviderKind,
  NotificationPermissionStatus,
  ProviderCatalogEntry,
  ProviderConfigBundle,
} from "../../../shared/types";

// Settings route (Phase 8.g).
//
// The discoverable home for things the user changes after onboarding:
// which LLM provider serves the agent, which model, which API keys are
// stored, what the local Ollama disk looks like, and what long-term
// memory the agent has accumulated. Most of this content used to live
// on Whoami — that page now stays focused on identity (tenant/actor/
// scopes), which is closer to its name.
//
// IPC reuse (no new channels): all operations here go through
// existing `window.api.agent.*` and `window.api.ollama.*` methods.
// Adding a setting means adding a section, not an IPC contract.

const PROVIDER_LABEL: Record<LlmProviderKind, string> = {
  ollama: "Ollama (lokal)",
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

export function Settings() {
  // Scroll-to-section via hash. The chat composer's mic button
  // navigates to `/settings#voice-settings` when whisper isn't ready;
  // HashRouter doesn't auto-handle the inner fragment, so we look up
  // the matching id ourselves and scroll it into view.
  const { hash } = useLocation();
  useEffect(() => {
    if (!hash || hash.length <= 1) return;
    const id = hash.slice(1);
    // Two RAFs gives the section components their first paint before
    // we measure — otherwise we scroll to a phantom 0 px offset on
    // first mount.
    requestAnimationFrame(() => {
      requestAnimationFrame(() => {
        document
          .getElementById(id)
          ?.scrollIntoView({ behavior: "smooth", block: "start" });
      });
    });
  }, [hash]);
  return (
    <section>
      <SettingsHeader />
      <PlanSection />
      <ProviderSection />
      <ProfileSection />
      <VoiceSection />
      <UpdaterSection />
      <PostgresSection />
      <ProducersSection />
      <CrmSection />
      <AlertsSection />
      <FreshnessSection />
      <GeneralMemorySection />
    </section>
  );
}

// -- Settings header with version pill --------------------------------
//
// Tiny "AVA v0.1.x · channel" line under the page title. Pulls from
// useConfigStore which mirrors `app:getConfig` (filled at App.tsx
// mount). When config isn't ready yet we render the title alone so
// the layout doesn't jump on slow boots.

function SettingsHeader() {
  const ready = useConfigStore((s) => s.ready);
  const version = useConfigStore((s) => s.appVersion);
  const channel = useConfigStore((s) => s.updateChannel);
  const isDev = useConfigStore((s) => s.isDev);
  return (
    <header className="settings-header ct-page-header">
      <p className="ct-page-header__eyebrow">Konfiguration</p>
      <h2 className="ct-page-header__title">
        <span className="ct-gradient-text">Einstellungen</span>
      </h2>
      <p className="ct-page-header__lede">
        Anbieter, Modelle, Integrationen und Datenpflege: alles, was die
        Pipeline und der Agent zur Laufzeit erwarten.
      </p>
      {ready && version && (
        <p className="muted small" style={{ marginTop: "0.5rem" }}>
          AVA v{version}
          {channel && channel !== "latest" ? ` · ${channel}` : ""}
          {isDev ? " · dev" : ""}
        </p>
      )}
    </header>
  );
}

// -- Auto-updater (Phase 8.u4) ----------------------------------------
//
// Renders the update lifecycle (idle → checking → up-to-date /
// available → downloading → ready) plus action buttons. The user
// always confirms downloads + installs — no silent updates.

function UpdaterSection() {
  const status = useUpdaterStore((s) => s.status);

  const onCheck = () => void window.api.updater.check();
  const onDownload = () => void window.api.updater.download();
  const onInstall = () => void window.api.updater.install();

  return (
    <section className="provider-section" id="updates">
      <h3>Updates</h3>
      <p className="muted small">
        AVA prüft beim Start und alle vier Stunden auf neue Versionen.
        Du bestätigst jeden Download und jeden Neustart selbst. Es gibt
        keine stillen Updates.
      </p>
      <ul className="kv">
        <li>
          <span className="muted">Installiert:</span>{" "}
          AVA v{status.currentVersion}
        </li>
        {status.latestVersion && status.latestVersion !== status.currentVersion && (
          <li>
            <span className="muted">Neue Version verfügbar:</span>{" "}
            <strong>v{status.latestVersion}</strong>
          </li>
        )}
        {status.state === "downloading" && status.progress && (
          <li>
            <span className="muted">Lade herunter:</span>{" "}
            {status.progress.percent.toFixed(0)} % (
            {(status.progress.bytesPerSec / 1024 / 1024).toFixed(1)} MB/s)
          </li>
        )}
        {status.errorMessage && (
          <li className="error">
            <span className="muted">Fehler:</span> {status.errorMessage}
          </li>
        )}
      </ul>
      <div className="actions">
        {(status.state === "idle" ||
          status.state === "up-to-date" ||
          status.state === "error") && (
          <button type="button" className="link" onClick={onCheck}>
            Jetzt nach Updates suchen
          </button>
        )}
        {status.state === "available" && (
          <button type="button" onClick={onDownload}>
            v{status.latestVersion} herunterladen
          </button>
        )}
        {status.state === "ready" && (
          <button type="button" onClick={onInstall}>
            Neu starten und v{status.latestVersion} installieren
          </button>
        )}
        {status.state === "installing" && (
          <button type="button" disabled>
            Update wird installiert… Anwendung startet gleich neu
          </button>
        )}
      </div>
    </section>
  );
}

// -- Local Postgres status (8.v1.0) -----------------------------------
//
// Read-only status row at this stage. Producer wiring (8.v1.2+) will
// extend this section with a per-producer status list. For v0.1.x we
// just want the user to see "ja, die lokale DB läuft" or, in the
// degraded case, a clear error string they can quote when filing a
// bug report.

function PostgresSection() {
  const status = usePostgresStore((s) => s.status);

  const stateLabel: Record<typeof status.state, string> = {
    idle: "noch nicht gestartet",
    initializing: "wird initialisiert (einmalig, ~5 s)…",
    starting: "startet…",
    ready: "bereit",
    error: "Fehler",
    stopping: "fährt herunter…",
  };

  const tone =
    status.state === "ready"
      ? "ok"
      : status.state === "error"
        ? "err"
        : "muted";

  return (
    <section className="provider-section" id="local-services">
      <h3>Lokale Datenbank</h3>
      <p className="muted small">
        AVA bündelt eine eingebettete PostgreSQL-Instanz für die lokal
        laufenden Producer-Dienste. Die Datenbank läuft nur auf{" "}
        <code>127.0.0.1</code> und ist von außen nicht erreichbar.
      </p>
      <ul className="kv">
        <li>
          <span className="muted">Status:</span>{" "}
          <span className={`status-dot ${tone}`}>
            {stateLabel[status.state]}
          </span>
        </li>
        {status.version && (
          <li>
            <span className="muted">Version:</span> PostgreSQL {status.version}
          </li>
        )}
        {status.host && (
          <li>
            <span className="muted">Endpoint:</span>{" "}
            <code>{status.host}</code>
          </li>
        )}
        {status.dataDir && (
          <li>
            <span className="muted">Datenverzeichnis:</span>{" "}
            <code className="path">{status.dataDir}</code>
          </li>
        )}
        {status.errorMessage && (
          <li className="error">
            <span className="muted">Fehler:</span> {status.errorMessage}
          </li>
        )}
      </ul>
    </section>
  );
}

// -- Local producer subprocesses (Phase 8.v1.1) -----------------------
//
// Renders one row per ProducerSupervisor in the main process. v1.1
// only ships company-profile; the remaining four producers will
// add themselves automatically once registered in main/index.ts.

interface QueueInfo {
  ready: number;
  unacked: number;
  total: number;
  consumers: number;
}

function ProducersSection() {
  const byName = useProducersStore((s) => s.byName);
  const list = Object.values(byName);

  const stateLabel: Record<string, string> = {
    idle: "noch nicht gestartet",
    migrating: "Datenbank-Migrationen…",
    starting: "startet…",
    ready: "bereit",
    error: "Fehler",
    stopping: "fährt herunter…",
  };

  // §8.v3 cosmetic — per-producer AMQP queue depth from the gateway.
  // Polled every 10s while this section is mounted; gateway caches
  // the broker management API call for 5s so the actual upstream
  // hit rate is ≤ 1 per 10s regardless of how many tabs are open.
  const queueDepths = useQuery<{
    producers: Record<string, QueueInfo>;
  }>({
    queryKey: ["producers", "queueDepths"],
    queryFn: () =>
      gatewayFetch<{ producers: Record<string, QueueInfo> }>(
        "/v1/producers/queue-depths",
      ),
    refetchInterval: 10_000,
    // Don't show stale "loading" flicker on each poll.
    refetchOnWindowFocus: false,
  });

  return (
    <section className="provider-section" id="local-producers">
      <h3>Lokale Producer-Dienste</h3>
      <p className="muted small">
        Tenant-private Dienste laufen als Node-Subprozesse direkt auf
        deinem Rechner. Sie nutzen die lokale Datenbank weiter oben
        und sprechen über AMQP mit dem Cloud-Gateway.
      </p>
      {list.length === 0 ? (
        <p className="muted small">Keine Producer konfiguriert.</p>
      ) : (
        <ul className="kv">
          {list.map((p) => {
            const tone =
              p.state === "ready"
                ? "ok"
                : p.state === "error"
                  ? "err"
                  : "muted";
            const depth = queueDepths.data?.producers?.[p.name];
            return (
              <li key={p.name}>
                <span className="muted">{p.name}:</span>{" "}
                <span className={`status-dot ${tone}`}>
                  {stateLabel[p.state] ?? p.state}
                </span>
                {p.port !== null && (
                  <>
                    {" · Port "}
                    <code>{p.port}</code>
                  </>
                )}
                {p.pid !== null && (
                  <>
                    {" · PID "}
                    <code>{p.pid}</code>
                  </>
                )}
                {depth && (
                  <>
                    {" · Queue: "}
                    <code>
                      {depth.ready}
                      {depth.unacked > 0 ? ` (+${depth.unacked} in flight)` : ""}
                    </code>
                  </>
                )}
                {p.errorMessage && (
                  <div className="error small">{p.errorMessage}</div>
                )}
              </li>
            );
          })}
        </ul>
      )}
    </section>
  );
}

// -- CRM section ------------------------------------------------------
//
// v0.1.54 — per-provider connect/disconnect cards. Tokens live in
// the OS keychain via the main process; this UI only shows
// metadata. The chat agent drives the same flow via the
// `connect_crm` / `disconnect_crm` tools — same end state, just a
// different entry point.

const CRM_PROVIDER_LABELS: Record<
  "salesforce" | "hubspot" | "dynamics",
  { label: string; helper: string; requiresOrgUrl: boolean }
> = {
  salesforce: {
    label: "Salesforce",
    helper:
      "Verbindung über OAuth (PKCE). Du wirst zu login.salesforce.com weitergeleitet.",
    requiresOrgUrl: false,
  },
  hubspot: {
    label: "HubSpot",
    helper:
      "Verbindung über OAuth. Es werden CRM-Lese- und Schreibrechte für Kontakte, Firmen und Deals angefragt.",
    requiresOrgUrl: false,
  },
  dynamics: {
    label: "Microsoft Dynamics 365",
    helper:
      "Verbindung über Microsoft Identity. Bitte gib zuerst die Org-URL deiner Dynamics-Instanz an (z. B. contoso.crm4.dynamics.com).",
    requiresOrgUrl: true,
  },
};

function CrmSection() {
  const qc = useQueryClient();
  const list = useQuery({
    queryKey: ["crm", "list"],
    queryFn: () => window.api.crm.list(),
  });

  // Push-driven cache invalidation: any status change from the main
  // process refreshes the list query so we don't poll.
  useEffect(() => {
    return window.api.crm.onStatusChanged(() => {
      void qc.invalidateQueries({ queryKey: ["crm", "list"] });
    });
  }, [qc]);

  return (
    <section className="provider-section" id="crm-connections">
      <h3>CRM-Verbindungen</h3>
      <p className="muted small">
        Verknüpfe dein CRM mit AVA. Die OAuth-Tokens bleiben verschlüsselt
        in deinem Betriebssystem-Schlüsselbund, niemals in der Cloud.
        Du kannst Verbindungen auch direkt im Chat herstellen, z. B.
        „Verbinde mein Salesforce-Konto“.
      </p>
      {list.isLoading ? (
        <p className="muted small">Lade…</p>
      ) : (
        <ul className="crm-cards">
          {(list.data ?? []).map((s) => (
            <CrmCard key={s.provider} status={s} />
          ))}
        </ul>
      )}
    </section>
  );
}

function CrmCard({
  status,
}: {
  status: {
    provider: "salesforce" | "hubspot" | "dynamics";
    connected: boolean;
    account: string | null;
    lastRefreshedAt: string | null;
    lastError: string | null;
  };
}) {
  const meta = CRM_PROVIDER_LABELS[status.provider];
  const [orgUrl, setOrgUrl] = useState("");
  const [busy, setBusy] = useState(false);
  const [localError, setLocalError] = useState<string | null>(null);

  const onConnect = async () => {
    setBusy(true);
    setLocalError(null);
    try {
      await window.api.crm.connect(
        status.provider,
        meta.requiresOrgUrl ? { orgUrl: orgUrl.trim() } : undefined,
      );
    } catch (err) {
      setLocalError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  };

  const onDisconnect = async () => {
    setBusy(true);
    setLocalError(null);
    try {
      await window.api.crm.disconnect(status.provider);
    } catch (err) {
      setLocalError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  };

  const tone = status.connected ? "ok" : "muted";
  const canConnect =
    !busy && (!meta.requiresOrgUrl || orgUrl.trim().length > 0);
  const errorMessage = localError ?? status.lastError;

  return (
    <li className="crm-card">
      <div className="crm-card-header">
        <div className="crm-card-title">
          <span>{meta.label}</span>
          <span className={`status-dot ${tone}`}>
            {status.connected ? "verbunden" : "nicht verbunden"}
          </span>
        </div>
        <div className="crm-card-actions">
          {status.connected ? (
            <button onClick={() => void onDisconnect()} disabled={busy}>
              {busy ? "Trenne…" : "Verbindung trennen"}
            </button>
          ) : (
            <button onClick={() => void onConnect()} disabled={!canConnect}>
              {busy ? "Verbinde…" : "Verbinden"}
            </button>
          )}
        </div>
      </div>

      {status.connected ? (
        <div className="crm-card-meta">
          {status.account && <span>Konto: {status.account}</span>}
          {status.lastRefreshedAt && (
            <span>
              Zuletzt aktualisiert:{" "}
              {new Date(status.lastRefreshedAt).toLocaleString("de-DE")}
            </span>
          )}
        </div>
      ) : (
        <p className="crm-card-helper">{meta.helper}</p>
      )}

      {meta.requiresOrgUrl && !status.connected && (
        <input
          type="text"
          className="crm-card-orginput"
          placeholder="contoso.crm4.dynamics.com"
          value={orgUrl}
          onChange={(e) => setOrgUrl(e.target.value)}
          disabled={busy}
        />
      )}

      {errorMessage && <p className="crm-card-error">{errorMessage}</p>}
    </li>
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
    onSuccess: () =>
      qc.invalidateQueries({ queryKey: ["agent", "providerConfig"] }),
  });

  const setModel = useMutation({
    mutationFn: (args: { kind: LlmProviderKind; model: string }) =>
      window.api.agent.setModel(args),
    onSuccess: () =>
      qc.invalidateQueries({ queryKey: ["agent", "providerConfig"] }),
  });

  if (cfg.isLoading || models.isLoading) {
    return (
      <section className="provider-section">
        <h3>Agent-Anbieter</h3>
        <p className="muted">Lädt…</p>
      </section>
    );
  }
  if (cfg.error || models.error) {
    return (
      <section className="provider-section">
        <h3>Agent-Anbieter</h3>
        <p className="error">
          {((cfg.error || models.error) as Error)?.message ?? "Konnte nicht geladen werden"}
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

  const showOllamaDownload =
    activeKind === "ollama" &&
    activeEntry !== undefined &&
    activeEntry.provider === "ollama";

  return (
    <section className="provider-section">
      <h3>Agent-Anbieter</h3>
      <p className="muted">
        Status:{" "}
        <span className={`badge ${status.ready ? "ok" : "warn"}`}>
          {status.ready ? "bereit" : "nicht bereit"}
        </span>{" "}
        {status.errorMessage && (
          <span className="error">{status.errorMessage}</span>
        )}
      </p>

      <div className="provider-grid">
        <label className="field">
          <span>Anbieter</span>
          <select
            value={activeKind}
            onChange={(e) => {
              const kind = e.target.value as LlmProviderKind;
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
                {k !== "ollama" && !hasKey[k] ? " (kein Schlüssel)" : ""}
              </option>
            ))}
          </select>
        </label>

        <label className="field">
          <span>Modell</span>
          <select
            value={
              activeModelId ||
              activeList.find((m) => m.recommended)?.id ||
              activeList[0]?.id ||
              ""
            }
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
          {activeEntry.label} · Kontext{" "}
          {formatContext(activeEntry.contextWindow)}
          {activeEntry.approxBytes
            ? ` · ${formatBytes(activeEntry.approxBytes)} auf der Festplatte`
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

      <InstalledModelsSection />

      <h4>API-Schlüssel</h4>
      {!encryptionAvailable && (
        <p className="muted">
          ⚠ OS-Schlüsselbund nicht verfügbar: Schlüssel werden unverschlüsselt
          im Benutzerdatenordner gespeichert. Cloud-Anbieter funktionieren
          weiterhin, dieser Modus eignet sich aber nur für Entwicklungs­zwecke.
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

// -- Installed models (delete-from-disk) ------------------------------

function InstalledModelsSection() {
  const installed = useOllamaStore((s) => s.status.installed);
  const [pendingDelete, setPendingDelete] = useState<string | null>(null);
  const [pendingRepair, setPendingRepair] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [restarting, setRestarting] = useState(false);

  const onRestart = async () => {
    setError(null);
    setRestarting(true);
    try {
      await window.api.ollama.restart();
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setRestarting(false);
    }
  };

  if (installed.length === 0) {
    return (
      <>
        <h4>Lokale Modelle auf der Festplatte</h4>
        <p className="muted small">Noch keine lokalen Modelle installiert.</p>
        <button
          type="button"
          className="link"
          onClick={onRestart}
          disabled={restarting}
          title={`Stoppt und startet den eingebundenen Ollama-Prozess neu. Hilfreich, wenn der Chat nach einem Modellabsturz mit „Internal Server Error" hängt.`}
        >
          {restarting ? "Startet neu…" : "Lokale Laufzeit neu starten"}
        </button>
      </>
    );
  }

  const total = installed.reduce((sum, m) => sum + (m.size ?? 0), 0);

  const onDelete = async (name: string) => {
    setError(null);
    setPendingDelete(name);
    try {
      await window.api.ollama.deleteModel(name);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setPendingDelete(null);
    }
  };

  // Repair: delete + repull. Use case is a model whose runner keeps
  // crashing because partial layers were left on disk by an earlier
  // interrupted pull (pre-8.k10d). Wiping and re-downloading from a
  // clean state is the only reliable fix.
  const onRepair = async (name: string) => {
    if (
      !window.confirm(
        `„${name}" reparieren? Das Modell wird von der Festplatte gelöscht und erneut heruntergeladen. Hilfreich, wenn das Modell die lokale Laufzeit immer wieder zum Absturz bringt.`,
      )
    ) {
      return;
    }
    setError(null);
    setPendingRepair(name);
    try {
      await window.api.ollama.deleteModel(name);
      void pullModelTracked(name).catch(() => undefined);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setPendingRepair(null);
    }
  };

  return (
    <>
      <h4>
        Lokale Modelle auf der Festplatte{" "}
        <span className="muted small">
          ({installed.length} · {formatBytesGB(total)})
        </span>{" "}
        <button
          type="button"
          className="link"
          onClick={onRestart}
          disabled={restarting}
          title={`Stoppt und startet den eingebundenen Ollama-Prozess neu. Hilfreich, wenn der Chat nach einem Modellabsturz mit „Internal Server Error" hängt.`}
        >
          {restarting ? "Startet neu…" : "Laufzeit neu starten"}
        </button>
      </h4>
      {error && <p className="error small">{error}</p>}
      <ul className="installed-models">
        {installed.map((m) => (
          <li key={m.name} className="installed-models__row">
            <code className="installed-models__name">{m.name}</code>
            <span className="muted small">{formatBytesGB(m.size ?? 0)}</span>
            <button
              type="button"
              className="link"
              onClick={() => void onRepair(m.name)}
              disabled={
                pendingRepair === m.name || pendingDelete === m.name
              }
              title="Löschen + erneut herunterladen. Behebt korrupte Layer aus einem unterbrochenen Download. Hilfreich, wenn ein Modell die lokale Laufzeit immer wieder zum Absturz bringt."
            >
              {pendingRepair === m.name ? "Repariert…" : "reparieren"}
            </button>
            <button
              type="button"
              className="link bad"
              onClick={() => {
                if (
                  window.confirm(
                    `„${m.name}" von der Festplatte löschen? Du kannst es später von dieser Seite oder im Chat erneut herunterladen.`,
                  )
                ) {
                  void onDelete(m.name);
                }
              }}
              disabled={
                pendingDelete === m.name || pendingRepair === m.name
              }
              title="Modell von der Festplatte entfernen, um Speicherplatz freizugeben"
            >
              {pendingDelete === m.name ? "Löscht…" : "löschen"}
            </button>
          </li>
        ))}
      </ul>
    </>
  );
}

// -- Ollama download affordance ---------------------------------------

function OllamaDownloadAffordance({ modelId }: { modelId: string }) {
  const installed = useOllamaStore((s) => s.status.installed);
  const activePulls = useOllamaStore((s) => s.activePulls);
  const pullProgress = useOllamaStore((s) => s.pullProgress);

  const targetTag = normaliseOllamaTag(modelId);
  const isInstalled = installed.some(
    (m) => normaliseOllamaTag(m.name) === targetTag,
  );
  const isPulling =
    activePulls[modelId] === true ||
    (pullProgress[modelId] !== undefined &&
      pullProgress[modelId]?.done !== true);

  if (isInstalled) {
    return <p className="muted small ok">Auf der Festplatte ✓</p>;
  }
  if (isPulling) {
    return (
      <p className="muted small">
        Lädt… der Fortschritt ist im Dock unten rechts sichtbar.
      </p>
    );
  }

  return (
    <div className="ollama-dl">
      <p className="muted small warn">
        Dieses Modell ist noch nicht auf der Festplatte. Der Download läuft
        im Hintergrund; du kannst die App weiter nutzen.
      </p>
      <button
        type="button"
        onClick={() => {
          void pullModelTracked(modelId).catch(() => undefined);
        }}
      >
        Modell herunterladen
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
    mutationFn: (apiKey: string) =>
      window.api.agent.setApiKey({ kind, apiKey }),
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
        placeholder={
          hasKey
            ? "•••• gespeichert, neuen Schlüssel einfügen, um zu ersetzen"
            : "API-Schlüssel"
        }
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
        {save.isPending ? "Speichert…" : "Speichern"}
      </button>
      {hasKey && (
        <button
          type="button"
          className="link"
          onClick={() => clear.mutate()}
          disabled={clear.isPending}
          title="Gespeicherten Schlüssel für diesen Anbieter entfernen"
        >
          {clear.isPending ? "Entfernt…" : "entfernen"}
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

// -- General memory section -------------------------------------------
//
// Lists everything `recall_memory` would surface across sessions
// (long-term facts, preferences, ongoing tasks). Mirrors the agent's
// own write/read tools so the user has a manual override — they can
// remove an entry the agent saved by mistake, or audit what's been
// retained. We don't expose a "save new entry" form here because the
// agent is the canonical writer; manual entry would just race with
// the model's own bookkeeping. If we ever need that affordance, the
// `addGeneralMemory` IPC is already wired.

interface GeneralMemoryEntry {
  id: string;
  content: string;
  tags?: string[];
  createdAt: number;
}

// -- Profil (Phase 8.t1) ---------------------------------------------
//
// User-facing editor for the lens the agent applies to every response.
// Direct writes (no propose-and-confirm gate) — the panel IS the
// explicit user surface; the gate exists for agent-inferred updates
// in chat, not for here.

function ProfileSection() {
  const profile = useProfileStore((s) => s.profile);
  const ready = useProfileStore((s) => s.ready);
  const save = useProfileStore((s) => s.save);
  const clearProfile = useProfileStore((s) => s.clear);
  const [bio, setBio] = useState(profile.bio);
  const [role, setRole] = useState(profile.role ?? "");
  const [industries, setIndustries] = useState(
    profile.industries.join(", "),
  );
  const [geographies, setGeographies] = useState(
    profile.geographies.join(", "),
  );
  const [topics, setTopics] = useState(profile.topics.join(", "));
  const [tone, setTone] = useState<string>(profile.tone ?? "");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // Re-sync the form when main pushes a profile change (another
  // window edited; the agent's propose-and-confirm flow accepted a
  // patch). Without this the form stays stale until the user
  // refreshes.
  useEffect(() => {
    setBio(profile.bio);
    setRole(profile.role ?? "");
    setIndustries(profile.industries.join(", "));
    setGeographies(profile.geographies.join(", "));
    setTopics(profile.topics.join(", "));
    setTone(profile.tone ?? "");
  }, [profile]);

  if (!ready) {
    return (
      <section className="provider-section">
        <h3>Profil</h3>
        <p className="muted">Lädt…</p>
      </section>
    );
  }

  const onSave = async () => {
    setBusy(true);
    setError(null);
    try {
      const splitList = (s: string): string[] =>
        s
          .split(",")
          .map((x) => x.trim())
          .filter((x) => x.length > 0);
      await save({
        bio: bio.trim(),
        role: role.trim() ? role.trim() : null,
        industries: splitList(industries),
        geographies: splitList(geographies),
        topics: splitList(topics),
        tone:
          tone === "neutral" || tone === "knapp" || tone === "ausführlich"
            ? tone
            : null,
        // Saving via the panel always implies the user is engaging
        // with the profile — clear the skip flag so the agent
        // doesn't keep avoiding profile suggestions.
        profileSkipped: false,
      });
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  };

  const onClear = async () => {
    if (
      !window.confirm(
        "Profil wirklich zurücksetzen? Bio + Rolle + alle Listen werden geleert.",
      )
    )
      return;
    setBusy(true);
    setError(null);
    try {
      await clearProfile();
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  };

  return (
    <section className="provider-section alerts-prefs">
      <h3>Profil</h3>
      <p className="muted">
        Wird in jeden Agenten-Turn als Lese-Kontext eingewoben. Der
        Agent passt Antworten daran an. Felder optional; was du
        ausfüllst, beeinflusst Tonfall, Filter und Priorisierung.
      </p>

      <div className="alerts-prefs__row">
        <label className="alerts-prefs__label" htmlFor="profile-bio">
          Bio (max. 300 Zeichen)
        </label>
        <textarea
          id="profile-bio"
          rows={3}
          maxLength={300}
          value={bio}
          onChange={(e) => setBio(e.target.value)}
          placeholder="z. B. „Ich arbeite im B2B-Vertrieb für Maschinenbau-Mittelstand in Bayern; Schwerpunkt Geschäftsführer-Wechsel und neue Produktlinien."
          style={{ width: "100%", resize: "vertical" }}
        />
        <p className="muted small">{bio.length} / 300</p>
      </div>

      <div className="alerts-prefs__row">
        <label className="alerts-prefs__label" htmlFor="profile-role">
          Rolle
        </label>
        <input
          id="profile-role"
          type="text"
          value={role}
          onChange={(e) => setRole(e.target.value)}
          placeholder="z. B. „Vertriebsleiter DACH"
          style={{ width: "100%" }}
        />
      </div>

      <div className="alerts-prefs__row">
        <label className="alerts-prefs__label" htmlFor="profile-industries">
          Branchen (Komma-getrennt)
        </label>
        <input
          id="profile-industries"
          type="text"
          value={industries}
          onChange={(e) => setIndustries(e.target.value)}
          placeholder="z. B. „Maschinenbau, Logistik"
          style={{ width: "100%" }}
        />
      </div>

      <div className="alerts-prefs__row">
        <label className="alerts-prefs__label" htmlFor="profile-geographies">
          Regionen
        </label>
        <input
          id="profile-geographies"
          type="text"
          value={geographies}
          onChange={(e) => setGeographies(e.target.value)}
          placeholder="z. B. „Bayern, DACH"
          style={{ width: "100%" }}
        />
      </div>

      <div className="alerts-prefs__row">
        <label className="alerts-prefs__label" htmlFor="profile-topics">
          Schwerpunktthemen
        </label>
        <input
          id="profile-topics"
          type="text"
          value={topics}
          onChange={(e) => setTopics(e.target.value)}
          placeholder="z. B. „Geschäftsführer-Wechsel, Expansion, Übernahmen"
          style={{ width: "100%" }}
        />
      </div>

      <div className="alerts-prefs__row">
        <label className="alerts-prefs__label" htmlFor="profile-tone">
          Bevorzugter Ton
        </label>
        <select
          id="profile-tone"
          value={tone}
          onChange={(e) => setTone(e.target.value)}
        >
          <option value="">keine Vorgabe</option>
          <option value="neutral">Neutral</option>
          <option value="knapp">Knapp</option>
          <option value="ausführlich">Ausführlich</option>
        </select>
      </div>

      <div className="alerts-prefs__actions">
        <button
          type="button"
          className="primary"
          onClick={() => void onSave()}
          disabled={busy}
        >
          {busy ? "Speichert…" : "Profil speichern"}
        </button>
        <button
          type="button"
          className="link bad"
          onClick={() => void onClear()}
          disabled={busy}
        >
          Profil zurücksetzen
        </button>
        {profile.updatedAt && (
          <span className="muted small">
            Zuletzt aktualisiert{" "}
            {new Date(profile.updatedAt).toLocaleString("de-DE")}
          </span>
        )}
      </div>

      {error && <p className="error small">{error}</p>}
    </section>
  );
}

// -- Sprachmodell (Phase 8.n1) ----------------------------------------
//
// Probes + downloads the bundled whisper.cpp + Distil-Whisper-DE GGUF.
// 8.n1 stops at "model present, sidecar ready" — actual recording +
// transcription wires in 8.n2. The UI surfaces:
//   - State chip (binary missing / model missing / downloading / ready / error)
//   - Disk path + size when installed
//   - Download / cancel / remove buttons depending on state

function VoiceSection() {
  const ready = useVoiceStore((s) => s.ready);
  const status = useVoiceStore((s) => s.status);
  const bytesPerSec = useVoiceStore((s) => s.bytesPerSec);
  const download = useVoiceStore((s) => s.download);
  const cancel = useVoiceStore((s) => s.cancel);
  const remove = useVoiceStore((s) => s.remove);
  const [error, setError] = useState<string | null>(null);

  const onDownload = async () => {
    setError(null);
    try {
      await download();
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    }
  };

  const onRemove = async () => {
    if (!window.confirm("Sprachmodell wirklich entfernen?")) return;
    setError(null);
    try {
      await remove();
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    }
  };

  if (!ready) {
    return (
      <section className="provider-section">
        <h3>Sprachmodell</h3>
        <p className="muted">Lädt…</p>
      </section>
    );
  }

  return (
    <section className="provider-section" id="voice-settings">
      <h3>Sprachmodell</h3>
      <p className="muted">
        Lokale Spracherkennung über Whisper. Modell wird auf der Festplatte
        gespeichert; Audio verlässt das Gerät nicht.
      </p>

      <div className="voice-status">
        <VoiceStatusChip state={status.state} />
        {status.model && (
          <>
            <span className="muted">·</span>
            <span>{status.model.label}</span>
          </>
        )}
      </div>

      {status.state === "binary-missing" && (
        <VoiceBinaryInstaller binaryPath={status.binaryPath} />
      )}

      {status.state === "downloading" && status.download && (
        <DownloadBar
          progress={status.download}
          bytesPerSec={bytesPerSec}
          onCancel={() => void cancel()}
        />
      )}

      {status.state === "ready" && status.model && (
        <p className="muted small">
          {fmtBytes(status.model.sizeBytes)} · gespeichert unter{" "}
          <code>{status.model.diskPath}</code>
        </p>
      )}

      {status.state === "error" && status.errorMessage && (
        <p className="error small">{status.errorMessage}</p>
      )}

      <div className="alerts-prefs__actions">
        {(status.state === "model-missing" || status.state === "error") && (
          <button type="button" className="primary" onClick={onDownload}>
            Sprachmodell herunterladen
          </button>
        )}
        {status.state === "ready" && (
          <button
            type="button"
            className="link bad"
            onClick={() => void onRemove()}
          >
            Sprachmodell entfernen
          </button>
        )}
      </div>

      {error && <p className="error small">{error}</p>}
    </section>
  );
}

function VoiceBinaryInstaller({
  binaryPath,
}: {
  binaryPath: string | null;
}) {
  const [busy, setBusy] = useState(false);
  const [logs, setLogs] = useState<string[]>([]);
  const [error, setError] = useState<string | null>(null);

  // Stream brew / install output into the panel so the user can see
  // progress instead of staring at a spinner. We subscribe lazily —
  // only while `busy` so a stale subscription doesn't outlive the
  // component.
  useEffect(() => {
    if (!busy) return;
    const off = window.api.voice.onInstallLog((line) => {
      setLogs((prev) => [...prev.slice(-200), line]);
    });
    return () => off();
  }, [busy]);

  const onInstall = async () => {
    setBusy(true);
    setError(null);
    setLogs([]);
    try {
      await window.api.voice.installBinary();
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="voice-installer">
      <p className="error small voice-installer__head">
        Whisper-Binary fehlt. Erwarteter Pfad:{" "}
        <code>{binaryPath ?? "unbekannt"}</code>.
      </p>
      <p className="muted small">
        Versucht erst eine vorhandene Installation auf dem System zu
        finden, danach <code>brew install whisper-cpp</code> (nur
        macOS). Du musst nichts manuell installieren.
      </p>
      <div className="alerts-prefs__actions">
        <button
          type="button"
          className="primary"
          onClick={() => void onInstall()}
          disabled={busy}
        >
          {busy ? "Installiert…" : "Auto-Installation starten"}
        </button>
      </div>
      {logs.length > 0 && (
        <pre className="voice-installer__log">{logs.join("\n")}</pre>
      )}
      {error && (
        // Multi-line install errors carry copy-pasteable shell
        // commands (Homebrew install one-liner, apt/dnf hints, etc.).
        // Render as `<pre>` to preserve formatting + monospace.
        <pre className="voice-installer__error">{error}</pre>
      )}
    </div>
  );
}

function VoiceStatusChip({
  state,
}: {
  state: ReturnType<typeof useVoiceStore.getState>["status"]["state"];
}) {
  const map: Record<typeof state, { label: string; cls: string }> = {
    idle: { label: "lädt…", cls: "" },
    "binary-missing": { label: "Binary fehlt", cls: "bad" },
    "model-missing": { label: "Modell fehlt", cls: "warn" },
    downloading: { label: "Lädt herunter…", cls: "warn" },
    ready: { label: "Bereit", cls: "ok" },
    error: { label: "Fehler", cls: "bad" },
  };
  const entry = map[state];
  return <span className={`badge ${entry.cls}`}>{entry.label}</span>;
}

function DownloadBar({
  progress,
  bytesPerSec,
  onCancel,
}: {
  progress: { total: number | null; completed: number };
  bytesPerSec: number;
  onCancel: () => void;
}) {
  const pct =
    progress.total && progress.total > 0
      ? Math.min(100, Math.round((progress.completed / progress.total) * 100))
      : null;
  return (
    <div className="voice-download">
      <div className="voice-download__bar">
        <span
          className="voice-download__fill"
          style={{ width: pct === null ? "30%" : `${pct}%` }}
        />
      </div>
      <div className="voice-download__meta muted small">
        {pct === null ? "läuft…" : `${pct} %`}
        {" · "}
        {fmtBytes(progress.completed)}
        {progress.total ? ` / ${fmtBytes(progress.total)}` : ""}
        {bytesPerSec > 0 && ` · ${fmtBytes(bytesPerSec)}/s`}
        {" · "}
        <button type="button" className="link bad" onClick={onCancel}>
          Abbrechen
        </button>
      </div>
    </div>
  );
}

function fmtBytes(n: number): string {
  if (!Number.isFinite(n) || n <= 0) return "0 B";
  const u = ["B", "KB", "MB", "GB"];
  let i = 0;
  let v = n;
  while (v >= 1024 && i < u.length - 1) {
    v /= 1024;
    i++;
  }
  return `${v.toFixed(v < 10 ? 1 : 0)} ${u[i]}`;
}

// -- Alerts / heartbeat section (Phase 8.f3) --------------------------
//
// Surfaces every knob in `AlertPrefs`: cadence, push toggle + severity
// threshold, quiet hours. Lives in Settings instead of `/alerts`
// because all of these are user preferences, not per-row actions.
// Permission status is read-only; if the OS reports push unsupported
// (Linux without libnotify, headless test env, …), the toggle is
// disabled with a hint instead of falsely claiming push works.

const CADENCE_OPTIONS: Array<{ value: AlertCadenceMinutes; label: string }> = [
  { value: 5, label: "Alle 5 Minuten" },
  { value: 15, label: "Alle 15 Minuten" },
  { value: 30, label: "Alle 30 Minuten" },
  { value: 60, label: "Stündlich" },
  { value: 0, label: "Aus (manuell auslösen)" },
];

const SEVERITY_OPTIONS: Array<{ value: AlertSeverity; label: string }> = [
  { value: "info", label: "Alle (Info und höher)" },
  { value: "warn", label: "Ab Achtung" },
  { value: "urgent", label: "Nur Dringend" },
];

function AlertsSection() {
  const [prefs, setPrefs] = useState<AlertPrefs | null>(null);
  const [permission, setPermission] =
    useState<NotificationPermissionStatus | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  // Recent heartbeats with full per-candidate decisions (newest first).
  // Bootstrapped on mount, refreshed after every "Jetzt auslösen" or
  // when an `alerts:changed` push lands. Capped at 10 main-side.
  const [recent, setRecent] = useState<AlertTickInfo[]>([]);

  // Bootstrap + subscribe to main-side prefs changes so two windows
  // (or the heartbeat itself) can't drift out of sync.
  useEffect(() => {
    void window.api.alerts.getPrefs().then(setPrefs);
    void window.api.alerts.getNotificationPermission().then(setPermission);
    void window.api.alerts.recentTicks().then(setRecent);
    const offPrefs = window.api.alerts.onPrefsChanged(setPrefs);
    const offChanged = window.api.alerts.onChanged(() => {
      // The store fires `alerts:changed` after every persisted alert.
      // That's a reasonable proxy for "the heartbeat just finished a
      // tick" — refetch the history so the panel stays current even
      // when ticks fire on schedule (not just from this button).
      void window.api.alerts.recentTicks().then(setRecent);
    });
    return () => {
      offPrefs();
      offChanged();
    };
  }, []);

  if (!prefs) {
    return (
      <section className="provider-section">
        <h3>Meldungen</h3>
        <p className="muted">Lädt…</p>
      </section>
    );
  }

  const patch = async (next: Partial<AlertPrefs>) => {
    setError(null);
    try {
      const updated = await window.api.alerts.setPrefs(next);
      setPrefs(updated);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    }
  };

  const onTrigger = async () => {
    setBusy(true);
    try {
      await window.api.alerts.triggerNow();
      // Always refresh history — the new tick is the first row.
      const ticks = await window.api.alerts.recentTicks();
      setRecent(ticks);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  };

  const pushDisabled = permission ? !permission.available : false;

  return (
    <section className="provider-section alerts-prefs">
      <h3>Meldungen</h3>
      <p className="muted">
        Der Heartbeat sucht im Hintergrund nach alarmwürdigen Vorgängen
        und legt Meldungen ab. Eine vollständige Liste findest du unter{" "}
        <em>Meldungen</em> in der Navigation; rechts oben in der Leiste
        zeigt die Glocke ungelesene Einträge an.
      </p>

      <div className="alerts-prefs__row">
        <label className="alerts-prefs__label" htmlFor="alerts-cadence">
          Heartbeat-Frequenz
        </label>
        <select
          id="alerts-cadence"
          value={prefs.cadenceMinutes}
          onChange={(e) =>
            void patch({
              cadenceMinutes: Number(e.target.value) as AlertCadenceMinutes,
            })
          }
        >
          {CADENCE_OPTIONS.map((o) => (
            <option key={o.value} value={o.value}>
              {o.label}
            </option>
          ))}
        </select>
      </div>

      <div className="alerts-prefs__row">
        <label className="alerts-prefs__check">
          <input
            type="checkbox"
            checked={prefs.pushEnabled}
            disabled={pushDisabled}
            onChange={(e) => void patch({ pushEnabled: e.target.checked })}
          />
          <span>System-Benachrichtigungen aktivieren</span>
        </label>
        {pushDisabled && permission?.reason && (
          <p className="muted small">{permission.reason}</p>
        )}
      </div>

      <div className="alerts-prefs__row">
        <label className="alerts-prefs__label" htmlFor="alerts-severity">
          Schweregrad-Schwelle für Push
        </label>
        <select
          id="alerts-severity"
          value={prefs.pushSeverityThreshold}
          disabled={!prefs.pushEnabled}
          onChange={(e) =>
            void patch({
              pushSeverityThreshold: e.target.value as AlertSeverity,
            })
          }
        >
          {SEVERITY_OPTIONS.map((o) => (
            <option key={o.value} value={o.value}>
              {o.label}
            </option>
          ))}
        </select>
      </div>

      <fieldset className="alerts-prefs__quiet">
        <legend>Ruhezeiten</legend>
        <label className="alerts-prefs__check">
          <input
            type="checkbox"
            checked={prefs.quietHours.enabled}
            onChange={(e) =>
              void patch({
                quietHours: { ...prefs.quietHours, enabled: e.target.checked },
              })
            }
          />
          <span>Während dieses Zeitfensters keine Push-Meldungen</span>
        </label>
        <div className="alerts-prefs__quiet-row">
          <label>
            Von
            <input
              type="time"
              value={minutesToHHMM(prefs.quietHours.startMinute)}
              disabled={!prefs.quietHours.enabled}
              onChange={(e) =>
                void patch({
                  quietHours: {
                    ...prefs.quietHours,
                    startMinute: hhmmToMinutes(e.target.value),
                  },
                })
              }
            />
          </label>
          <label>
            bis
            <input
              type="time"
              value={minutesToHHMM(prefs.quietHours.endMinute)}
              disabled={!prefs.quietHours.enabled}
              onChange={(e) =>
                void patch({
                  quietHours: {
                    ...prefs.quietHours,
                    endMinute: hhmmToMinutes(e.target.value),
                  },
                })
              }
            />
          </label>
        </div>
        <label className="alerts-prefs__check">
          <input
            type="checkbox"
            checked={prefs.quietHours.silenceWeekends}
            onChange={(e) =>
              void patch({
                quietHours: {
                  ...prefs.quietHours,
                  silenceWeekends: e.target.checked,
                },
              })
            }
          />
          <span>Wochenenden ganztägig stumm</span>
        </label>
      </fieldset>

      <div className="alerts-prefs__actions">
        <button type="button" onClick={onTrigger} disabled={busy}>
          {busy ? "Heartbeat läuft…" : "Jetzt Heartbeat auslösen"}
        </button>
      </div>

      {error && <p className="error small">{error}</p>}

      <HeartbeatHistory recent={recent} />
    </section>
  );
}

// -- Heartbeat decision log -------------------------------------------------
//
// Surfaces the last few ticks with their per-candidate decisions. Each
// row in a tick says "Foo GmbH — Pressemeldung — bewertet als nicht
// alarmwürdig: Reine PR ohne Geschäftssubstanz" so the analyst can see
// exactly what the agent considered. Defaults to showing the most
// recent tick expanded; older ticks are collapsed by tick header.

const OUTCOME_LABEL: Record<AlertCandidateDecision["outcome"], string> = {
  alerted: "gemeldet",
  duplicate: "Duplikat",
  "not-worth": "nicht alarmwürdig",
  "judge-error": "Fehler",
};

function HeartbeatHistory({ recent }: { recent: AlertTickInfo[] }) {
  const [openIdx, setOpenIdx] = useState<number | null>(0);

  if (recent.length === 0) {
    return (
      <div className="heartbeat-history heartbeat-history--empty">
        <p className="muted small">
          Noch kein Heartbeat in dieser Sitzung gelaufen. Die Liste füllt
          sich, sobald der erste Sweep ausgeführt wurde.
        </p>
      </div>
    );
  }

  return (
    <div className="heartbeat-history">
      <h4 className="heartbeat-history__title">Letzte Heartbeats</h4>
      <ul className="heartbeat-history__list">
        {recent.map((tick, idx) => {
          const open = openIdx === idx;
          return (
            <li
              key={tick.startedAt + idx}
              className={`heartbeat-tick${open ? " heartbeat-tick--open" : ""}`}
            >
              <button
                type="button"
                className="heartbeat-tick__header"
                onClick={() => setOpenIdx(open ? null : idx)}
                aria-expanded={open}
              >
                <span className="heartbeat-tick__chevron" aria-hidden>
                  {open ? "▾" : "▸"}
                </span>
                <span className="heartbeat-tick__time">
                  {formatTickTime(tick.startedAt)}
                </span>
                <span className="muted heartbeat-tick__summary">
                  {summariseTick(tick)}
                </span>
              </button>
              {open && <DecisionList tick={tick} />}
            </li>
          );
        })}
      </ul>
    </div>
  );
}

function DecisionList({ tick }: { tick: AlertTickInfo }) {
  if (tick.skipped) {
    return (
      <p className="muted small heartbeat-tick__detail">
        Tick übersprungen{tick.reason ? `: ${tick.reason}` : ""}.
      </p>
    );
  }
  if (tick.decisions.length === 0) {
    return (
      <p className="muted small heartbeat-tick__detail">
        Keine neuen Kandidaten in diesem Sweep. Der Heartbeat fragt die
        Quellen seit dem letzten Lauf ab. Wenn nichts hereingekommen
        ist, gibt es nichts zu bewerten.
      </p>
    );
  }
  return (
    <ul className="heartbeat-decisions">
      {tick.decisions.map((d, i) => (
        <li
          key={d.sourceRef + i}
          className={`heartbeat-decision heartbeat-decision--${d.outcome}`}
        >
          <div className="heartbeat-decision__row">
            <span className="heartbeat-decision__company">
              {d.companyName}
            </span>
            <span
              className={`heartbeat-decision__outcome heartbeat-decision__outcome--${d.outcome}`}
            >
              {OUTCOME_LABEL[d.outcome]}
              {d.outcome === "alerted" && d.severity ? ` (${d.severity})` : ""}
            </span>
          </div>
          <div className="muted small heartbeat-decision__summary">
            {d.summary}
          </div>
          {d.rationale && (
            <div className="heartbeat-decision__rationale">{d.rationale}</div>
          )}
        </li>
      ))}
    </ul>
  );
}

function summariseTick(t: AlertTickInfo): string {
  if (t.skipped) {
    return `übersprungen${t.reason ? ` (${t.reason})` : ""}`;
  }
  const parts: string[] = [];
  parts.push(
    `${t.candidatesSeen} ${t.candidatesSeen === 1 ? "Kandidat" : "Kandidaten"} geprüft`,
  );
  if (t.alertsCreated > 0) {
    parts.push(
      `${t.alertsCreated} neue ${t.alertsCreated === 1 ? "Meldung" : "Meldungen"}`,
    );
  }
  if (t.duplicates > 0) parts.push(`${t.duplicates} Duplikat(e)`);
  return parts.join(" · ");
}

function formatTickTime(iso: string): string {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return iso;
  const today = new Date();
  const sameDay =
    d.getFullYear() === today.getFullYear() &&
    d.getMonth() === today.getMonth() &&
    d.getDate() === today.getDate();
  if (sameDay) {
    return d.toLocaleTimeString("de-DE", {
      hour: "2-digit",
      minute: "2-digit",
      second: "2-digit",
    });
  }
  return d.toLocaleString("de-DE");
}

// `<input type="time">` works with `HH:MM`; prefs store minutes-since-
// midnight. The conversion is trivial but lives here so the JSX stays
// readable.
function minutesToHHMM(m: number): string {
  const h = Math.floor(m / 60);
  const min = m % 60;
  return `${String(h).padStart(2, "0")}:${String(min).padStart(2, "0")}`;
}
function hhmmToMinutes(s: string): number {
  const m = /^(\d{1,2}):(\d{2})$/.exec(s);
  if (!m) return 0;
  return Number(m[1]) * 60 + Number(m[2]);
}

// -- Freshness scheduler section (Phase 8.r3) -------------------------
//
// Mirrors the AlertsSection pattern: master toggle + per-stage cadence
// inputs + throttle ceilings + "Jetzt scannen" button. The decision
// log under the trigger button shows the latest tick's
// candidate/dispatched rows so the analyst can see the queue acting
// without leaving Settings.

const FRESHNESS_STAGES: Array<{
  stage: FreshnessStage;
  label: string;
  hint: string;
}> = [
  {
    stage: "companyContact",
    label: "Kontakte",
    hint: "Personalwechsel; wöchentlich ist sinnvoll.",
  },
  {
    stage: "companyProfile",
    label: "Profil",
    hint: "Stammdaten-Drift, Adressen, Geschäftsführung.",
  },
  {
    stage: "website",
    label: "Website-Crawl",
    hint: "Webseite-Änderungen; ~wöchentlich.",
  },
  {
    stage: "companyEvaluation",
    label: "Bewertung",
    hint: "LLM-abgeleitete Sicht; aktualisiert sich nach Profil/Kontakt.",
  },
  {
    stage: "structuredContent",
    label: "Strukturierte Inhalte",
    hint: "Aggregierte Sicht; monatlich genügt.",
  },
  {
    stage: "companyPublication",
    label: "Publikationen",
    hint: "Geschäftsberichte; ~quartalsweise.",
  },
];

function FreshnessSection() {
  const [prefs, setPrefs] = useState<FreshnessPrefs | null>(null);
  const [recent, setRecent] = useState<FreshnessTickInfo[]>([]);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    void window.api.freshness.getPrefs().then(setPrefs);
    void window.api.freshness.recentTicks().then(setRecent);
    const off = window.api.freshness.onPrefsChanged(setPrefs);
    return () => off();
  }, []);

  if (!prefs) {
    return (
      <section className="provider-section">
        <h3>Aktualisierung</h3>
        <p className="muted">Lädt…</p>
      </section>
    );
  }

  const patch = async (next: Partial<FreshnessPrefs>) => {
    setError(null);
    try {
      const updated = await window.api.freshness.setPrefs(next);
      setPrefs(updated);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    }
  };

  const onScan = async () => {
    setBusy(true);
    try {
      await window.api.freshness.triggerNow();
      const ticks = await window.api.freshness.recentTicks();
      setRecent(ticks);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  };

  const onUnpin = (companyId: string) => {
    void patch({
      pinned: prefs.pinned.filter((id) => id !== companyId),
    });
  };

  return (
    <section className="provider-section alerts-prefs">
      <h3>Aktualisierung</h3>
      <p className="muted">
        Hintergrund-Loop, der Pipeline-Stages je Firma erneut anstößt,
        wenn sie ihre Cadence überschritten haben. Stille Disk-Arbeit;
        echte Änderungen erscheinen über den Heartbeat als Meldung.
      </p>

      <div className="alerts-prefs__row">
        <label className="alerts-prefs__check">
          <input
            type="checkbox"
            checked={prefs.enabled}
            onChange={(e) => void patch({ enabled: e.target.checked })}
          />
          <span>Auto-Aktualisierung aktivieren</span>
        </label>
      </div>

      <fieldset className="alerts-prefs__quiet">
        <legend>Cadence pro Schritt (Tage)</legend>
        <div className="freshness-cadences">
          {FRESHNESS_STAGES.map(({ stage, label, hint }) => (
            <label key={stage} className="freshness-cadence-row">
              <span className="freshness-cadence-row__label">{label}</span>
              <input
                type="number"
                min={0}
                step={1}
                value={prefs.cadenceDays[stage]}
                disabled={!prefs.enabled}
                onChange={(e) =>
                  void patch({
                    cadenceDays: {
                      ...prefs.cadenceDays,
                      [stage]: Math.max(
                        0,
                        Math.round(Number(e.target.value) || 0),
                      ),
                    },
                  })
                }
              />
              <span className="muted small freshness-cadence-row__hint">
                {hint} <em>0 = aus</em>
              </span>
            </label>
          ))}
        </div>
      </fieldset>

      <fieldset className="alerts-prefs__quiet">
        <legend>Drosselung</legend>
        <div className="alerts-prefs__quiet-row">
          <label>
            Max. Aufrufe pro Stunde (Schritt)
            <input
              type="number"
              min={0}
              max={50}
              step={1}
              value={prefs.throttle.perStagePerHour}
              disabled={!prefs.enabled}
              onChange={(e) =>
                void patch({
                  throttle: {
                    ...prefs.throttle,
                    perStagePerHour: Math.max(
                      0,
                      Math.round(Number(e.target.value) || 0),
                    ),
                  },
                })
              }
            />
          </label>
          <label>
            Max. Aufrufe pro Stunde (gesamt)
            <input
              type="number"
              min={0}
              max={200}
              step={1}
              value={prefs.throttle.globalPerHour}
              disabled={!prefs.enabled}
              onChange={(e) =>
                void patch({
                  throttle: {
                    ...prefs.throttle,
                    globalPerHour: Math.max(
                      0,
                      Math.round(Number(e.target.value) || 0),
                    ),
                  },
                })
              }
            />
          </label>
          <label>
            Pro Tick maximal
            <input
              type="number"
              min={0}
              max={50}
              step={1}
              value={prefs.topKPerTick}
              disabled={!prefs.enabled}
              onChange={(e) =>
                void patch({
                  topKPerTick: Math.max(
                    0,
                    Math.round(Number(e.target.value) || 0),
                  ),
                })
              }
            />
          </label>
        </div>
      </fieldset>

      {prefs.pinned.length > 0 && (
        <div className="alerts-prefs__row">
          <label className="alerts-prefs__label">Priorisierte Firmen</label>
          <div className="freshness-pins">
            {prefs.pinned.map((id) => (
              <span key={id} className="freshness-pin">
                <code>{id.length > 16 ? id.slice(0, 14) + "…" : id}</code>
                <button
                  type="button"
                  className="link bad"
                  onClick={() => onUnpin(id)}
                  title="Entfernen"
                >
                  ×
                </button>
              </span>
            ))}
          </div>
        </div>
      )}

      <div className="alerts-prefs__actions">
        <button type="button" onClick={onScan} disabled={busy}>
          {busy ? "Scan läuft…" : "Jetzt scannen"}
        </button>
      </div>

      {error && <p className="error small">{error}</p>}

      <FreshnessHistory recent={recent} />
    </section>
  );
}

function FreshnessHistory({ recent }: { recent: FreshnessTickInfo[] }) {
  const [openIdx, setOpenIdx] = useState<number | null>(0);

  // Batch-resolve company names across every visible tick. The
  // pipeline endpoint that drives the freshness scheduler doesn't
  // carry names (heavy fan-out already), so the scheduler stores
  // `companyName: null`. Same lookup pattern TransactionDetail uses;
  // 5-min staleTime since master-data names rarely change.
  const companyIds = useMemo(() => {
    const seen = new Set<string>();
    for (const tick of recent) {
      for (const c of tick.candidates) {
        if (c.companyId) seen.add(c.companyId);
      }
    }
    return Array.from(seen).sort();
  }, [recent]);

  const namesQuery = useQuery({
    queryKey: ["freshnessCompanyNames", companyIds],
    queryFn: async () => {
      const map = new Map<string, string>();
      await Promise.all(
        companyIds.map(async (cid) => {
          try {
            const data = await gatewayFetch<{
              name?: string | null;
              companyName?: string | null;
            }>(`/v1/companies/${encodeURIComponent(cid)}`);
            const n = data.name ?? data.companyName;
            if (n && n.trim().length > 0) map.set(cid, n.trim());
          } catch {
            // Leave unresolved; renderer falls back to the id slice.
          }
        }),
      );
      return map;
    },
    enabled: companyIds.length > 0,
    staleTime: 5 * 60_000,
  });

  const nameFor = (cid: string): string =>
    namesQuery.data?.get(cid) ?? `${cid.slice(0, 12)}…`;

  if (recent.length === 0) {
    return (
      <div className="heartbeat-history heartbeat-history--empty">
        <p className="muted small">
          Noch kein Aktualisierungs-Lauf in dieser Sitzung. Klick „Jetzt
          scannen“ um die Warteschlange zu sehen.
        </p>
      </div>
    );
  }
  return (
    <div className="heartbeat-history">
      <h4 className="heartbeat-history__title">Letzte Aktualisierungs-Läufe</h4>
      <ul className="heartbeat-history__list">
        {recent.map((tick, idx) => {
          const open = openIdx === idx;
          return (
            <li
              key={tick.startedAt + idx}
              className={`heartbeat-tick${open ? " heartbeat-tick--open" : ""}`}
            >
              <button
                type="button"
                className="heartbeat-tick__header"
                onClick={() => setOpenIdx(open ? null : idx)}
                aria-expanded={open}
              >
                <span className="heartbeat-tick__chevron" aria-hidden>
                  {open ? "▾" : "▸"}
                </span>
                <span className="heartbeat-tick__time">
                  {formatFreshnessTickTime(tick.startedAt)}
                </span>
                <span className="muted heartbeat-tick__summary">
                  {summariseFreshnessTick(tick)}
                </span>
              </button>
              {open && (
                <FreshnessTickDetail tick={tick} nameFor={nameFor} />
              )}
            </li>
          );
        })}
      </ul>
    </div>
  );
}

function FreshnessTickDetail({
  tick,
  nameFor,
}: {
  tick: FreshnessTickInfo;
  nameFor: (companyId: string) => string;
}) {
  if (tick.skipped) {
    return (
      <p className="muted small heartbeat-tick__detail">
        Übersprungen{tick.reason ? `: ${tick.reason}` : ""}.
      </p>
    );
  }
  if (tick.candidates.length === 0) {
    return (
      <p className="muted small heartbeat-tick__detail">
        Keine veralteten Zellen. Alles innerhalb der konfigurierten Cadence.
      </p>
    );
  }
  const dispatchedKey = (companyId: string, stage: string) =>
    `${companyId}::${stage}`;
  const dispatchedSet = new Set(
    tick.dispatched.map((d) => dispatchedKey(d.companyId, d.stage)),
  );
  return (
    <ul className="heartbeat-decisions">
      {tick.candidates.map((c, i) => {
        const dispatched = dispatchedSet.has(
          dispatchedKey(c.companyId, c.stage),
        );
        return (
          <li
            key={c.companyId + c.stage + i}
            className={`heartbeat-decision heartbeat-decision--${dispatched ? "alerted" : "not-worth"}`}
          >
            <div className="heartbeat-decision__row">
              <Link
                to={`/companies/${encodeURIComponent(c.companyId)}`}
                className="heartbeat-decision__company"
                title="Firmendetail öffnen"
              >
                {c.companyName ?? nameFor(c.companyId)}
              </Link>
              <span
                className={`heartbeat-decision__outcome heartbeat-decision__outcome--${dispatched ? "alerted" : "not-worth"}`}
              >
                {dispatched ? "neu gestartet" : "übersprungen"}
              </span>
            </div>
            <div className="muted small heartbeat-decision__summary">
              {c.stage} · {Math.round(c.daysSinceLastRun)}d /{" "}
              {c.cadenceDays}d Cadence · Score {c.score.toFixed(2)}
              {c.pinned ? " · pinned" : ""}
            </div>
          </li>
        );
      })}
    </ul>
  );
}

function summariseFreshnessTick(t: FreshnessTickInfo): string {
  if (t.skipped) {
    return `übersprungen${t.reason ? ` (${t.reason})` : ""}`;
  }
  const parts: string[] = [];
  parts.push(`${t.cellsInspected} Zellen geprüft`);
  if (t.staleFound > 0) parts.push(`${t.staleFound} veraltet`);
  if (t.dispatched.length > 0)
    parts.push(`${t.dispatched.length} neu gestartet`);
  return parts.join(" · ");
}

function formatFreshnessTickTime(iso: string): string {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return iso;
  const today = new Date();
  const sameDay =
    d.getFullYear() === today.getFullYear() &&
    d.getMonth() === today.getMonth() &&
    d.getDate() === today.getDate();
  if (sameDay) {
    return d.toLocaleTimeString("de-DE", {
      hour: "2-digit",
      minute: "2-digit",
      second: "2-digit",
    });
  }
  return d.toLocaleString("de-DE");
}

function GeneralMemorySection() {
  const qc = useQueryClient();
  const [pendingId, setPendingId] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  const memory = useQuery<GeneralMemoryEntry[]>({
    queryKey: ["agent", "generalMemory"],
    queryFn: () => window.api.agent.listGeneralMemory(),
  });

  const onRemove = async (id: string, content: string) => {
    if (
      !window.confirm(
        `Diesen Eintrag vergessen?\n\n„${content.length > 200 ? content.slice(0, 197) + "…" : content}"\n\nDer Agent ruft ihn in zukünftigen Sitzungen nicht mehr ab.`,
      )
    ) {
      return;
    }
    setError(null);
    setPendingId(id);
    try {
      await window.api.agent.removeGeneralMemory(id);
      await qc.invalidateQueries({ queryKey: ["agent", "generalMemory"] });
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setPendingId(null);
    }
  };

  return (
    <section className="provider-section">
      <h3>Langzeitgedächtnis</h3>
      <p className="muted small">
        Fakten, die der Agent über Konversationen hinweg gespeichert hat
        (Präferenzen, laufende Aufgaben, Dinge, an die er sich erinnern soll).
        Er ruft sie über <code>recall_memory</code> ab, wenn eine Frage auf
        früheren Kontext hindeutet. Einträge, die der Agent nicht mehr kennen
        soll, kannst du entfernen.
      </p>
      {memory.isLoading && <p className="muted">Lädt…</p>}
      {memory.error && (
        <p className="error">{(memory.error as Error).message}</p>
      )}
      {error && <p className="error small">{error}</p>}
      {memory.data && memory.data.length === 0 && (
        <p className="muted small">
          Noch kein Langzeitgedächtnis vorhanden. Der Agent legt Einträge an,
          wenn du ihn um etwas zu merken bittest oder eine stabile Präferenz
          erkennt.
        </p>
      )}
      {memory.data && memory.data.length > 0 && (
        <ul className="memory-list">
          {memory.data.map((entry) => (
            <li key={entry.id} className="memory-list__row">
              <div className="memory-list__content">{entry.content}</div>
              <div className="memory-list__meta muted small">
                {formatRelativeDate(entry.createdAt)}
                {entry.tags && entry.tags.length > 0 && (
                  <>
                    {" · "}
                    {entry.tags.map((t) => (
                      <span key={t} className="memory-list__tag">
                        {t}
                      </span>
                    ))}
                  </>
                )}
              </div>
              <button
                type="button"
                className="link bad"
                onClick={() => void onRemove(entry.id, entry.content)}
                disabled={pendingId === entry.id}
                title="Diesen Eintrag vergessen, der Agent ruft ihn nicht mehr ab"
              >
                {pendingId === entry.id ? "Vergisst…" : "vergessen"}
              </button>
            </li>
          ))}
        </ul>
      )}
    </section>
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

// `installed[].size` from Ollama is reported in binary GB (1024^3) — we
// keep both helpers because the catalog's `approxBytes` is decimal.
function formatBytesGB(bytes: number): string {
  if (!bytes) return "0 MB";
  const gib = bytes / (1024 * 1024 * 1024);
  if (gib >= 1) return `${gib.toFixed(1)} GB`;
  const mib = bytes / (1024 * 1024);
  return `${Math.round(mib)} MB`;
}

// Mirror of `normaliseTag` from main/ollama-models.ts. Kept inline
// because the renderer can't import from `main/`. Load-bearing for
// "is this model on disk" comparisons; if you change the rules in one
// place, change them here too.
function normaliseOllamaTag(name: string): string {
  const lastSlash = name.lastIndexOf("/");
  const tail = lastSlash >= 0 ? name.slice(lastSlash + 1) : name;
  return tail.includes(":") ? tail : `${tail}:latest`;
}

function formatRelativeDate(ts: number): string {
  const diffMs = Date.now() - ts;
  const min = 60_000;
  const hr = 60 * min;
  const day = 24 * hr;
  if (diffMs < min) return "gerade eben";
  if (diffMs < hr) return `vor ${Math.floor(diffMs / min)} Min.`;
  if (diffMs < day) return `vor ${Math.floor(diffMs / hr)} Std.`;
  if (diffMs < 7 * day) return `vor ${Math.floor(diffMs / day)} Tagen`;
  return new Date(ts).toLocaleDateString("de-DE");
}

// -- Plan & Abrechnung (M2/M3 monetization) ---------------------------------
//
// Shows the current tier, the per-period usage bar, and the two action
// buttons (Upgrade for free/starter; Verwalten for any tenant with a
// Stripe customer link). The IPC paths are non-blocking — main opens
// the Stripe URL in the user's default browser; the renderer just
// shows a loading state while the gateway round-trips.
//
// Section id `plan-section` is the deep-link target for the topbar
// pill (`/settings#plan-section`).

const TIER_LABELS: Record<BillingTier, string> = {
  free: "Free",
  starter: "Starter",
  pro: "Pro",
  enterprise: "Enterprise",
};

function PlanSection() {
  const { data, isLoading, error, refetch } = useUsage();
  const [busy, setBusy] = useState<"checkout-starter" | "checkout-pro" | "portal" | null>(
    null,
  );
  const [opError, setOpError] = useState<string | null>(null);

  async function openCheckout(tier: "starter" | "pro") {
    setOpError(null);
    setBusy(`checkout-${tier}`);
    try {
      await window.api.billing.openCheckout(tier);
    } catch (e) {
      setOpError((e as Error).message);
    } finally {
      setBusy(null);
    }
  }

  async function openPortal() {
    setOpError(null);
    setBusy("portal");
    try {
      await window.api.billing.openPortal();
    } catch (e) {
      setOpError((e as Error).message);
    } finally {
      setBusy(null);
    }
  }

  return (
    <section id="plan-section" className="ct-card" style={{ marginBottom: "1.25rem" }}>
      <header className="ct-card__header">
        <h3>Plan &amp; Abrechnung</h3>
        <p className="muted">Aktueller Tarif und Verbrauch im Abrechnungszyklus.</p>
      </header>

      {isLoading && <p className="muted">Lädt…</p>}
      {error && (
        <div className="error">
          Verbrauch konnte nicht geladen werden.
          <button type="button" onClick={() => void refetch()} style={{ marginLeft: 8 }}>
            Erneut versuchen
          </button>
        </div>
      )}

      {data && (
        <div style={{ display: "grid", gap: "0.75rem" }}>
          <div style={{ display: "flex", alignItems: "center", gap: "0.5rem" }}>
            <span className={`badge badge--${data.tier}`}>{TIER_LABELS[data.tier]}</span>
            {data.tier === "enterprise" && (
              <span className="muted">unbegrenztes Kontingent</span>
            )}
          </div>

          {!isUnlimited(data) && (
            <div>
              <div
                style={{
                  display: "flex",
                  justifyContent: "space-between",
                  fontSize: "0.9rem",
                }}
              >
                <strong>
                  {data.used} von {data.limit} verbraucht
                </strong>
                {data.periodEnd && (
                  <span className="muted">
                    Erneuert sich am {fmtDateShort(data.periodEnd)}
                  </span>
                )}
              </div>
              <div
                role="progressbar"
                aria-valuemin={0}
                aria-valuemax={data.limit}
                aria-valuenow={data.used}
                style={{
                  height: 8,
                  background: "var(--surface-2, #e5e7eb)",
                  borderRadius: 4,
                  overflow: "hidden",
                  marginTop: 4,
                }}
              >
                <div
                  style={{
                    width: `${Math.min(100, (data.used / Math.max(1, data.limit)) * 100)}%`,
                    height: "100%",
                    background:
                      data.used >= data.limit
                        ? "var(--danger, #dc2626)"
                        : data.used / data.limit >= 0.8
                          ? "var(--warn, #d97706)"
                          : "var(--accent, #00c0a7)",
                    transition: "width 200ms ease",
                  }}
                />
              </div>
              <small className="muted">
                {data.periodKey === "lifetime"
                  ? "Lebenszeit-Kontingent (Free-Tier)"
                  : "Verbrauch im aktuellen Zyklus"}
              </small>
            </div>
          )}

          <div style={{ display: "flex", gap: "0.5rem", flexWrap: "wrap" }}>
            {(data.tier === "free" || data.tier === "starter") && (
              <>
                {data.tier === "free" && (
                  <button
                    type="button"
                    className="primary"
                    disabled={busy !== null}
                    onClick={() => void openCheckout("starter")}
                  >
                    {busy === "checkout-starter"
                      ? "Wird geöffnet…"
                      : "Auf Starter upgraden (49 €/Monat)"}
                  </button>
                )}
                <button
                  type="button"
                  className="primary"
                  disabled={busy !== null}
                  onClick={() => void openCheckout("pro")}
                >
                  {busy === "checkout-pro"
                    ? "Wird geöffnet…"
                    : "Auf Pro upgraden (149 €/Monat)"}
                </button>
              </>
            )}
            <button
              type="button"
              disabled={busy !== null}
              onClick={() => void openPortal()}
              title="Stripe-Kundenportal öffnen (Rechnungen, Zahlungsmethoden, Kündigung)"
            >
              {busy === "portal" ? "Wird geöffnet…" : "Verwalten"}
            </button>
          </div>

          {opError && <div className="error">{opError}</div>}
        </div>
      )}
    </section>
  );
}

function fmtDateShort(iso: string): string {
  try {
    return new Date(iso).toLocaleDateString("de-DE", {
      day: "2-digit",
      month: "2-digit",
      year: "numeric",
    });
  } catch {
    return iso;
  }
}

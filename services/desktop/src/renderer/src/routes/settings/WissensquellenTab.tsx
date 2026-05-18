import { useEffect, useState } from "react";
import type {
  KnowledgeProviderKind,
  KnowledgeProviderStatus,
  KnowledgeProvidersSnapshot,
} from "../../../../shared/types";

// v0.1.225 — Settings → Wissensquellen mit Notion-Connect/Disconnect.
//
// Pro Provider eine Card. Aktuell hat nur Notion einen verbindenden
// Pfad (P2). Obsidian zeigt einen Disabled-Hinweis bis P3.
//
// Connect-Flow:
//   1. User klickt "Verbinden" → Form mit Token-Input + Anleitung
//   2. Form-Submit ruft window.api.knowledge.connect({ kind, token })
//   3. Bei Erfolg: Snapshot wird aktualisiert, Card zeigt "verbunden"
//   4. Bei Fehler (401/403/Netz): Error-Message inline, Token NICHT
//      persistiert (Adapter speichert vor der Validierung, validiert,
//      bei Failure setzen wir error-Status — der token bleibt im
//      Keychain bis User explizit disconnect klickt)

export function WissensquellenTab() {
  const [snapshot, setSnapshot] = useState<KnowledgeProvidersSnapshot | null>(
    null,
  );
  const [activeConnect, setActiveConnect] = useState<KnowledgeProviderKind | null>(
    null,
  );

  useEffect(() => {
    let cancelled = false;
    void window.api.knowledge.getSnapshot().then((s) => {
      if (!cancelled) setSnapshot(s);
    });
    const off = window.api.knowledge.onSnapshotChanged((s) => {
      if (!cancelled) setSnapshot(s);
    });
    return () => {
      cancelled = true;
      off();
    };
  }, []);

  if (!snapshot) {
    return (
      <section className="provider-section">
        <h3>Wissensquellen</h3>
        <p className="muted">Lädt…</p>
      </section>
    );
  }

  return (
    <section className="provider-section">
      <h3>Wissensquellen</h3>
      <p className="muted">
        Verbinde AVA mit deinem Notion-Workspace oder Obsidian-Vault.
        AVA kann darin lesen, suchen und schreiben — z. B. neue
        CRM-Einträge anlegen, Notizen erweitern oder Termine als
        Erinnerung übernehmen. Tokens bleiben verschlüsselt im
        OS-Schlüsselbund.
      </p>
      {!snapshot.encryptionAvailable && (
        <p className="warn">
          ⚠ OS-Schlüsselbund nicht verfügbar — Wissensquellen-Tokens
          können nicht sicher gespeichert werden. Bitte
          libsecret/Schlüsselbund-Dienst aktivieren und neu starten.
        </p>
      )}
      <div className="wissensquellen-cards">
        {snapshot.providers.map((p) => (
          <ProviderCard
            key={p.kind}
            status={p}
            connecting={activeConnect === p.kind}
            onStartConnect={() => setActiveConnect(p.kind)}
            onCancelConnect={() => setActiveConnect(null)}
            onSnapshotChanged={(s) => {
              setSnapshot(s);
              setActiveConnect(null);
            }}
          />
        ))}
      </div>
    </section>
  );
}

function ProviderCard({
  status,
  connecting,
  onStartConnect,
  onCancelConnect,
  onSnapshotChanged,
}: {
  status: KnowledgeProviderStatus;
  connecting: boolean;
  onStartConnect: () => void;
  onCancelConnect: () => void;
  onSnapshotChanged: (s: KnowledgeProvidersSnapshot) => void;
}) {
  const meta = PROVIDER_META[status.kind];
  const supported = SUPPORTED_PROVIDERS.includes(status.kind);

  return (
    <div className="provider-key-card">
      <div className="provider-key-card__header">
        <span className="provider-key-card__title">{meta.name}</span>
        {status.connected ? (
          <span className="badge ok">verbunden</span>
        ) : supported ? (
          <span className="badge">noch nicht verbunden</span>
        ) : (
          <span className="badge">demnächst</span>
        )}
      </div>
      <p className="provider-key-card__description">{meta.descr}</p>
      {status.displayName && status.connected && (
        <p className="muted small">
          Workspace: <code>{status.displayName}</code>
        </p>
      )}
      {status.lastSyncAt && status.connected && (
        <p className="muted small">
          Verbunden seit {new Date(status.lastSyncAt).toLocaleString("de-DE")}
        </p>
      )}
      {status.errorMessage && (
        <p className="error small">{status.errorMessage}</p>
      )}

      {supported && !status.connected && !connecting && (
        <button type="button" onClick={onStartConnect}>
          Verbinden
        </button>
      )}

      {supported && status.connected && (
        <button
          type="button"
          className="link bad"
          onClick={async () => {
            const next = await window.api.knowledge.disconnect({
              kind: status.kind,
            });
            onSnapshotChanged(next);
          }}
        >
          Trennen
        </button>
      )}

      {!supported && (
        <p className="muted small">
          <em>Folgt in einer kommenden Version.</em>
        </p>
      )}

      {supported && connecting && (
        <NotionConnectForm
          kind={status.kind}
          onCancel={onCancelConnect}
          onConnected={onSnapshotChanged}
        />
      )}
    </div>
  );
}

function NotionConnectForm({
  kind,
  onCancel,
  onConnected,
}: {
  kind: KnowledgeProviderKind;
  onCancel: () => void;
  onConnected: (s: KnowledgeProvidersSnapshot) => void;
}) {
  const [token, setToken] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const onSubmit = async (): Promise<void> => {
    if (token.trim().length === 0) {
      setError("Bitte Token eingeben.");
      return;
    }
    setBusy(true);
    setError(null);
    try {
      const next = await window.api.knowledge.connect({ kind, token });
      onConnected(next);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="wissensquellen-connect">
      <ol className="wissensquellen-steps">
        <li>
          Öffne{" "}
          <a
            href="https://www.notion.so/profile/integrations"
            onClick={(e) => {
              e.preventDefault();
              void window.api.shell.openExternal(
                "https://www.notion.so/profile/integrations",
              );
            }}
          >
            notion.so/profile/integrations
          </a>{" "}
          und erstelle eine neue Integration (Name z. B. „AVA").
        </li>
        <li>
          Wähle „Internal integration", aktiviere mindestens Read /
          Update / Insert content, speichere.
        </li>
        <li>
          Kopier den „Internal Integration Token" (beginnt mit{" "}
          <code>ntn_</code> oder <code>secret_</code>).
        </li>
        <li>
          <strong>Wichtig:</strong> Geh in Notion zu der Seite oder
          Datenbank, mit der AVA arbeiten soll, klick rechts oben auf{" "}
          <code>...</code> → <code>Connections</code> → AVA hinzufügen.
        </li>
        <li>Token unten einfügen und „Verbinden" klicken.</li>
      </ol>
      <input
        type="password"
        placeholder="ntn_… oder secret_…"
        value={token}
        onChange={(e) => setToken(e.target.value)}
        autoComplete="off"
        spellCheck={false}
        disabled={busy}
      />
      {error && <p className="error small">{error}</p>}
      <div className="actions">
        <button
          type="button"
          onClick={() => void onSubmit()}
          disabled={busy || token.trim().length === 0}
        >
          {busy ? "Verbinde…" : "Verbinden"}
        </button>
        <button
          type="button"
          className="link"
          onClick={onCancel}
          disabled={busy}
        >
          Abbrechen
        </button>
      </div>
    </div>
  );
}

const PROVIDER_META: Record<KnowledgeProviderKind, { name: string; descr: string }> = {
  notion: {
    name: "Notion",
    descr:
      "Lese und schreibe in deinen Notion-Workspace — Datenbanken, Seiten, CRM-Einträge. Anmeldung via Integration-Token.",
  },
  obsidian: {
    name: "Obsidian",
    descr:
      "Verbinde dein Vault über das offizielle Local-REST-API-Plugin. AVA liest, sucht und schreibt Markdown-Notizen.",
  },
};

/** Provider mit funktionierender Connect-UI in dieser Version. */
const SUPPORTED_PROVIDERS: KnowledgeProviderKind[] = ["notion"];

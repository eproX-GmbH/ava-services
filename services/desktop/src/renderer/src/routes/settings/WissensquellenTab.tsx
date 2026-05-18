import { useEffect, useState } from "react";
import type { KnowledgeProvidersSnapshot } from "../../../../shared/types";

// v0.1.224 — Settings → Wissensquellen.
//
// Phase 1 ist Foundation: das Framework existiert (siehe
// `main/knowledge/store.ts`), aber noch keine Provider sind
// angeschlossen. Dieser Tab zeigt die geplante Liste mit dem aktuellen
// Verbindungsstatus pro Provider — sobald P2 (Notion) live ist, wird
// dort der Verbinden-Button funktional.
//
// Der Tab steht bewusst NICHT unter "CRM" — Notion/Obsidian sind keine
// formalen CRMs, auch wenn man sie so nutzen kann. Eigene Kategorie.

const PROVIDER_LABELS: Record<string, { name: string; descr: string }> = {
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

export function WissensquellenTab() {
  const [snapshot, setSnapshot] = useState<KnowledgeProvidersSnapshot | null>(
    null,
  );

  useEffect(() => {
    let cancelled = false;
    void window.api.knowledge.getSnapshot().then((s) => {
      if (!cancelled) setSnapshot(s);
    });
    const off = window.api.knowledge.onSnapshotChanged((s) => {
      setSnapshot(s);
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
      <ul className="kv">
        {snapshot.providers.map((p) => {
          const meta = PROVIDER_LABELS[p.kind] ?? {
            name: p.kind,
            descr: "",
          };
          return (
            <li key={p.kind}>
              <div className="kv__item-head">
                <strong>{meta.name}</strong>{" "}
                {p.connected ? (
                  <span className="badge ok">verbunden</span>
                ) : (
                  <span className="badge">noch nicht verbunden</span>
                )}
              </div>
              <p className="muted small">{meta.descr}</p>
              {p.displayName && (
                <p className="muted small">
                  Aktiv: <code>{p.displayName}</code>
                </p>
              )}
              {p.errorMessage && (
                <p className="error small">{p.errorMessage}</p>
              )}
              <p className="muted small">
                <em>
                  Anbindung folgt in der nächsten Version (Notion zuerst,
                  dann Obsidian).
                </em>
              </p>
            </li>
          );
        })}
      </ul>
    </section>
  );
}

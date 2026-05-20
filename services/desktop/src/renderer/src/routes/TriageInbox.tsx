// v0.1.257 — Triage-Inbox-Route (Phase 9.m).
//
// Zeigt eingehende Mails aus AVAs dediziertem Konto als sortierbare
// Liste mit Trust-Badge (trusted/known/unknown), AVAs Klassifikation,
// und Per-Mail-Aktionen (Detail öffnen, archivieren, als trusted
// markieren via Allowlist-Add).
//
// Layout: Master-Detail. Links die Liste, rechts der ausgewählte
// Mail-Body inkl. Anhänge. Snapshot wird bei jeder Änderung im main-
// Process gepusht (`mail:snapshot`), kein Polling.

import { useEffect, useMemo, useState } from "react";
import { Link } from "react-router-dom";
import type {
  MailMessage,
  MailSnapshot,
} from "../../../shared/types";

type Filter = "all" | "unread" | "trusted" | "known" | "unknown";

export function TriageInbox(): JSX.Element {
  const [snapshot, setSnapshot] = useState<MailSnapshot | null>(null);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [detail, setDetail] = useState<MailMessage | null>(null);
  const [filter, setFilter] = useState<Filter>("unread");

  useEffect(() => {
    void window.api.mail.snapshot().then(setSnapshot);
    const off = window.api.mail.onSnapshot(setSnapshot);
    return () => off();
  }, []);

  useEffect(() => {
    if (!selectedId) {
      setDetail(null);
      return;
    }
    void window.api.mail.getMessage(selectedId).then(setDetail);
  }, [selectedId]);

  const messages = snapshot?.messages ?? [];

  const filtered = useMemo(() => {
    return messages.filter((m) => {
      if (filter === "all") return true;
      if (filter === "unread") return !m.readByUser;
      return m.trustLevel === filter;
    });
  }, [messages, filter]);

  if (!snapshot) {
    return (
      <div className="triage-inbox">
        <p className="muted">Lädt…</p>
      </div>
    );
  }

  if (!snapshot.account) {
    return (
      <div className="triage-inbox triage-inbox--empty">
        <h2>Triage-Inbox</h2>
        <p>Du hast noch kein Mail-Konto konfiguriert.</p>
        <p>
          <Link to="/settings/datenquellen#mail-account-section">
            → Mail-Konto in Einstellungen hinzufügen
          </Link>
        </p>
      </div>
    );
  }

  return (
    <div className="triage-inbox">
      <header className="triage-inbox__header">
        <h2>Triage-Inbox</h2>
        <div className="triage-inbox__meta muted">
          {snapshot.account.address} · {snapshot.connectionState}
          {snapshot.unreadCount > 0 && <> · {snapshot.unreadCount} ungelesen</>}
        </div>
        <div className="triage-inbox__filters">
          {(
            [
              ["unread", "Ungelesen"],
              ["all", "Alle"],
              ["trusted", "Trusted"],
              ["known", "Bekannt"],
              ["unknown", "Unbekannt"],
            ] as Array<[Filter, string]>
          ).map(([key, label]) => (
            <button
              key={key}
              type="button"
              className={filter === key ? "active" : ""}
              onClick={() => setFilter(key)}
            >
              {label}
            </button>
          ))}
        </div>
      </header>

      <div className="triage-inbox__split">
        <ul className="triage-inbox__list">
          {filtered.length === 0 && (
            <li className="muted">Keine Mails in diesem Filter.</li>
          )}
          {filtered.map((m) => (
            <li
              key={m.id}
              className={`triage-row triage-row--${m.trustLevel} ${
                selectedId === m.id ? "is-selected" : ""
              } ${m.readByUser ? "" : "is-unread"}`}
              onClick={() => setSelectedId(m.id)}
            >
              <div className="triage-row__top">
                <TrustBadge level={m.trustLevel} />
                <span className="triage-row__from">
                  {m.from.name ?? m.from.address}
                </span>
                <span className="triage-row__date muted">
                  {formatDate(m.date)}
                </span>
              </div>
              <div className="triage-row__subject">{m.subject || "(kein Betreff)"}</div>
              {m.classification && (
                <div className="triage-row__summary muted">
                  <span className={`category category--${m.classification.category}`}>
                    {m.classification.category}
                  </span>{" "}
                  · {m.classification.summary}
                </div>
              )}
              {m.classification && m.classification.injectionRisk >= 0.5 && (
                <div className="triage-row__warn">
                  ⚠ Prompt-Injection-Verdacht ({Math.round(m.classification.injectionRisk * 100)}%)
                </div>
              )}
            </li>
          ))}
        </ul>

        <div className="triage-inbox__detail">
          {detail ? <MessageDetail message={detail} /> : (
            <p className="muted">Wähle links eine Mail aus.</p>
          )}
        </div>
      </div>
    </div>
  );
}

function MessageDetail({ message }: { message: MailMessage }): JSX.Element {
  const [busy, setBusy] = useState(false);

  const onArchive = async (): Promise<void> => {
    setBusy(true);
    try {
      await window.api.mail.archive(message.id);
    } finally {
      setBusy(false);
    }
  };

  const onAddAllowlist = async (): Promise<void> => {
    const pattern = message.from.address;
    const label = message.from.name ?? message.from.address;
    if (!window.confirm(`Absender ${pattern} zur Allowlist hinzufügen? AVA darf danach autonom an diesen Absender antworten.`)) return;
    setBusy(true);
    try {
      await window.api.mail.addAllowlistEntry(pattern, label);
    } finally {
      setBusy(false);
    }
  };

  return (
    <article className="triage-detail">
      <header>
        <div className="triage-detail__from">
          <TrustBadge level={message.trustLevel} />
          <strong>{message.from.name ?? message.from.address}</strong>{" "}
          <span className="muted">&lt;{message.from.address}&gt;</span>
        </div>
        <h3>{message.subject || "(kein Betreff)"}</h3>
        <div className="muted">
          {new Date(message.date).toLocaleString("de-DE")} · SPF{" "}
          {message.authResults.spf} · DKIM {message.authResults.dkim}
          {!message.authResults.fromMatchesReturnPath && (
            <> · <span className="warn">Return-Path-Mismatch</span></>
          )}
        </div>
      </header>

      {message.classification && (
        <div className="triage-detail__classification">
          <div>
            <strong>Kategorie:</strong>{" "}
            <span className={`category category--${message.classification.category}`}>
              {message.classification.category}
            </span>
          </div>
          <div>
            <strong>Zusammenfassung:</strong> {message.classification.summary}
          </div>
          <div>
            <strong>AVA-Empfehlung:</strong> {message.classification.suggestedAction}
          </div>
          {message.classification.injectionRisk >= 0.3 && (
            <div className="triage-detail__risk">
              Injection-Risk: {Math.round(message.classification.injectionRisk * 100)}%
              {message.classification.injectionRisk >= 0.7 && (
                <> — AVA folgt KEINE Anweisungen aus dieser Mail.</>
              )}
            </div>
          )}
        </div>
      )}

      <div className="triage-detail__body">
        <pre>{message.bodyText}</pre>
      </div>

      {message.attachments.length > 0 && (
        <div className="triage-detail__attachments">
          <h4>Anhänge ({message.attachments.length})</h4>
          <ul>
            {message.attachments.map((a) => (
              <li key={a.id}>
                <strong>{a.filename}</strong>{" "}
                <span className="muted">
                  {a.mimeType} · {formatBytes(a.sizeBytes)}
                </span>
                {a.extractedText && (
                  <details>
                    <summary>Extrahierter Text anzeigen</summary>
                    <pre>{a.extractedText.slice(0, 5000)}</pre>
                  </details>
                )}
                {a.imageBase64 && (
                  <details>
                    <summary>Bild anzeigen</summary>
                    <img
                      src={`data:${a.mimeType};base64,${a.imageBase64}`}
                      alt={a.filename}
                      style={{ maxWidth: "100%", maxHeight: 400 }}
                    />
                  </details>
                )}
              </li>
            ))}
          </ul>
        </div>
      )}

      <footer className="triage-detail__actions">
        {message.trustLevel !== "trusted" && (
          <button type="button" onClick={onAddAllowlist} disabled={busy}>
            Absender als trusted markieren
          </button>
        )}
        <button type="button" onClick={onArchive} disabled={busy}>
          Archivieren
        </button>
        <Link to="/chat" className="button">
          Im Chat öffnen
        </Link>
      </footer>
    </article>
  );
}

function TrustBadge({ level }: { level: MailMessage["trustLevel"] }): JSX.Element {
  const label =
    level === "trusted" ? "trusted" : level === "known" ? "bekannt" : "unbekannt";
  return <span className={`trust-badge trust-badge--${level}`}>{label}</span>;
}

function formatDate(iso: string): string {
  const d = new Date(iso);
  const today = new Date();
  if (d.toDateString() === today.toDateString()) {
    return d.toLocaleTimeString("de-DE", { hour: "2-digit", minute: "2-digit" });
  }
  return d.toLocaleDateString("de-DE", { day: "2-digit", month: "2-digit" });
}

function formatBytes(n: number): string {
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
  return `${(n / 1024 / 1024).toFixed(1)} MB`;
}

// v0.1.282 — Triage-Inbox-Route v2 (Outlook-orientiertes Layout).
//
// Layout-Struktur:
//   - Toolbar oben (Filter, Account-Status, Unread-Counter)
//   - Hauptbereich: Master-Detail (Liste links, Mail-Pane rechts)
//   - Liste: kompakte Outlook-Zeilen mit Absender + Zeit, Betreff,
//     Snippet + Trust/Kategorie-Badges. Ungelesen fett.
//   - Detail: Toolbar mit Aktionen (Archivieren, Im Chat öffnen,
//     trusted-markieren) + sauberer Header (Absender, Betreff, Meta)
//     + AVA-Klassifikation als kleine Info-Karte + Body als
//     Plain-Text (gerendert mit pre-wrap für Zeilen-Treue).
//
// "Im Chat öffnen" startet einen NEUEN Chat mit prefill aus der Mail
// (Absender + Subject + Body-Quote), damit der Kontext nicht verloren
// geht. Mehrzeiligkeit wird via newline-Pass durch React-Router-state
// erhalten.

import { useEffect, useMemo, useState } from "react";
import { Link, useNavigate } from "react-router-dom";
import type { MailMessage, MailSnapshot } from "../../../shared/types";

type Filter = "all" | "unread" | "trusted" | "known" | "unknown";

const FILTER_LABELS: Array<[Filter, string]> = [
  ["unread", "Ungelesen"],
  ["all", "Alle"],
  ["trusted", "Trusted"],
  ["known", "Bekannt"],
  ["unknown", "Unbekannt"],
];

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

  // Counts pro Filter — kleine Hilfe für die Tab-Pillen.
  const counts = useMemo(() => {
    const c = { all: messages.length, unread: 0, trusted: 0, known: 0, unknown: 0 };
    for (const m of messages) {
      if (!m.readByUser) c.unread += 1;
      if (m.trustLevel === "trusted") c.trusted += 1;
      else if (m.trustLevel === "known") c.known += 1;
      else c.unknown += 1;
    }
    return c;
  }, [messages]);

  if (!snapshot) {
    return (
      <div className="triage">
        <div className="triage__empty">
          <p className="muted">Lädt…</p>
        </div>
      </div>
    );
  }

  if (!snapshot.account) {
    return (
      <div className="triage">
        <div className="triage__empty">
          <h2>Triage-Inbox</h2>
          <p>Du hast noch kein Mail-Konto konfiguriert.</p>
          <p>
            <Link to="/settings/datenquellen#mail-account-section">
              → Mail-Konto in Einstellungen hinzufügen
            </Link>
          </p>
        </div>
      </div>
    );
  }

  return (
    <div className="triage">
      <header className="triage__toolbar">
        <div className="triage__toolbar-left">
          <h2 className="triage__title">Postfach</h2>
          <span className="triage__account">{snapshot.account.address}</span>
          <ConnectionPill state={snapshot.connectionState} />
        </div>
        <nav className="triage__filters" aria-label="Filter">
          {FILTER_LABELS.map(([key, label]) => {
            const count =
              key === "all"
                ? counts.all
                : key === "unread"
                  ? counts.unread
                  : key === "trusted"
                    ? counts.trusted
                    : key === "known"
                      ? counts.known
                      : counts.unknown;
            return (
              <button
                key={key}
                type="button"
                className={
                  "triage__filter" +
                  (filter === key ? " triage__filter--active" : "")
                }
                onClick={() => setFilter(key)}
              >
                {label}
                <span className="triage__filter-count">{count}</span>
              </button>
            );
          })}
        </nav>
      </header>

      <div className="triage__main">
        <ul className="triage__list" role="listbox">
          {filtered.length === 0 && (
            <li className="triage__list-empty muted">
              Keine Mails in diesem Filter.
            </li>
          )}
          {filtered.map((m) => (
            <MessageRow
              key={m.id}
              message={m}
              selected={selectedId === m.id}
              onSelect={() => setSelectedId(m.id)}
            />
          ))}
        </ul>

        <section className="triage__detail" aria-label="Mail-Detail">
          {detail ? (
            <MessageDetail message={detail} />
          ) : (
            <div className="triage__detail-empty">
              <p className="muted">Wähle links eine Mail aus.</p>
            </div>
          )}
        </section>
      </div>
    </div>
  );
}

function MessageRow({
  message,
  selected,
  onSelect,
}: {
  message: MailMessage;
  selected: boolean;
  onSelect: () => void;
}): JSX.Element {
  const senderName = message.from.name ?? message.from.address;
  const cls = message.classification;
  return (
    <li
      className={
        "triage__row" +
        (selected ? " triage__row--selected" : "") +
        (!message.readByUser ? " triage__row--unread" : "")
      }
      onClick={onSelect}
      role="option"
      aria-selected={selected}
    >
      <div className="triage__row-line1">
        <span className="triage__row-sender">{senderName}</span>
        <span className="triage__row-date">{formatDate(message.date)}</span>
      </div>
      <div className="triage__row-subject">
        {message.subject || "(kein Betreff)"}
      </div>
      <div className="triage__row-meta">
        <TrustBadge level={message.trustLevel} compact />
        {cls && (
          <span className={`triage__category triage__category--${cls.category}`}>
            {categoryLabel(cls.category)}
          </span>
        )}
        {message.attachments.length > 0 && (
          <span className="triage__row-attach" title="Mit Anhang">
            📎 {message.attachments.length}
          </span>
        )}
        {cls && cls.injectionRisk >= 0.5 && (
          <span className="triage__row-warn" title="Prompt-Injection-Verdacht">
            ⚠ {Math.round(cls.injectionRisk * 100)}%
          </span>
        )}
      </div>
      {cls?.summary && (
        <div className="triage__row-snippet">{cls.summary}</div>
      )}
    </li>
  );
}

function MessageDetail({ message }: { message: MailMessage }): JSX.Element {
  const [busy, setBusy] = useState(false);
  const navigate = useNavigate();

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
    if (
      !window.confirm(
        `Absender ${pattern} zur Allowlist hinzufügen? AVA darf danach autonom an diesen Absender antworten.`,
      )
    )
      return;
    setBusy(true);
    try {
      await window.api.mail.addAllowlistEntry(pattern, label);
    } finally {
      setBusy(false);
    }
  };

  const onOpenInChat = (): void => {
    // v0.1.282 — Statt nur zum Chat zu navigieren bauen wir einen
    // Prefill-Block mit Kontext aus der Mail (Absender, Betreff,
    // Body-Quote). Chat.tsx liest location.state.prefill, startet einen
    // neuen Chat und füllt den Composer. Mehrzeilige Bodies bleiben
    // mehrzeilig.
    const senderName = message.from.name ?? message.from.address;
    const lines = [
      `Mail von ${senderName} <${message.from.address}> vom ${new Date(
        message.date,
      ).toLocaleString("de-DE")}`,
      `Betreff: ${message.subject || "(kein Betreff)"}`,
      "",
      "Inhalt:",
      message.bodyText.trim() || "(leer)",
      "",
      "Bitte hilf mir damit weiter.",
    ];
    const prefill = lines.join("\n");
    navigate("/chat", { state: { prefill } });
  };

  const cls = message.classification;
  return (
    <article className="triage-detail">
      <div className="triage-detail__toolbar">
        <button
          type="button"
          onClick={onOpenInChat}
          disabled={busy}
          className="triage-detail__btn triage-detail__btn--primary"
        >
          Im Chat öffnen
        </button>
        {message.trustLevel !== "trusted" && (
          <button
            type="button"
            onClick={onAddAllowlist}
            disabled={busy}
            className="triage-detail__btn"
          >
            Absender als trusted
          </button>
        )}
        <button
          type="button"
          onClick={onArchive}
          disabled={busy}
          className="triage-detail__btn"
        >
          Archivieren
        </button>
      </div>

      <header className="triage-detail__header">
        <h3 className="triage-detail__subject">
          {message.subject || "(kein Betreff)"}
        </h3>
        <div className="triage-detail__sender-line">
          <TrustBadge level={message.trustLevel} />
          <div className="triage-detail__sender">
            <strong>{message.from.name ?? message.from.address}</strong>
            {message.from.name && (
              <span className="muted"> &lt;{message.from.address}&gt;</span>
            )}
          </div>
          <span className="triage-detail__date muted">
            {new Date(message.date).toLocaleString("de-DE")}
          </span>
        </div>
        <div className="triage-detail__auth muted">
          SPF {message.authResults.spf} · DKIM {message.authResults.dkim}
          {!message.authResults.fromMatchesReturnPath && (
            <>
              {" · "}
              <span className="warn">Return-Path-Mismatch</span>
            </>
          )}
        </div>
      </header>

      {cls && (
        <div className="triage-detail__ai-card">
          <div className="triage-detail__ai-header">
            <span className="triage-detail__ai-label">AVA-Klassifikation</span>
            <span className={`triage__category triage__category--${cls.category}`}>
              {categoryLabel(cls.category)}
            </span>
            <span className="triage-detail__ai-action">
              Empfehlung: {actionLabel(cls.suggestedAction)}
            </span>
          </div>
          <div className="triage-detail__ai-summary">{cls.summary}</div>
          {cls.injectionRisk >= 0.3 && (
            <div className="triage-detail__risk">
              ⚠ Injection-Risk {Math.round(cls.injectionRisk * 100)}%
              {cls.injectionRisk >= 0.7 && (
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
              <li key={a.id} className="triage-detail__attach">
                <div className="triage-detail__attach-line">
                  <strong>{a.filename}</strong>
                  <span className="muted">
                    {a.mimeType} · {formatBytes(a.sizeBytes)}
                  </span>
                </div>
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
                      className="triage-detail__attach-image"
                    />
                  </details>
                )}
              </li>
            ))}
          </ul>
        </div>
      )}
    </article>
  );
}

function TrustBadge({
  level,
  compact,
}: {
  level: MailMessage["trustLevel"];
  compact?: boolean;
}): JSX.Element {
  const label =
    level === "trusted" ? "trusted" : level === "known" ? "bekannt" : "unbekannt";
  return (
    <span
      className={`trust-badge trust-badge--${level}${compact ? " trust-badge--compact" : ""}`}
    >
      {label}
    </span>
  );
}

function ConnectionPill({
  state,
}: {
  state: MailSnapshot["connectionState"];
}): JSX.Element {
  const label =
    state === "connecting"
      ? "verbinde…"
      : state === "connected"
        ? "verbunden"
        : state === "idling"
          ? "IDLE"
          : state === "polling"
            ? "Polling"
            : state === "disconnected"
              ? "getrennt"
              : "Fehler";
  return <span className={`pill pill--${state}`}>{label}</span>;
}

function categoryLabel(c: string): string {
  switch (c) {
    case "task":
      return "Aufgabe";
    case "info":
      return "Info";
    case "appointment":
      return "Termin";
    case "crm-relevant":
      return "CRM";
    case "spam":
      return "Spam";
    case "phishing":
      return "Phishing";
    default:
      return "Unklar";
  }
}

function actionLabel(a: string): string {
  switch (a) {
    case "reply":
      return "Antworten";
    case "archive":
      return "Archivieren";
    case "forward":
      return "Weiterleiten";
    case "ignore":
      return "Ignorieren";
    case "ask-user":
      return "Rückfrage";
    default:
      return a;
  }
}

function formatDate(iso: string): string {
  const d = new Date(iso);
  const today = new Date();
  if (d.toDateString() === today.toDateString()) {
    return d.toLocaleTimeString("de-DE", { hour: "2-digit", minute: "2-digit" });
  }
  // gestern?
  const yesterday = new Date(today);
  yesterday.setDate(today.getDate() - 1);
  if (d.toDateString() === yesterday.toDateString()) return "Gestern";
  // diese Woche → Wochentag-Kurz
  const diffDays = Math.floor((today.getTime() - d.getTime()) / 86_400_000);
  if (diffDays < 7) {
    return d.toLocaleDateString("de-DE", { weekday: "short" });
  }
  return d.toLocaleDateString("de-DE", { day: "2-digit", month: "2-digit" });
}

function formatBytes(n: number): string {
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
  return `${(n / 1024 / 1024).toFixed(1)} MB`;
}

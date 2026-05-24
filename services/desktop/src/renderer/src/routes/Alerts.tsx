import { useMemo, useState } from "react";
import { Link } from "react-router-dom";
import { useAlertsStore } from "../store/alerts";
import type { Alert, AlertKind, AlertSeverity } from "../../../shared/types";

// `/alerts` route (Phase 8.f1).
//
// Reverse-chronological list of heartbeat-generated alerts, grouped by
// day. Each row shows: severity dot, company link, headline, relative
// time, and the rationale (collapsed). Hover/click reveals the rationale
// and per-row actions: "Gelesen markieren" (clears the unread badge)
// and "Verwerfen" (hides the row permanently — still on disk for audit).
//
// Filters are intentionally minimal in 8.f1: "Alle / Ungelesen" and the
// "Jetzt auslösen" trigger button. The richer filter chips (this week /
// this month / by severity) wait for 8.f2 alongside the bell + popover.

const KIND_LABEL: Record<AlertKind, string> = {
  publication: "Publikation",
  "financial-delta": "Finanzkennzahl",
  "profile-change": "Profiländerung",
  "evaluation-flag": "Bewertungs-Flag",
  "linkedin-signal": "LinkedIn-Signal",
  reminder: "Erinnerung",
};

const SEVERITY_LABEL: Record<AlertSeverity, string> = {
  info: "Info",
  warn: "Achtung",
  urgent: "Dringend",
};

export function Alerts() {
  const { alerts, ready, markSeen, dismiss, triggerNow } = useAlertsStore();
  const [filter, setFilter] = useState<"all" | "unread">("all");
  const [expandedId, setExpandedId] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const visible = useMemo(() => {
    if (filter === "unread") return alerts.filter((a) => a.seenAt === null);
    return alerts;
  }, [alerts, filter]);

  const grouped = useMemo(() => groupByDay(visible), [visible]);

  const onTrigger = async () => {
    setBusy(true);
    try {
      await triggerNow();
    } finally {
      setBusy(false);
    }
  };

  return (
    <section className="alerts">
      <header className="alerts__header">
        <div className="ct-page-header" style={{ marginBottom: 0, flex: 1 }}>
          <p className="ct-page-header__eyebrow">Heartbeat</p>
          <h2 className="ct-page-header__title">
            <span className="ct-gradient-text">Meldungen</span>
          </h2>
          <p className="ct-page-header__lede">
            Alarmwürdige Vorgänge aus dem Heartbeat-Sweep, neueste zuerst.
          </p>
        </div>
        <div className="alerts__toolbar">
          <div className="alerts__filters">
            <button
              type="button"
              className={filter === "all" ? "primary" : ""}
              onClick={() => setFilter("all")}
            >
              Alle ({alerts.length})
            </button>
            <button
              type="button"
              className={filter === "unread" ? "primary" : ""}
              onClick={() => setFilter("unread")}
            >
              Ungelesen ({alerts.filter((a) => a.seenAt === null).length})
            </button>
          </div>
          <button type="button" onClick={onTrigger} disabled={busy}>
            {busy ? "Heartbeat läuft…" : "Jetzt auslösen"}
          </button>
        </div>
      </header>

      {!ready && <p className="muted">Lädt…</p>}
      {ready && visible.length === 0 && (
        <div className="alerts__empty">
          <p>
            <strong>Nichts Neues.</strong>
          </p>
          <p className="muted">
            AVA meldet sich, sobald sich etwas tut. Der Heartbeat läuft
            standardmäßig alle 15 Minuten.
          </p>
        </div>
      )}

      {grouped.map(([day, rows]) => (
        <section key={day} className="alerts__day">
          <h3 className="alerts__day-label">{day}</h3>
          <ul className="alerts__list">
            {rows.map((a) => {
              const expanded = expandedId === a.id;
              return (
                <li
                  key={a.id}
                  className={`alert${a.seenAt === null ? " alert--unread" : ""}`}
                  onClick={() => {
                    setExpandedId(expanded ? null : a.id);
                    if (a.seenAt === null) void markSeen(a.id);
                  }}
                >
                  <div className="alert__row">
                    <span
                      className={`alert__dot alert__dot--${a.severity}`}
                      aria-label={SEVERITY_LABEL[a.severity]}
                      title={SEVERITY_LABEL[a.severity]}
                    />
                    <div className="alert__main">
                      <div className="alert__headline">{a.headline}</div>
                      <div className="alert__meta muted">
                        <Link
                          to={`/companies/${a.companyId}`}
                          onClick={(e) => e.stopPropagation()}
                        >
                          {a.companyName}
                        </Link>
                        <span className="alert__sep">·</span>
                        <span>{KIND_LABEL[a.kind]}</span>
                        <span className="alert__sep">·</span>
                        <span>{formatRelative(a.createdAt)}</span>
                      </div>
                    </div>
                    {a.seenAt === null && (
                      <span className="alert__unread-pill">neu</span>
                    )}
                  </div>
                  {expanded && (
                    <div
                      className="alert__detail"
                      onClick={(e) => e.stopPropagation()}
                    >
                      <p>{a.rationale}</p>
                      <div className="alert__actions">
                        <Link to={`/companies/${a.companyId}`}>
                          Im Firmenkontext öffnen →
                        </Link>
                        <button
                          type="button"
                          className="link bad"
                          onClick={(e) => {
                            e.stopPropagation();
                            void dismiss(a.id);
                          }}
                        >
                          Verwerfen
                        </button>
                      </div>
                    </div>
                  )}
                </li>
              );
            })}
          </ul>
        </section>
      ))}
    </section>
  );
}

// ---- Helpers ---------------------------------------------------------------

function groupByDay(rows: Alert[]): Array<[string, Alert[]]> {
  const groups: Record<string, Alert[]> = {};
  const order: string[] = [];
  for (const r of rows) {
    const label = dayLabel(r.createdAt);
    if (!(label in groups)) {
      groups[label] = [];
      order.push(label);
    }
    groups[label]!.push(r);
  }
  return order.map((k) => [k, groups[k]!]);
}

function dayLabel(iso: string): string {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return "";
  const today = new Date();
  const startOfDay = (x: Date) =>
    new Date(x.getFullYear(), x.getMonth(), x.getDate()).getTime();
  const diffDays = Math.round(
    (startOfDay(today) - startOfDay(d)) / 86_400_000,
  );
  if (diffDays === 0) return "Heute";
  if (diffDays === 1) return "Gestern";
  if (diffDays < 7) return `Vor ${diffDays} Tagen`;
  return d.toLocaleDateString("de-DE", {
    year: "numeric",
    month: "long",
    day: "numeric",
  });
}

function formatRelative(iso: string): string {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return "";
  const diff = Date.now() - d.getTime();
  if (diff < 60_000) return "gerade eben";
  if (diff < 3_600_000) return `vor ${Math.round(diff / 60_000)} Min.`;
  if (diff < 86_400_000) return `vor ${Math.round(diff / 3_600_000)} Std.`;
  return d.toLocaleString("de-DE");
}

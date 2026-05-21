// v0.1.200 — Verlauf (Audit-Trail) Settings-Tab.
//
// Renders the chronological event-list from the local PGlite-backed
// audit store. Data flow:
//   - `audit:list` IPC: paginated fetch for the visible window.
//   - `audit:inserted` IPC: live-tail subscription; new events
//      prepend without a re-fetch.
//   - `audit:purgeAll` IPC: destructive reset (confirm-prompt).
//
// Layout: filter sidebar on the left, event-list on the right. The
// list shows 1 line per event (timestamp · category badge ·
// severity dot · summary) with an expandable details row containing
// the full metadata JSON.
//
// Privacy: all data is local; no cloud round-trip. The empty state
// explicitly mentions this so the user knows their actions aren't
// going anywhere.

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type {
  AuditCategory,
  AuditEvent,
  AuditListQuery,
  AuditSeverity,
  SelfCorrectionEvent,
} from "../../../../shared/types";

const ALL_CATEGORIES: AuditCategory[] = [
  "producer",
  "linkedin",
  "crm",
  "auth",
  "import",
  "watch",
  "scheduler",
  "billing",
  "update",
  "agent",
];

const ALL_SEVERITIES: AuditSeverity[] = ["info", "warning", "error"];

const CATEGORY_LABEL: Record<AuditCategory, string> = {
  producer: "Producer",
  linkedin: "LinkedIn",
  crm: "CRM",
  auth: "Authentifizierung",
  import: "Import",
  watch: "Beobachter",
  scheduler: "Hintergrund-Jobs",
  billing: "Kosten",
  update: "App-Update",
  agent: "Chat-Agent",
};

const SEVERITY_LABEL: Record<AuditSeverity, string> = {
  info: "Info",
  warning: "Warnung",
  error: "Fehler",
};

const TIME_RANGES = [
  { id: "1h", label: "Letzte Stunde", minutes: 60 },
  { id: "24h", label: "Heute (24h)", minutes: 24 * 60 },
  { id: "7d", label: "7 Tage", minutes: 7 * 24 * 60 },
  { id: "30d", label: "30 Tage", minutes: 30 * 24 * 60 },
  { id: "all", label: "Gesamt", minutes: null },
] as const;
type TimeRangeId = (typeof TIME_RANGES)[number]["id"];

const PAGE_SIZE = 50;

export function VerlaufTab(): JSX.Element {
  return (
    <>
      <SelfCorrectionsSection />
      <AuditTrailSection />
    </>
  );
}

function AuditTrailSection(): JSX.Element {
  // Filter state
  const [categories, setCategories] = useState<Set<AuditCategory>>(
    new Set(ALL_CATEGORIES),
  );
  const [severities, setSeverities] = useState<Set<AuditSeverity>>(
    new Set(ALL_SEVERITIES),
  );
  const [timeRange, setTimeRange] = useState<TimeRangeId>("7d");
  const [search, setSearch] = useState("");
  const [live, setLive] = useState(true);

  // Data state
  const [events, setEvents] = useState<AuditEvent[]>([]);
  const [nextPageToken, setNextPageToken] = useState<string | null>(null);
  const [totalEstimate, setTotalEstimate] = useState<number>(-1);
  const [loading, setLoading] = useState(false);
  const [expandedId, setExpandedId] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  // Build the IPC query from current filter state.
  const baseQuery = useMemo((): AuditListQuery => {
    const range = TIME_RANGES.find((r) => r.id === timeRange);
    const since =
      range?.minutes != null
        ? new Date(Date.now() - range.minutes * 60_000).toISOString()
        : undefined;
    return {
      since,
      categories:
        categories.size === ALL_CATEGORIES.length
          ? undefined
          : Array.from(categories),
      severities:
        severities.size === ALL_SEVERITIES.length
          ? undefined
          : Array.from(severities),
      search: search.trim() || undefined,
      pageSize: PAGE_SIZE,
    };
  }, [timeRange, categories, severities, search]);

  // (re)load first page when filters change.
  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    setError(null);
    window.api.audit
      .list(baseQuery)
      .then((res) => {
        if (cancelled) return;
        setEvents(res.events);
        setNextPageToken(res.nextPageToken);
        setTotalEstimate(res.totalEstimate);
        setLoading(false);
      })
      .catch((err) => {
        if (cancelled) return;
        setError(err instanceof Error ? err.message : String(err));
        setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [baseQuery]);

  // Live subscription. New events prepend if they match the current
  // filter, otherwise are silently dropped (they'd show up in the
  // next manual reload anyway).
  const matchesFilter = useCallback(
    (e: AuditEvent): boolean => {
      if (categories.size < ALL_CATEGORIES.length && !categories.has(e.category))
        return false;
      if (severities.size < ALL_SEVERITIES.length && !severities.has(e.severity))
        return false;
      const range = TIME_RANGES.find((r) => r.id === timeRange);
      if (range?.minutes != null) {
        const ageMin = (Date.now() - new Date(e.timestamp).getTime()) / 60_000;
        if (ageMin > range.minutes) return false;
      }
      if (search.trim()) {
        const needle = search.trim().toLowerCase();
        const haystack = `${e.summary} ${e.action}`.toLowerCase();
        if (!haystack.includes(needle)) return false;
      }
      return true;
    },
    [categories, severities, timeRange, search],
  );
  useEffect(() => {
    if (!live) return;
    return window.api.audit.onInserted((event) => {
      if (!matchesFilter(event)) return;
      setEvents((prev) => [event, ...prev].slice(0, 500));
    });
  }, [live, matchesFilter]);

  const loadMore = async (): Promise<void> => {
    if (!nextPageToken || loading) return;
    setLoading(true);
    try {
      const res = await window.api.audit.list({
        ...baseQuery,
        pageToken: nextPageToken,
      });
      setEvents((prev) => [...prev, ...res.events]);
      setNextPageToken(res.nextPageToken);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setLoading(false);
    }
  };

  const exportJson = (): void => {
    const blob = new Blob([JSON.stringify(events, null, 2)], {
      type: "application/json",
    });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = `ava-audit-${new Date().toISOString().slice(0, 19)}.json`;
    a.click();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
  };

  const purgeAll = async (): Promise<void> => {
    const ok = window.confirm(
      "Den gesamten Audit-Trail unwiderruflich löschen? Diese Aktion betrifft nur deine lokale Datenbank — keine Cloud-Daten.",
    );
    if (!ok) return;
    await window.api.audit.purgeAll();
    setEvents([]);
    setNextPageToken(null);
    setTotalEstimate(0);
  };

  // Helpers for the filter UI
  const toggleCategory = (cat: AuditCategory): void => {
    setCategories((prev) => {
      const next = new Set(prev);
      next.has(cat) ? next.delete(cat) : next.add(cat);
      return next;
    });
  };
  const toggleSeverity = (sev: AuditSeverity): void => {
    setSeverities((prev) => {
      const next = new Set(prev);
      next.has(sev) ? next.delete(sev) : next.add(sev);
      return next;
    });
  };
  // v0.1.203 — bulk select-all / clear-all helpers for the
  // category + severity groups. A single click on the group's
  // header checkbox flips between "everything selected" and
  // "nothing selected"; intermediate states show as
  // indeterminate via the inline ref-callback below.
  const allCategoriesSelected = categories.size === ALL_CATEGORIES.length;
  const allSeveritiesSelected = severities.size === ALL_SEVERITIES.length;
  const noCategoriesSelected = categories.size === 0;
  const noSeveritiesSelected = severities.size === 0;
  const toggleAllCategories = (): void => {
    setCategories(allCategoriesSelected ? new Set() : new Set(ALL_CATEGORIES));
  };
  const toggleAllSeverities = (): void => {
    setSeverities(allSeveritiesSelected ? new Set() : new Set(ALL_SEVERITIES));
  };

  return (
    <section className="provider-section" id="audit-trail">
      <header style={{ marginBottom: "1rem" }}>
        <h3>Verlauf</h3>
        <p className="muted small" style={{ margin: 0 }}>
          Chronologische Aufzeichnung aller Vorgänge in AVA — Producer-Läufe,
          LinkedIn-Signale, Hintergrund-Heartbeat, Authentifizierungs-Events,
          CRM-Aktionen. Alles bleibt auf deinem Rechner; keine Daten gehen in
          die Cloud.
        </p>
      </header>

      <div className="audit-layout">
        {/* Filter-Sidebar */}
        <aside className="audit-filters">
          <div className="audit-filter-group">
            <label className="audit-filter-label">Zeitraum</label>
            <select
              value={timeRange}
              onChange={(e) => setTimeRange(e.target.value as TimeRangeId)}
            >
              {TIME_RANGES.map((r) => (
                <option key={r.id} value={r.id}>
                  {r.label}
                </option>
              ))}
            </select>
          </div>

          <div className="audit-filter-group">
            <label className="audit-filter-label">Suche</label>
            <input
              type="search"
              value={search}
              onChange={(e) => setSearch(e.target.value)}
              placeholder="Aktion oder Beschreibung …"
            />
          </div>

          <div className="audit-filter-group">
            <div className="audit-filter-label-row">
              <label className="audit-filter-label">Kategorie</label>
              <label
                className="audit-filter-check audit-filter-check--all"
                title={
                  allCategoriesSelected
                    ? "Alle abwählen"
                    : "Alle auswählen"
                }
              >
                <input
                  type="checkbox"
                  checked={allCategoriesSelected}
                  ref={(el) => {
                    if (el)
                      el.indeterminate =
                        !allCategoriesSelected && !noCategoriesSelected;
                  }}
                  onChange={toggleAllCategories}
                />
                Alle
              </label>
            </div>
            {ALL_CATEGORIES.map((cat) => (
              <label key={cat} className="audit-filter-check">
                <input
                  type="checkbox"
                  checked={categories.has(cat)}
                  onChange={() => toggleCategory(cat)}
                />
                <span className={`audit-cat-dot audit-cat-${cat}`} />
                {CATEGORY_LABEL[cat]}
              </label>
            ))}
          </div>

          <div className="audit-filter-group">
            <div className="audit-filter-label-row">
              <label className="audit-filter-label">Schwere</label>
              <label
                className="audit-filter-check audit-filter-check--all"
                title={
                  allSeveritiesSelected
                    ? "Alle abwählen"
                    : "Alle auswählen"
                }
              >
                <input
                  type="checkbox"
                  checked={allSeveritiesSelected}
                  ref={(el) => {
                    if (el)
                      el.indeterminate =
                        !allSeveritiesSelected && !noSeveritiesSelected;
                  }}
                  onChange={toggleAllSeverities}
                />
                Alle
              </label>
            </div>
            {ALL_SEVERITIES.map((sev) => (
              <label key={sev} className="audit-filter-check">
                <input
                  type="checkbox"
                  checked={severities.has(sev)}
                  onChange={() => toggleSeverity(sev)}
                />
                <span className={`audit-sev-dot audit-sev-${sev}`} />
                {SEVERITY_LABEL[sev]}
              </label>
            ))}
          </div>

          <div className="audit-filter-group">
            <label className="audit-filter-check">
              <input
                type="checkbox"
                checked={live}
                onChange={(e) => setLive(e.target.checked)}
              />
              Live-Updates
              {live && <span className="audit-live-dot" aria-hidden />}
            </label>
          </div>

          <div className="audit-filter-actions">
            <button
              type="button"
              className="link"
              onClick={exportJson}
              disabled={events.length === 0}
            >
              JSON exportieren
            </button>
            <button
              type="button"
              className="link bad"
              onClick={() => void purgeAll()}
            >
              Verlauf leeren
            </button>
          </div>
        </aside>

        {/* Event-Liste */}
        <div className="audit-list">
          {error && <p className="error small">{error}</p>}
          {!error && events.length === 0 && !loading && (
            <p className="muted">
              Noch keine Events im gewählten Zeitraum. Sobald AVA Producer
              startet, Heartbeats laufen oder du Aktionen ausführst, taucht
              hier ein chronologischer Eintrag auf.
            </p>
          )}
          {events.length > 0 && (
            <p className="muted small" style={{ marginBottom: "0.5rem" }}>
              {events.length} sichtbar
              {totalEstimate >= 0 ? ` · ${totalEstimate} gesamt im Filter` : ""}
            </p>
          )}
          <ul className="audit-events">
            {events.map((event) => (
              <AuditEventRow
                key={event.id}
                event={event}
                expanded={expandedId === event.id}
                onToggle={() =>
                  setExpandedId((cur) => (cur === event.id ? null : event.id))
                }
              />
            ))}
          </ul>
          {nextPageToken && (
            <button
              type="button"
              className="link"
              onClick={() => void loadMore()}
              disabled={loading}
              style={{ marginTop: "1rem" }}
            >
              {loading ? "Lädt …" : "Ältere laden"}
            </button>
          )}
        </div>
      </div>
    </section>
  );
}

function AuditEventRow({
  event,
  expanded,
  onToggle,
}: {
  event: AuditEvent;
  expanded: boolean;
  onToggle: () => void;
}): JSX.Element {
  const ts = new Date(event.timestamp);
  return (
    <li className="audit-event">
      <button
        type="button"
        className="audit-event-row"
        onClick={onToggle}
        aria-expanded={expanded}
      >
        <span className="audit-event-time">
          {ts.toLocaleString("de-DE", {
            month: "2-digit",
            day: "2-digit",
            hour: "2-digit",
            minute: "2-digit",
            second: "2-digit",
          })}
        </span>
        <span className={`audit-sev-dot audit-sev-${event.severity}`} />
        <span
          className={`audit-cat-badge audit-cat-${event.category}`}
          title={CATEGORY_LABEL[event.category]}
        >
          {CATEGORY_LABEL[event.category]}
        </span>
        <span className="audit-event-summary" title={event.summary}>
          {event.summary}
        </span>
      </button>
      {expanded && (
        <div className="audit-event-detail">
          <dl>
            <dt>Aktion</dt>
            <dd>
              <code>{event.action}</code>
            </dd>
            <dt>Akteur</dt>
            <dd>
              {event.actorType}
              {event.actorId ? ` · ${event.actorId}` : ""}
            </dd>
            {event.subjectType && (
              <>
                <dt>Subjekt</dt>
                <dd>
                  {event.subjectType}
                  {event.subjectId ? ` · ${event.subjectId}` : ""}
                </dd>
              </>
            )}
            {Object.keys(event.metadata).length > 0 && (
              <>
                <dt>Metadaten</dt>
                <dd>
                  <pre className="audit-event-metadata">
                    {JSON.stringify(event.metadata, null, 2)}
                  </pre>
                </dd>
              </>
            )}
          </dl>
        </div>
      )}
    </li>
  );
}


// v0.1.284 — Self-Corrections-Sektion.
//
// Listet AVAs gemeldete Workarounds nach Tool-Fehlern. Daten kommen aus
// dem lokalen self_corrections-Store. Auto-Hide wenn leer (kein Lärm
// für Nutzer ohne Vorkommen). Export-Button serialisiert die Liste
// als JSON ins Clipboard für Bug-Reports.
function SelfCorrectionsSection(): JSX.Element | null {
  const [items, setItems] = useState<SelfCorrectionEvent[]>([]);
  const [total, setTotal] = useState(0);
  const [expanded, setExpanded] = useState<Set<string>>(new Set());

  const refresh = useCallback(async () => {
    const res = await window.api.selfCorrections.list({ page: 1, pageSize: 50 });
    setItems(res.items);
    setTotal(res.total);
  }, []);

  useEffect(() => {
    void refresh();
    // Live-Refresh alle 30s — der Store hat keinen push-Channel, ist
    // aber selten genug betroffen dass Polling im Tab-Lifecycle OK ist.
    const t = setInterval(() => void refresh(), 30_000);
    return () => clearInterval(t);
  }, [refresh]);

  if (total === 0) return null;

  const onDelete = async (id: string): Promise<void> => {
    await window.api.selfCorrections.delete(id);
    await refresh();
  };
  const onDeleteAll = async (): Promise<void> => {
    if (
      !window.confirm(
        `Alle ${total} Selbstkorrektur-Meldungen löschen? Damit gehen die Hinweise auf Tool-Probleme verloren — sicher?`,
      )
    )
      return;
    await window.api.selfCorrections.deleteAll();
    await refresh();
  };
  const onExport = async (): Promise<void> => {
    const text = JSON.stringify(items, null, 2);
    try {
      await navigator.clipboard.writeText(text);
      window.alert("In die Zwischenablage kopiert.");
    } catch {
      window.alert("Konnte nicht kopieren — bitte Console-Log nutzen.");
      console.log(text);
    }
  };

  const toggle = (id: string): void => {
    setExpanded((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  };

  // Aggregat-Statistik pro Tool — was kommt am häufigsten vor.
  const byTool = new Map<string, number>();
  for (const e of items) {
    byTool.set(e.attemptedTool, (byTool.get(e.attemptedTool) ?? 0) + 1);
  }
  const topTools = Array.from(byTool.entries())
    .sort((a, b) => b[1] - a[1])
    .slice(0, 5);

  return (
    <section
      className="provider-section"
      id="self-corrections"
      style={{ marginBottom: "1.25rem" }}
    >
      <header style={{ marginBottom: "0.75rem" }}>
        <h3>Selbstkorrekturen (Tool-Workarounds)</h3>
        <p className="muted small" style={{ margin: 0 }}>
          AVA meldet hier, wenn sie nach einem Tool-Fehler einen Workaround
          gefunden hat. Pattern, die hier oft auftauchen, gehören als
          Code-Fix in den Tool/Skill — eine wiederkehrende Meldung ist
          ein Hinweis für mich als Entwickler. Alles bleibt lokal.
          Aktuell: <strong>{total}</strong> Meldung{total === 1 ? "" : "en"}.
        </p>
      </header>

      {topTools.length > 0 && (
        <div className="self-corrections__stats">
          <span className="muted small">Top-Tools mit Workaround:</span>
          {topTools.map(([tool, count]) => (
            <span key={tool} className="self-corrections__stat">
              <code>{tool}</code> · {count}
            </span>
          ))}
        </div>
      )}

      <div style={{ display: "flex", gap: 8, margin: "8px 0 12px" }}>
        <button type="button" onClick={onExport}>
          Als JSON kopieren
        </button>
        <button type="button" onClick={onDeleteAll} className="danger">
          Alle löschen
        </button>
      </div>

      <ul className="self-corrections__list">
        {items.map((e) => (
          <li key={e.id} className="self-corrections__row">
            <div
              className="self-corrections__head"
              onClick={() => toggle(e.id)}
              style={{ cursor: "pointer" }}
            >
              <code className="self-corrections__tool">{e.attemptedTool}</code>
              <span className="muted small">
                {new Date(e.timestamp).toLocaleString("de-DE")}
              </span>
              <span className="self-corrections__caret" aria-hidden>
                {expanded.has(e.id) ? "▾" : "▸"}
              </span>
            </div>
            <div className="self-corrections__short">{e.failedReason}</div>
            {expanded.has(e.id) && (
              <div className="self-corrections__detail">
                <div>
                  <strong>Workaround:</strong> {e.workaround}
                </div>
                {e.suggestedCodeFix && (
                  <div style={{ marginTop: 4 }}>
                    <strong>Fix-Vorschlag:</strong> {e.suggestedCodeFix}
                  </div>
                )}
                {e.rawErrorPreview && (
                  <details style={{ marginTop: 6 }}>
                    <summary>Original-Fehler</summary>
                    <pre className="self-corrections__raw">
                      {e.rawErrorPreview}
                    </pre>
                  </details>
                )}
                {e.conversationId && (
                  <div className="muted small" style={{ marginTop: 4 }}>
                    Conversation: <code>{e.conversationId}</code>
                  </div>
                )}
                <button
                  type="button"
                  onClick={() => void onDelete(e.id)}
                  style={{ marginTop: 8 }}
                >
                  Eintrag löschen
                </button>
              </div>
            )}
          </li>
        ))}
      </ul>
    </section>
  );
}

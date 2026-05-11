import { useEffect, useMemo, useRef, useState } from "react";
import type {
  ProducerLogEvent,
  ProducerLogLine,
  ProducerScreenshotEntry,
} from "../../../shared/types";

// v0.1.50 — per-company diagnostics: live producer logs + screenshots.
//
// Mounted inside the matrix drill-down panel. Caller passes:
//   - the company runId (`<txId>:<companyId>`) so we can grep/filter
//     logs and resolve the screenshot directory
//   - the list of producers known for this transaction so the user
//     can switch which one they're inspecting
//
// Logs: backfill with tail() on producer change, then live-tail via
// onLine. Filter input is pre-seeded with the runId so the first
// thing the user sees is "what did THIS producer do for THIS company"
// — a "show all" toggle widens the view if they want pre-runId
// context (e.g. AMQP connect logs).
//
// Screenshots: list() refreshes every 5s while in_progress, manual
// refresh button otherwise. PNGs render via the custom
// `ava-screenshot://` protocol — main-process serves bytes directly,
// no IPC round-trip per image.

type Tab = "logs" | "screenshots";

const PRODUCER_LABELS: Record<string, string> = {
  "structured-content": "Stamm-Daten",
  "company-publication": "Publikationen",
  "company-profile": "Firmenprofil",
  "company-evaluation": "Bewertung",
  "company-contact": "Kontaktdaten",
  website: "Website",
};

interface Props {
  /** `${transactionId}:${companyId}`. Pre-fills the log filter and
   *  scopes the screenshot directory listing. */
  runId: string;
  /** Producers to offer in the dropdown. Pass the full set of stages
   *  visible in the matrix so the user can switch quickly between
   *  them without closing the drill-down. */
  producers: string[];
  /** Producer to show first. Caller usually picks the failing /
   *  in-progress one; default is the first in the list. */
  initialProducer?: string;
}

export function DiagnosticsPanel({ runId, producers, initialProducer }: Props) {
  const [producer, setProducer] = useState<string>(
    initialProducer ?? producers[0] ?? "",
  );
  const [tab, setTab] = useState<Tab>("logs");

  if (!producer) {
    return null;
  }

  return (
    <div className="diagnostics">
      <div className="diagnostics__header">
        <select
          value={producer}
          onChange={(e) => setProducer(e.target.value)}
          aria-label="Producer auswählen"
        >
          {producers.map((p) => (
            <option key={p} value={p}>
              {PRODUCER_LABELS[p] ?? p}
            </option>
          ))}
        </select>
        <div className="diagnostics__tabs" role="tablist">
          <button
            type="button"
            role="tab"
            aria-selected={tab === "logs"}
            className={tab === "logs" ? "primary" : ""}
            onClick={() => setTab("logs")}
          >
            Logs
          </button>
          <button
            type="button"
            role="tab"
            aria-selected={tab === "screenshots"}
            className={tab === "screenshots" ? "primary" : ""}
            onClick={() => setTab("screenshots")}
          >
            Screenshots
          </button>
        </div>
      </div>

      {tab === "logs" ? (
        <LogsView producer={producer} runId={runId} />
      ) : (
        <ScreenshotsView producer={producer} runId={runId} />
      )}
    </div>
  );
}

// ---- Logs ------------------------------------------------------------------

const LOG_TAIL_LIMIT = 1000;

function LogsView({ producer, runId }: { producer: string; runId: string }) {
  const [lines, setLines] = useState<ProducerLogLine[]>([]);
  // Filter starts empty so the user sees the full producer stream by
  // default. The runId is offered as a placeholder hint — they can
  // type it (or paste it) when they want to narrow to this run.
  // Previously this defaulted to runId, which silently hid every line
  // that didn't carry the runId substring (Selenium / Chromium output,
  // most internal log lines) and made the panel look empty on remount.
  const [filter, setFilter] = useState<string>("");
  const [stderrOnly, setStderrOnly] = useState<boolean>(false);
  const [autoScroll, setAutoScroll] = useState<boolean>(true);
  // Copy-button state: "idle" → "copied" briefly after success →
  // back to "idle"; "error" if the clipboard write throws.
  const [copyState, setCopyState] = useState<"idle" | "copied" | "error">("idle");
  const scrollerRef = useRef<HTMLDivElement | null>(null);

  // Backfill on producer change, then subscribe to the live tail.
  // Subscribe is a single global handler; we filter by producer name
  // in the callback so we don't re-subscribe on every re-render.
  useEffect(() => {
    let cancelled = false;
    setLines([]);
    void window.api.producers.logs
      .tail(producer, LOG_TAIL_LIMIT)
      .then((tail) => {
        if (!cancelled) setLines(tail);
      });
    const off = window.api.producers.logs.onLine((event: ProducerLogEvent) => {
      if (event.producer !== producer) return;
      setLines((prev) => {
        // Cap renderer-side too — main caps at 5000, but a long
        // session would still grow the React state unboundedly.
        const next = prev.length >= LOG_TAIL_LIMIT * 2
          ? prev.slice(-LOG_TAIL_LIMIT).concat(event.line)
          : prev.concat(event.line);
        return next;
      });
    });
    return () => {
      cancelled = true;
      off();
    };
  }, [producer]);

  // Auto-scroll: only follow the bottom while the user hasn't scrolled
  // up. Track scroll position to flip autoScroll off when they read
  // backwards, on again when they hit the bottom.
  useEffect(() => {
    if (!autoScroll) return;
    const el = scrollerRef.current;
    if (!el) return;
    el.scrollTop = el.scrollHeight;
  }, [lines, autoScroll]);

  const filtered = useMemo(() => {
    const needle = filter.trim().toLowerCase();
    return lines.filter((l) => {
      if (stderrOnly && l.stream !== "stderr") return false;
      if (!needle) return true;
      return l.text.toLowerCase().includes(needle);
    });
  }, [lines, filter, stderrOnly]);

  // Copies the CURRENTLY VISIBLE lines (post filter / stderr-only) to
  // the clipboard. Falls back to the legacy execCommand path when the
  // async Clipboard API isn't available — Electron renderers can
  // refuse navigator.clipboard.writeText under some packaging configs
  // even though it works in dev. Resets the "copied" feedback after
  // 1.6 s.
  const onCopy = async (): Promise<void> => {
    if (filtered.length === 0) return;
    const payload = filtered
      .map((l) => {
        const ts = new Date(l.ts).toISOString();
        const stream = l.stream === "stderr" ? "ERR" : "OUT";
        return `${ts} [${stream}] ${l.text}`;
      })
      .join("\n");
    try {
      if (navigator.clipboard?.writeText) {
        await navigator.clipboard.writeText(payload);
      } else {
        const ta = document.createElement("textarea");
        ta.value = payload;
        ta.style.position = "fixed";
        ta.style.opacity = "0";
        document.body.appendChild(ta);
        ta.select();
        document.execCommand("copy");
        document.body.removeChild(ta);
      }
      setCopyState("copied");
      window.setTimeout(() => setCopyState("idle"), 1600);
    } catch {
      setCopyState("error");
      window.setTimeout(() => setCopyState("idle"), 2200);
    }
  };

  return (
    <div className="diagnostics__logs">
      <div className="diagnostics__controls">
        <input
          type="search"
          value={filter}
          onChange={(e) => setFilter(e.target.value)}
          placeholder={runId ? `Filter (z. B. „${runId.slice(0, 24)}…")` : "Filter (z. B. runId, Fehlertext)"}
          spellCheck={false}
        />
        <label className="muted">
          <input
            type="checkbox"
            checked={stderrOnly}
            onChange={(e) => setStderrOnly(e.target.checked)}
          />{" "}
          nur stderr
        </label>
        <label className="muted">
          <input
            type="checkbox"
            checked={autoScroll}
            onChange={(e) => setAutoScroll(e.target.checked)}
          />{" "}
          Auto-Scroll
        </label>
        <span className="muted">
          {filtered.length} / {lines.length}
        </span>
        <button
          type="button"
          className={`diagnostics__copy diagnostics__copy--${copyState}`}
          onClick={() => void onCopy()}
          disabled={filtered.length === 0 || copyState === "copied"}
          title={
            filtered.length === 0
              ? "Keine Zeilen zum Kopieren"
              : `${filtered.length} Zeile${filtered.length === 1 ? "" : "n"} kopieren`
          }
          aria-live="polite"
        >
          {copyState === "copied" ? (
            <>
              <CheckIcon /> Kopiert
            </>
          ) : copyState === "error" ? (
            <>
              <span aria-hidden="true">⚠</span> Fehlgeschlagen
            </>
          ) : (
            <>
              <CopyIcon /> Logs kopieren
            </>
          )}
        </button>
      </div>
      <div
        className="diagnostics__log-stream"
        ref={scrollerRef}
        onScroll={(e) => {
          const el = e.currentTarget;
          const atBottom =
            el.scrollHeight - el.scrollTop - el.clientHeight < 40;
          if (autoScroll !== atBottom) setAutoScroll(atBottom);
        }}
      >
        {filtered.length === 0 ? (
          <p className="muted">
            Keine Zeilen{filter || stderrOnly ? " (Filter aktiv)" : ""}.
          </p>
        ) : (
          filtered.map((l) => (
            <div
              key={l.id}
              className={`log-line log-line--${l.stream}`}
              title={new Date(l.ts).toLocaleString()}
            >
              <span className="log-line__time">{formatHHMMSS(l.ts)}</span>
              <span className="log-line__text">{l.text}</span>
            </div>
          ))
        )}
      </div>
    </div>
  );
}

// ---- Screenshots -----------------------------------------------------------

const SCREENSHOT_REFRESH_MS = 5000;

function ScreenshotsView({
  producer,
  runId,
}: {
  producer: string;
  runId: string;
}) {
  const [entries, setEntries] = useState<ProducerScreenshotEntry[]>([]);
  const [loading, setLoading] = useState<boolean>(true);
  const [lightboxIdx, setLightboxIdx] = useState<number | null>(null);

  useEffect(() => {
    let cancelled = false;
    let timer: NodeJS.Timeout | null = null;

    const refresh = async () => {
      try {
        const list = await window.api.producers.screenshots.list(
          producer,
          runId,
        );
        if (!cancelled) {
          setEntries(list);
          setLoading(false);
        }
      } catch {
        if (!cancelled) setLoading(false);
      }
    };

    void refresh();
    timer = setInterval(refresh, SCREENSHOT_REFRESH_MS);

    return () => {
      cancelled = true;
      if (timer) clearInterval(timer);
    };
  }, [producer, runId]);

  if (loading && entries.length === 0) {
    return <p className="muted">Lädt Screenshots…</p>;
  }
  if (entries.length === 0) {
    return (
      <p className="muted">
        Keine Screenshots für diesen Lauf. Selenium-Producer (Stamm-Daten,
        Publikationen) erzeugen automatisch Screenshots vor jedem wichtigen
        Klick und bei Fehlern.
      </p>
    );
  }

  return (
    <div className="diagnostics__screenshots">
      <div className="diagnostics__shot-grid">
        {entries.map((e, idx) => {
          const url = window.api.producers.screenshots.urlFor(
            producer,
            runId,
            e.filename,
          );
          return (
            <button
              type="button"
              key={e.filename}
              className="shot-thumb"
              onClick={() => setLightboxIdx(idx)}
              title={`${e.label} · ${formatHHMMSS(e.ts)} · ${formatBytes(e.size)}`}
            >
              <img src={url} alt={e.label} loading="lazy" />
              <span className="shot-thumb__label">{e.label}</span>
              <span className="shot-thumb__time muted">
                {formatHHMMSS(e.ts)}
              </span>
            </button>
          );
        })}
      </div>

      {lightboxIdx !== null && entries[lightboxIdx] && (
        <div
          className="shot-lightbox"
          onClick={() => setLightboxIdx(null)}
          role="dialog"
          aria-label="Screenshot-Vorschau"
        >
          <img
            src={window.api.producers.screenshots.urlFor(
              producer,
              runId,
              entries[lightboxIdx]!.filename,
            )}
            alt={entries[lightboxIdx]!.label}
          />
          <div className="shot-lightbox__caption muted">
            {entries[lightboxIdx]!.label} ·{" "}
            {formatHHMMSS(entries[lightboxIdx]!.ts)} ·{" "}
            {lightboxIdx + 1} / {entries.length}
          </div>
        </div>
      )}
    </div>
  );
}

// ---- helpers ---------------------------------------------------------------

function formatHHMMSS(ts: number): string {
  const d = new Date(ts);
  const pad = (n: number) => n.toString().padStart(2, "0");
  return `${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`;
}

function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(0)} KB`;
  return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
}

// ---- Inline SVG icons ------------------------------------------------------
//
// 14x14 viewBox, currentColor so the icons pick up the button's text colour
// in light/dark mode without theme coupling. Inline instead of pulling a new
// icon dep for two glyphs.

function CopyIcon() {
  return (
    <svg
      width="14"
      height="14"
      viewBox="0 0 14 14"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.4"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
    >
      <rect x="3.5" y="3.5" width="7" height="8.5" rx="1.2" />
      <path d="M5.5 3.5V2.5a1 1 0 0 1 1-1h5a1 1 0 0 1 1 1v7a1 1 0 0 1-1 1h-1" />
    </svg>
  );
}

function CheckIcon() {
  return (
    <svg
      width="14"
      height="14"
      viewBox="0 0 14 14"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.8"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
    >
      <path d="M2.5 7.5l3 3 6-7" />
    </svg>
  );
}

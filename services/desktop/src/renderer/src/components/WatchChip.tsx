import { useEffect, useRef, useState } from "react";
import { Link } from "react-router-dom";
import {
  activeWatches,
  capacityBucket,
  useWatchesStore,
} from "../store/watches";
import { WATCH_CAP_DEFAULT, type Watch } from "../../../shared/types";

// Topbar watcher-count chip (Phase 8.t2).
//
// Mirrors the AlertBell construction so the two chips read as a pair.
// Always visible when at least one watch is active. The colour dot
// communicates capacity utilization against the cap:
//   green:  ≤ 50 %
//   orange: 51–89 %
//   red:    ≥ 90 %  (warning BEFORE the next register hits the cap)
// Click → popover lists the most-recently-fired watches; footer link
// routes to Settings → Profil & Beobachtungen until a dedicated /watches
// route exists.

export function WatchChip() {
  const watches = useWatchesStore((s) => s.watches);
  const ready = useWatchesStore((s) => s.ready);

  const [open, setOpen] = useState(false);
  const wrapperRef = useRef<HTMLDivElement | null>(null);

  // Outside-click + Esc close. Capture-phase, same as AlertBell.
  useEffect(() => {
    if (!open) return;
    function onDocClick(ev: MouseEvent) {
      if (
        wrapperRef.current &&
        !wrapperRef.current.contains(ev.target as Node)
      ) {
        setOpen(false);
      }
    }
    function onKey(ev: KeyboardEvent) {
      if (ev.key === "Escape") setOpen(false);
    }
    document.addEventListener("mousedown", onDocClick, true);
    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("mousedown", onDocClick, true);
      document.removeEventListener("keydown", onKey);
    };
  }, [open]);

  if (!ready) return null;
  const active = activeWatches(watches);
  if (active.length === 0) return null; // chip only renders when there's content

  const cap = WATCH_CAP_DEFAULT;
  const bucket = capacityBucket(active.length, cap);

  // Sort by last-fire (or last-checked) for the popover; the user
  // cares about "what fired most recently" more than registration order.
  const recent = active
    .slice()
    .sort((a, b) => sortKey(b) - sortKey(a))
    .slice(0, 5);

  return (
    <div className="watch-chip" ref={wrapperRef}>
      <button
        type="button"
        className={`watch-chip__btn watch-chip__btn--${bucket}`}
        aria-label={`${active.length} von ${cap} aktiven Watches`}
        title={`${active.length} von ${cap} aktiven Watches`}
        onClick={() => setOpen((v) => !v)}
      >
        <EyeIcon />
        <span className="watch-chip__count">{active.length}</span>
        <span className={`watch-chip__dot watch-chip__dot--${bucket}`} aria-hidden />
      </button>

      {open && (
        <div className="watch-chip__popover" role="dialog" aria-label="Watches">
          <header className="watch-chip__popover-header">
            <strong>Aktive Watches</strong>
            <span className="muted">
              {active.length} / {cap}
            </span>
          </header>

          <ul className="watch-chip__list">
            {recent.map((w) => (
              <li key={w.id} className="watch-chip__row">
                <div className="watch-chip__row-main">
                  <div className="watch-chip__row-prompt">{w.prompt}</div>
                  <div className="watch-chip__row-meta muted">
                    <span>{cadenceLabel(w.cadence)}</span>
                    <span className="alert__sep">·</span>
                    <span>
                      {w.hits.length === 0
                        ? "noch kein Treffer"
                        : `${w.hits.length} Treffer`}
                    </span>
                    {w.lastCheckedAt && (
                      <>
                        <span className="alert__sep">·</span>
                        <span>{formatRelative(w.lastCheckedAt)}</span>
                      </>
                    )}
                  </div>
                </div>
              </li>
            ))}
          </ul>

          {bucket === "red" && (
            <div className="watch-chip__warn">
              Limit fast erreicht: entferne oder pausiere einen Watch,
              bevor du weitere registrierst.
            </div>
          )}

          <footer className="watch-chip__popover-footer">
            <Link to="/settings" onClick={() => setOpen(false)}>
              Verwalten in Einstellungen →
            </Link>
          </footer>
        </div>
      )}
    </div>
  );
}

function sortKey(w: Watch): number {
  const lastHit = w.hits[0]?.at;
  const last = lastHit ?? w.lastCheckedAt;
  if (!last) return 0;
  const t = new Date(last).getTime();
  return Number.isFinite(t) ? t : 0;
}

function cadenceLabel(c: Watch["cadence"]): string {
  switch (c) {
    case "daily":
      return "täglich";
    case "weekly":
      return "wöchentlich";
    case "monthly":
      return "monatlich";
  }
}

function formatRelative(iso: string): string {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return "";
  const diff = Date.now() - d.getTime();
  if (diff < 60_000) return "gerade eben";
  if (diff < 3_600_000) return `vor ${Math.round(diff / 60_000)} Min.`;
  if (diff < 86_400_000) return `vor ${Math.round(diff / 3_600_000)} Std.`;
  return d.toLocaleDateString("de-DE");
}

function EyeIcon() {
  return (
    <svg
      width="16"
      height="16"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.8"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
    >
      <path d="M2 12s3.5-7 10-7 10 7 10 7-3.5 7-10 7-10-7-10-7z" />
      <circle cx="12" cy="12" r="3" />
    </svg>
  );
}

import { useEffect, useRef, useState } from "react";
import { Link } from "react-router-dom";
import { useAlertsStore } from "../store/alerts";
import type { Alert, AlertSeverity } from "../../../shared/types";

// Topbar bell + popover (Phase 8.f2).
//
// Renders the bell icon between nav and user badge. Unread count badge
// (capped at 9+) sits top-right of the bell and is hidden when zero —
// the bell stays visible regardless so the user has a stable click
// target and a sense that the feature exists.
//
// Click → popover anchored under the bell, ~360 px wide, lists the 5
// most recent unread alerts. Footer link routes to `/alerts`.
//
// We deliberately do NOT auto-mark-as-read on open — the user might be
// peeking. Marking happens on row click (which routes to `/alerts`),
// or via the explicit per-row button in the route view itself.
//
// Outside-click and Esc dismiss; we install a capture-phase listener
// instead of a ref-comparison handler so a click anywhere outside the
// popover (including on toolbar buttons) closes it. Same pattern other
// popovers in this app use.

const SEVERITY_LABEL: Record<AlertSeverity, string> = {
  info: "Info",
  warn: "Achtung",
  urgent: "Dringend",
};

export function AlertBell() {
  const unreadCount = useAlertsStore((s) => s.unreadCount);
  const alerts = useAlertsStore((s) => s.alerts);
  const markSeen = useAlertsStore((s) => s.markSeen);

  const [open, setOpen] = useState(false);
  const wrapperRef = useRef<HTMLDivElement | null>(null);

  // Outside-click + Esc to close. Capture-phase so toolbar clicks don't
  // toggle their own UI before we get a chance to dismiss.
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

  const recentUnread: Alert[] = alerts
    .filter((a) => a.seenAt === null)
    .slice(0, 5);

  const badgeText = unreadCount > 9 ? "9+" : String(unreadCount);

  return (
    <div className="alert-bell" ref={wrapperRef}>
      <button
        type="button"
        className="alert-bell__btn"
        aria-label={
          unreadCount > 0
            ? `${unreadCount} ungelesene Meldungen`
            : "Meldungen"
        }
        onClick={() => setOpen((v) => !v)}
      >
        <BellIcon />
        {unreadCount > 0 && (
          <span className="alert-bell__badge" aria-hidden>
            {badgeText}
          </span>
        )}
      </button>

      {open && (
        <div className="alert-bell__popover" role="dialog" aria-label="Meldungen">
          <header className="alert-bell__popover-header">
            <strong>Meldungen</strong>
            <span className="muted">
              {unreadCount === 0
                ? "Keine ungelesenen"
                : `${unreadCount} ungelesen`}
            </span>
          </header>

          {recentUnread.length === 0 && (
            <div className="alert-bell__empty">
              <p>Nichts Neues. ✓</p>
              <p className="muted">
                AVA meldet sich, sobald sich etwas tut.
              </p>
            </div>
          )}

          {recentUnread.length > 0 && (
            <ul className="alert-bell__list">
              {recentUnread.map((a) => (
                <li key={a.id} className="alert-bell__row">
                  <Link
                    to="/alerts"
                    className="alert-bell__row-link"
                    onClick={() => {
                      void markSeen(a.id);
                      setOpen(false);
                    }}
                  >
                    <span
                      className={`alert__dot alert__dot--${a.severity}`}
                      aria-label={SEVERITY_LABEL[a.severity]}
                      title={SEVERITY_LABEL[a.severity]}
                    />
                    <div className="alert-bell__row-main">
                      <div className="alert-bell__row-headline">
                        {a.headline}
                      </div>
                      <div className="alert-bell__row-meta muted">
                        <span>{a.companyName}</span>
                        <span className="alert__sep">·</span>
                        <span>{formatRelative(a.createdAt)}</span>
                      </div>
                    </div>
                  </Link>
                </li>
              ))}
            </ul>
          )}

          <footer className="alert-bell__popover-footer">
            <Link to="/alerts" onClick={() => setOpen(false)}>
              Alle ansehen →
            </Link>
          </footer>
        </div>
      )}
    </div>
  );
}

function BellIcon() {
  return (
    <svg
      width="18"
      height="18"
      viewBox="0 0 20 20"
      fill="none"
      aria-hidden="true"
    >
      <path
        d="M10 2.5a4.5 4.5 0 0 0-4.5 4.5v2.4c0 .58-.21 1.14-.59 1.58L3.5 12.5h13l-1.41-1.52A2.4 2.4 0 0 1 14.5 9.4V7A4.5 4.5 0 0 0 10 2.5Z"
        stroke="currentColor"
        strokeWidth="1.4"
        strokeLinejoin="round"
      />
      <path
        d="M8.5 15.5a1.5 1.5 0 0 0 3 0"
        stroke="currentColor"
        strokeWidth="1.4"
        strokeLinecap="round"
      />
    </svg>
  );
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

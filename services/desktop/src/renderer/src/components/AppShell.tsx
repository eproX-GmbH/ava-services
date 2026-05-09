import type { PropsWithChildren } from "react";
import { NavLink } from "react-router-dom";
import { useEffect, useState } from "react";
import { AlertCircle, Loader2, RefreshCw } from "lucide-react";
import { AlertBell } from "./AlertBell";
import { WatchChip } from "./WatchChip";
import type { ExternalServiceStatus } from "../../../shared/types";

// Top-level chrome for the routed app (Phase 8.l2).
//
// Layout:
//   ┌──────────────────────────────────────────────────────────────┐
//   │ [logo]   Chat  Ingest  Transactions  …    user / sign out    │  ← 52px
//   ├──────────────────────────────────────────────────────────────┤
//   │ <route content>                                              │
//   └──────────────────────────────────────────────────────────────┘
//
// Why explicit CSS classes (not Tailwind utilities) for the chrome:
//   - The brand SVG ships without `width`/`height` attributes — only
//     a viewBox. `<img>` + `width: auto` is interpreted differently
//     across browsers when the height alone is constrained, so we
//     pin the height in CSS and let the viewBox set the aspect ratio.
//   - The shell is layout-critical and must work even if a Tailwind
//     class generation hiccup lands. The 8.l4 primitives pass will
//     port the *contents* of the bar to utility classes; the bar
//     skeleton stays in CSS.
export function AppShell({ children }: PropsWithChildren) {
  return (
    <div className="app-shell">
      <TopBar />
      <ExternalServiceBanner />
      <main className="app-shell__main">{children}</main>
    </div>
  );
}

// v0.1.52 — slim banner under the topbar that surfaces upstream
// reachability problems. Shows ONLY when state="unreachable" — when
// reachable we render nothing so the chrome doesn't shift on every
// boot. Driven by the main-process external-service-monitor (60s
// probe of unternehmensregister.de). The Stamm + Publikation
// producers auto-pause while this banner is up, so the matrix won't
// accumulate red cells from work the scraper can't possibly do.
function ExternalServiceBanner() {
  const [status, setStatus] = useState<ExternalServiceStatus | null>(null);
  const [probing, setProbing] = useState(false);
  /** Tracks "we just probed but the upstream is still unreachable" so
   *  the user sees a "noch nicht erreichbar" toast instead of a silent
   *  click. Cleared after a few seconds or on next status change. */
  const [stillDownAt, setStillDownAt] = useState<number | null>(null);

  useEffect(() => {
    let cancelled = false;
    void window.api.externalService.getStatus().then((s) => {
      if (!cancelled) setStatus(s);
    });
    const off = window.api.externalService.onStatusChanged((s) => {
      if (!cancelled) {
        setStatus(s);
        // Clear the toast on any external-driven status update.
        setStillDownAt(null);
      }
    });
    return () => {
      cancelled = true;
      off();
    };
  }, []);

  // Auto-dismiss the "still down" toast after 4s so it doesn't stick.
  useEffect(() => {
    if (stillDownAt === null) return;
    const id = setTimeout(() => setStillDownAt(null), 4000);
    return () => clearTimeout(id);
  }, [stillDownAt]);

  if (!status || status.state !== "unreachable") return null;

  const since = status.lastReachableAt
    ? formatRelativeMinutes(status.lastReachableAt)
    : null;

  const onRetry = async () => {
    if (probing) return;
    setProbing(true);
    try {
      const next = await window.api.externalService.probeNow();
      // probeNow returns the latest status synchronously. If it's
      // still unreachable, surface a brief "noch nicht erreichbar"
      // toast next to the button so the click feels responsive.
      if (next.state === "unreachable") {
        setStillDownAt(Date.now());
      }
      // If it flipped to reachable the banner self-unmounts via
      // onStatusChanged, no extra UI here.
    } finally {
      setProbing(false);
    }
  };

  return (
    <div className="upstream-banner" role="status" aria-live="polite">
      <AlertCircle className="ct-icon-sm" aria-hidden="true" />
      <strong>Unternehmensregister.de nicht erreichbar.</strong>{" "}
      <span>
        Stamm-Daten und Publikationen sind pausiert, bis der Dienst wieder
        antwortet. Andere Stages laufen weiter normal.
      </span>
      {since && <span className="upstream-banner__since">· {since}</span>}
      <button
        type="button"
        className="link upstream-banner__retry"
        onClick={() => void onRetry()}
        disabled={probing}
        title="Sofort erneut prüfen"
        aria-busy={probing}
      >
        {probing
          ? <><Loader2 className="ct-icon-sm" style={{ animation: "ava-spin 1s linear infinite" }} aria-hidden="true" /> Prüfe…</>
          : <><RefreshCw className="ct-icon-sm" aria-hidden="true" /> Erneut prüfen</>}
      </button>
      {stillDownAt !== null && !probing && (
        <span className="upstream-banner__toast" role="status">
          noch nicht erreichbar
        </span>
      )}
    </div>
  );
}

function formatRelativeMinutes(ts: number): string {
  const ms = Date.now() - ts;
  const min = Math.max(1, Math.round(ms / 60_000));
  if (min < 60) return `letzter Erfolg vor ${min} Min.`;
  const hours = Math.round(min / 60);
  return `letzter Erfolg vor ${hours} Std.`;
}

function TopBar() {
  return (
    <header className="topbar">
      {/* Gradient text wordmark — replaces the legacy <img> SVG so the
       * brand mark inherits the design system's primary gradient and
       * scales perfectly with the surrounding text. */}
      <div className="topbar__brand" aria-label="AVA">
        <span className="topbar__brand-mark ct-gradient-text">AVA</span>
      </div>
      <nav className="topbar__nav" aria-label="Hauptnavigation">
        <NavItem to="/chat" label="Chat" />
        <NavItem to="/ingest" label="Import" />
        <NavItem to="/transactions" label="Vorgänge" />
        <NavItem to="/alle-firmen" label="Meine Firmen" />
        <NavItem to="/companies" label="Firmensuche" />
        <NavItem to="/alerts" label="Meldungen" />
        <NavItem to="/settings" label="Einstellungen" />
        <NavItem to="/whoami" label="Status" />
      </nav>
      <div className="topbar__spacer" />
      <WatchChip />
      <AlertBell />
      <UserBadge />
    </header>
  );
}

function NavItem({ to, label }: { to: string; label: string }) {
  return (
    <NavLink
      to={to}
      className={({ isActive }) =>
        "topbar__link" + (isActive ? " topbar__link--active" : "")
      }
    >
      {label}
    </NavLink>
  );
}

function UserBadge() {
  // Identity (tenant + actor sub IDs) is intentionally NOT shown here —
  // the IDs are opaque uuids that don't tell the user anything useful.
  // The /whoami route still surfaces them for the rare case someone
  // needs the values for support / debugging.
  return (
    <div className="topbar__user">
      <button
        type="button"
        onClick={() => void window.api.auth.signOut()}
        className="topbar__signout"
        title="Abmelden"
      >
        abmelden
      </button>
    </div>
  );
}

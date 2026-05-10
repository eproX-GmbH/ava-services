import type { PropsWithChildren } from "react";
import { NavLink, useNavigate, useLocation } from "react-router-dom";
import { useEffect, useState } from "react";
import { AlertCircle, Loader2, RefreshCw, Lightbulb, X } from "lucide-react";
import { AlertBell } from "./AlertBell";
import { WatchChip } from "./WatchChip";
import { UsageChip } from "./UsageChip";
import {
  ChatSearchModal,
  useChatSearchHotkey,
  type ChatSearchPickPayload,
} from "./ChatSearchModal";
import logoUrl from "../assets/logo-aqua.svg";
import type { ExternalServiceStatus } from "../../../shared/types";
import {
  applyTheme,
  getStoredMode,
  resolveTheme,
  setStoredMode,
  watchSystemPreference,
  type ThemeMode,
} from "../lib/theme";

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
/** v0.1.85 — global event the sidebar search-icon dispatches to open
 *  the chat-search modal without prop-drilling. The AppShell hosts the
 *  modal state and listens for this event. */
export const OPEN_CHAT_SEARCH_EVENT = "ava:open-chat-search";

export function openChatSearch(): void {
  window.dispatchEvent(new CustomEvent(OPEN_CHAT_SEARCH_EVENT));
}

export function AppShell({ children }: PropsWithChildren) {
  const [searchOpen, setSearchOpen] = useState(false);
  const navigate = useNavigate();
  const location = useLocation();

  useChatSearchHotkey(setSearchOpen);

  // Sidebar's search-icon button fires a bus event so it doesn't have
  // to know about the modal directly.
  useEffect(() => {
    const onOpen = () => setSearchOpen(true);
    window.addEventListener(OPEN_CHAT_SEARCH_EVENT, onOpen);
    return () => window.removeEventListener(OPEN_CHAT_SEARCH_EVENT, onOpen);
  }, []);

  // Before-pick hook: if we're not on /chat, route there so the chat
  // route gets a chance to mount + listen for the pick event.
  const onBeforePick = (_hit: { conversationId: string }): void => {
    if (location.pathname !== "/chat") {
      navigate("/chat");
    }
  };

  return (
    <div className="app-shell">
      <TopBar />
      <ExternalServiceBanner />
      <main className="app-shell__main">{children}</main>
      <ChatSearchModal
        open={searchOpen}
        onClose={() => setSearchOpen(false)}
        onBeforePick={onBeforePick as (h: ChatSearchPickPayload & { conversationId: string }) => void}
      />
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
/** localStorage keys for dismissable upstream banner state. */
const BANNER_SUPPRESS_KEY = "ava.upstreamBanner.suppressed";
const BANNER_DISMISSED_AT_KEY = "ava.upstreamBanner.dismissedAtCheckedAt";

function ExternalServiceBanner() {
  const [status, setStatus] = useState<ExternalServiceStatus | null>(null);
  const [probing, setProbing] = useState(false);
  /** Tracks "we just probed but the upstream is still unreachable" so
   *  the user sees a "noch nicht erreichbar" toast instead of a silent
   *  click. Cleared after a few seconds or on next status change. */
  const [stillDownAt, setStillDownAt] = useState<number | null>(null);
  /** Permanent suppression — user clicked "nie wieder anzeigen". */
  const [suppressed, setSuppressed] = useState<boolean>(() => {
    try {
      return localStorage.getItem(BANNER_SUPPRESS_KEY) === "true";
    } catch {
      return false;
    }
  });
  /** Temporary dismissal — store the lastCheckedAt at time of dismiss.
   *  Banner re-surfaces when the next probe completes (status carries
   *  a newer lastCheckedAt). */
  const [dismissedAt, setDismissedAt] = useState<number | null>(() => {
    try {
      const v = localStorage.getItem(BANNER_DISMISSED_AT_KEY);
      return v ? Number(v) : null;
    } catch {
      return null;
    }
  });
  /** Confirmation popover open. */
  const [confirmOpen, setConfirmOpen] = useState(false);

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

  // Clear temporary dismissal as soon as the upstream flips back to
  // reachable — if it goes down again later, the banner should fire
  // fresh, not stay hidden by stale dismissal state.
  useEffect(() => {
    if (status?.state === "reachable" && dismissedAt !== null) {
      setDismissedAt(null);
      try {
        localStorage.removeItem(BANNER_DISMISSED_AT_KEY);
      } catch {
        /* ignore */
      }
    }
  }, [status?.state, dismissedAt]);

  if (!status || status.state !== "unreachable") return null;
  if (suppressed) return null;
  // Temporary dismissal: banner stays hidden until a fresh probe
  // produces a newer lastCheckedAt (the monitor emits status on every
  // probe, not only on state transitions, so this fires reliably).
  if (
    dismissedAt !== null &&
    status.lastCheckedAt !== null &&
    status.lastCheckedAt <= dismissedAt
  ) {
    return null;
  }

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
      <button
        type="button"
        className="upstream-banner__close"
        onClick={() => setConfirmOpen((v) => !v)}
        aria-label="Hinweis ausblenden"
        title="Hinweis ausblenden"
      >
        <X className="ct-icon-sm" aria-hidden="true" />
      </button>
      {confirmOpen && (
        <div className="upstream-banner__confirm" role="dialog">
          <p className="upstream-banner__confirm-title">
            Hinweis ausblenden?
          </p>
          <p className="upstream-banner__confirm-body">
            Soll der Hinweis bei der nächsten Hintergrund-Prüfung erneut
            erscheinen können, oder dauerhaft ausgeblendet bleiben?
          </p>
          <div className="upstream-banner__confirm-actions">
            <button
              type="button"
              className="primary"
              onClick={() => {
                setDismissedAt(status.lastCheckedAt ?? Date.now());
                try {
                  localStorage.setItem(
                    BANNER_DISMISSED_AT_KEY,
                    String(status.lastCheckedAt ?? Date.now()),
                  );
                } catch {
                  /* ignore */
                }
                setConfirmOpen(false);
              }}
            >
              Bis zur nächsten Prüfung ausblenden
            </button>
            <button
              type="button"
              className="link bad"
              onClick={() => {
                setSuppressed(true);
                try {
                  localStorage.setItem(BANNER_SUPPRESS_KEY, "true");
                } catch {
                  /* ignore */
                }
                setConfirmOpen(false);
              }}
            >
              Nie wieder anzeigen
            </button>
            <button
              type="button"
              className="link"
              onClick={() => setConfirmOpen(false)}
            >
              Abbrechen
            </button>
          </div>
        </div>
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
      {/* v0.1.69 — restored the brand SVG. The gradient text wordmark
       * dropped during the Corporate Trust refresh hid the actual logo.
       * Height is pinned in CSS; the viewBox sets the aspect ratio. */}
      <div className="topbar__brand" aria-label="AVA">
        <img src={logoUrl} alt="" draggable={false} />
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
      <ThemeToggle />
      <UsageChip />
      <WatchChip />
      <AlertBell />
      <UserBadge />
    </header>
  );
}

/**
 * Tri-state lightbulb toggle. Click cycles through
 * `light` -> `dark` -> `system`. The icon is the same lucide
 * `Lightbulb` in both modes; its `fill` changes so the active state
 * is obvious. The `title` always names the next state so the user
 * knows what one click will do.
 */
function ThemeToggle() {
  const [mode, setMode] = useState<ThemeMode>(getStoredMode);
  const [resolved, setResolved] = useState<"light" | "dark">(() =>
    resolveTheme(getStoredMode()),
  );

  // Re-resolve on OS preference change while in `system` mode so the
  // app follows along without a manual click.
  useEffect(() => {
    return watchSystemPreference(() => {
      const next = resolveTheme("system");
      setResolved(next);
      applyTheme(next);
    });
  }, []);

  const cycle = (): void => {
    const next: ThemeMode =
      mode === "light" ? "dark" : mode === "dark" ? "system" : "light";
    setMode(next);
    setStoredMode(next);
    const r = resolveTheme(next);
    setResolved(r);
    applyTheme(r);
  };

  const label =
    mode === "system"
      ? `System (gerade ${resolved === "dark" ? "dunkel" : "hell"})`
      : mode === "dark"
        ? "Dunkel"
        : "Hell";
  const next =
    mode === "light" ? "Dunkel" : mode === "dark" ? "System-Vorgabe" : "Hell";

  return (
    <button
      type="button"
      onClick={cycle}
      className={`topbar__theme-toggle topbar__theme-toggle--${resolved}`}
      title={`Modus: ${label}. Klicken für „${next}“.`}
      aria-label={`Farbmodus umschalten: ${label}`}
    >
      <Lightbulb
        className="ct-icon-sm"
        aria-hidden="true"
        fill={resolved === "dark" ? "currentColor" : "none"}
        strokeWidth={resolved === "dark" ? 1.5 : 2}
      />
    </button>
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

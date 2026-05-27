import type { PropsWithChildren } from "react";
import { NavLink, useNavigate, useLocation } from "react-router-dom";
import { useEffect, useRef, useState } from "react";
import { AlertCircle, Loader2, RefreshCw, Lightbulb, X } from "lucide-react";
import { AlertBell } from "./AlertBell";
import { WatchChip } from "./WatchChip";
import { UsageChip } from "./UsageChip";
import { QuotaExhaustedBanner } from "./QuotaExhaustedBanner";
import { LinkedInActiveBanner } from "./LinkedInActiveBanner";
import {
  ChatSearchModal,
  useChatSearchHotkey,
  type ChatSearchPickPayload,
} from "./ChatSearchModal";
import logoUrl from "../assets/logo-aqua.svg";
import type {
  ExternalServiceId,
  ExternalServiceStatus,
  ExternalServicesStatus,
} from "../../../shared/types";
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

  // v0.1.327 — Wake-Recovery. Real-Run-Reports: nach macOS-Sleep+Wake
  // bleibt die UI manchmal frozen ("AVA reagiert nicht"). Strategie:
  // wenn der Main-Process uns das `power:resumed`-Frame schickt,
  // probieren wir 3s spaeter einen IPC-Heartbeat-Roundtrip. Wenn
  // innerhalb von 5s keine pong kommt, ist die Renderer-Pipeline
  // wahrscheinlich wedged → hard reload via window.location.reload().
  //
  // Trade-off: ein laufender Chat-Stream geht verloren. In der Praxis
  // ist das im Schlaf-Wake-Fall fast nie relevant — der Stream ist
  // beim Sleep ohnehin abgebrochen.
  useEffect(() => {
    if (!window.api?.onPowerResumed) return;
    const unsubscribe = window.api.onPowerResumed(() => {
      console.log("[wake-recovery] power:resumed received — probing main process");
      setTimeout(() => {
        const start = Date.now();
        const timeout = new Promise<"timeout">((resolve) =>
          setTimeout(() => resolve("timeout"), 5_000),
        );
        const ping = window.api.ping().then(() => "ok" as const);
        void Promise.race([ping, timeout]).then((result) => {
          if (result === "timeout") {
            console.warn(
              "[wake-recovery] no pong after 5s — main wedged, hard-reloading renderer",
            );
            window.location.reload();
          } else {
            console.log(
              `[wake-recovery] pong received in ${Date.now() - start}ms — UI healthy`,
            );
          }
        });
      }, 3_000);
    });
    return unsubscribe;
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
      <QuotaExhaustedBanner />
      <ExternalServiceBanner />
      <LinkedInActiveBanner />
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
// reachability problems. v0.1.105 — multi-source. The renderer used to
// see a single ExternalServiceStatus; it now sees an aggregate keyed
// by service id (unternehmensregister, handelsregister). The banner
// shows ONLY when at least one service is unreachable — so on a
// healthy boot it stays hidden and the chrome doesn't shift.
//
// Copy:
//   - Some down: list each unreachable service by friendly name and
//     note that strukturierte Inhalte können langsamer sein (we can
//     fall back to the still-up source).
//   - All down: structured-content producer is paused.
//
// Suppression (BANNER_SUPPRESS_KEY): keyed by the SET of unreachable
// services so dismissing "unternehmensregister" doesn't silence a
// future combined or different outage. The legacy single-bool key is
// migrated on first render so existing users keep their preference.
const BANNER_SUPPRESS_KEY = "ava.upstreamBanner.suppressedSignatures";
const BANNER_SUPPRESS_LEGACY_KEY = "ava.upstreamBanner.suppressed";
const BANNER_DISMISSED_AT_KEY = "ava.upstreamBanner.dismissedAtCheckedAt";

const SERVICE_LABELS: Record<ExternalServiceId, string> = {
  unternehmensregister: "Unternehmensregister.de",
  handelsregister: "Handelsregister.de",
};

/** Stable id for "this exact set of services is currently down".
 *  Used as the suppression key so dismissing one combo doesn't
 *  silence a different future combo. */
function unreachableSignature(s: ExternalServicesStatus): string {
  return Object.values(s.services)
    .filter((svc) => svc.state === "unreachable")
    .map((svc) => svc.service)
    .sort()
    .join(",");
}

function readSuppressedSignatures(): Set<string> {
  try {
    const raw = localStorage.getItem(BANNER_SUPPRESS_KEY);
    if (raw) {
      const parsed = JSON.parse(raw) as unknown;
      if (Array.isArray(parsed)) {
        return new Set(parsed.filter((v): v is string => typeof v === "string"));
      }
    }
    // Legacy key migration: a "true" there meant "suppress everything
    // unternehmensregister-related". Migrate as best-effort to the
    // single-service signature so existing users don't regress.
    if (localStorage.getItem(BANNER_SUPPRESS_LEGACY_KEY) === "true") {
      return new Set(["unternehmensregister"]);
    }
  } catch {
    /* ignore */
  }
  return new Set();
}

function writeSuppressedSignatures(set: Set<string>): void {
  try {
    localStorage.setItem(BANNER_SUPPRESS_KEY, JSON.stringify([...set]));
  } catch {
    /* ignore */
  }
}

function ExternalServiceBanner() {
  const [status, setStatus] = useState<ExternalServicesStatus | null>(null);
  const [probing, setProbing] = useState(false);
  /** "we just probed but it's still unreachable" toast. */
  const [stillDownAt, setStillDownAt] = useState<number | null>(null);
  /** Permanently-suppressed signatures (set of comma-joined service ids). */
  const [suppressedSigs, setSuppressedSigs] = useState<Set<string>>(() =>
    readSuppressedSignatures(),
  );
  /** Temporary dismissal — store the max lastCheckedAt across services
   *  at time of dismiss. Banner re-surfaces when ANY service has a
   *  newer lastCheckedAt (a probe ran since dismissal). */
  const [dismissedAt, setDismissedAt] = useState<number | null>(() => {
    try {
      const v = localStorage.getItem(BANNER_DISMISSED_AT_KEY);
      return v ? Number(v) : null;
    } catch {
      return null;
    }
  });
  const [confirmOpen, setConfirmOpen] = useState(false);

  useEffect(() => {
    let cancelled = false;
    void window.api.externalService.getStatus().then((s) => {
      if (!cancelled) setStatus(s);
    });
    const off = window.api.externalService.onStatusChanged((s) => {
      if (!cancelled) {
        setStatus(s);
        setStillDownAt(null);
      }
    });
    return () => {
      cancelled = true;
      off();
    };
  }, []);

  useEffect(() => {
    if (stillDownAt === null) return;
    const id = setTimeout(() => setStillDownAt(null), 4000);
    return () => clearTimeout(id);
  }, [stillDownAt]);

  // Clear temporary dismissal as soon as everything is reachable
  // again — a future outage should re-fire the banner fresh.
  useEffect(() => {
    if (status?.allReachable && dismissedAt !== null) {
      setDismissedAt(null);
      try {
        localStorage.removeItem(BANNER_DISMISSED_AT_KEY);
      } catch {
        /* ignore */
      }
    }
  }, [status?.allReachable, dismissedAt]);

  if (!status) return null;

  const unreachable: ExternalServiceStatus[] = Object.values(
    status.services,
  ).filter((s) => s.state === "unreachable");
  if (unreachable.length === 0) return null;

  const signature = unreachableSignature(status);
  if (suppressedSigs.has(signature)) return null;

  const maxLastCheckedAt = unreachable.reduce<number | null>(
    (acc, svc) =>
      svc.lastCheckedAt && (acc === null || svc.lastCheckedAt > acc)
        ? svc.lastCheckedAt
        : acc,
    null,
  );
  // Temporary dismissal: hide until a fresh probe produces a newer
  // lastCheckedAt across the unreachable set.
  if (
    dismissedAt !== null &&
    maxLastCheckedAt !== null &&
    maxLastCheckedAt <= dismissedAt
  ) {
    return null;
  }

  const allDown = !status.anyReachable;
  const headline = allDown
    ? "Alle Quellen für strukturierte Inhalte nicht erreichbar."
    : `${unreachable.map((s) => SERVICE_LABELS[s.service]).join(" und ")} nicht erreichbar.`;
  const detail = allDown
    ? "Der Producer für strukturierte Inhalte ist pausiert, bis mindestens eine Quelle wieder antwortet. Andere Stages laufen weiter normal."
    : "Strukturierte Inhalte können langsamer sein, da auf die verbleibende Quelle ausgewichen wird. Andere Stages laufen weiter normal.";

  // "letzter Erfolg vor X" — pick the freshest lastReachableAt across
  // the unreachable services so the user gets the most useful hint.
  const freshestLastReachable = unreachable.reduce<number | null>(
    (acc, svc) =>
      svc.lastReachableAt && (acc === null || svc.lastReachableAt > acc)
        ? svc.lastReachableAt
        : acc,
    null,
  );
  const since = freshestLastReachable
    ? formatRelativeMinutes(freshestLastReachable)
    : null;

  const onRetry = async () => {
    if (probing) return;
    setProbing(true);
    try {
      const next = await window.api.externalService.probeNow();
      if (!next.allReachable) {
        setStillDownAt(Date.now());
      }
    } finally {
      setProbing(false);
    }
  };

  return (
    <div className="upstream-banner" role="status" aria-live="polite">
      <AlertCircle className="ct-icon-sm" aria-hidden="true" />
      <strong>{headline}</strong>{" "}
      <span>{detail}</span>
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
            erscheinen können, oder dauerhaft für genau diese Kombination
            ausgeblendet bleiben?
          </p>
          <div className="upstream-banner__confirm-actions">
            <button
              type="button"
              className="primary"
              onClick={() => {
                const at = maxLastCheckedAt ?? Date.now();
                setDismissedAt(at);
                try {
                  localStorage.setItem(
                    BANNER_DISMISSED_AT_KEY,
                    String(at),
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
              className="link bad is-inline"
              onClick={() => {
                const next = new Set(suppressedSigs);
                next.add(signature);
                setSuppressedSigs(next);
                writeSuppressedSignatures(next);
                setConfirmOpen(false);
              }}
            >
              Nie wieder für diese Kombination
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
  // L6 — show the LinkedIn-Beobachter nav entry only when the master
  // switch is on. We re-fetch on focus so a Settings flip is reflected
  // without a full page reload.
  const [linkedinEnabled, setLinkedinEnabled] = useState<boolean>(false);
  useEffect(() => {
    let cancelled = false;
    const refresh = (): void => {
      void window.api.linkedin.getSettings().then((s) => {
        if (!cancelled) setLinkedinEnabled(s.enabled === true);
      });
    };
    refresh();
    const onFocus = () => refresh();
    window.addEventListener("focus", onFocus);
    return () => {
      cancelled = true;
      window.removeEventListener("focus", onFocus);
    };
  }, []);
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
        <NavItem
          to="/transactions"
          label="Vorgänge"
          subItems={[
            { to: "/transactions", label: "Alle Vorgänge" },
            { to: "/ingest", label: "Importieren" },
          ]}
        />
        <NavItem
          to="/alle-firmen"
          label="Firmen"
          subItems={[
            { to: "/alle-firmen", label: "Meine Firmen" },
            { to: "/companies", label: "Firmensuche" },
          ]}
        />
        <NavItem
          to="/alerts"
          label="Meldungen"
          subItems={[
            { to: "/alerts", label: "Aktive Meldungen" },
            { to: "/inbox", label: "Mail-Triage" },
          ]}
        />
        {linkedinEnabled && <NavItem to="/linkedin" label="Signale" />}
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

interface NavSubItem {
  to: string;
  label: string;
}

function NavItem({
  to,
  label,
  subItems,
}: {
  to: string;
  label: string;
  subItems?: NavSubItem[];
}) {
  // Top-Item ohne Sub-Menü: einfacher Link.
  if (!subItems || subItems.length === 0) {
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
  return <NavItemWithSubMenu to={to} label={label} subItems={subItems} />;
}

/**
 * v0.1.276 — Top-Nav-Item mit Hover-Dropdown.
 *
 * Verhalten:
 *   - Hover öffnet das Sub-Menü mit kurzer Verzögerung (verhindert
 *     Flicker beim schnellen Vorbeiziehen).
 *   - Klick aufs Top-Item navigiert zur Default-Route (`to`).
 *   - Sub-Items sind eigene Links, schließen das Menü beim Klick.
 *   - Esc schließt. Click-Outside schließt.
 *   - Keyboard: Tab fokussiert; Pfeil-runter öffnet, Pfeil hoch/runter
 *     wechselt zwischen Sub-Items, Enter aktiviert, Esc schließt.
 */
function NavItemWithSubMenu({
  to,
  label,
  subItems,
}: {
  to: string;
  label: string;
  subItems: NavSubItem[];
}) {
  const [open, setOpen] = useState(false);
  const [activeIndex, setActiveIndex] = useState(-1);
  const wrapperRef = useRef<HTMLDivElement | null>(null);
  const itemRefs = useRef<Array<HTMLAnchorElement | null>>([]);
  const openTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const closeTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

  const cancelTimers = (): void => {
    if (openTimer.current) {
      clearTimeout(openTimer.current);
      openTimer.current = null;
    }
    if (closeTimer.current) {
      clearTimeout(closeTimer.current);
      closeTimer.current = null;
    }
  };

  const scheduleOpen = (): void => {
    cancelTimers();
    openTimer.current = setTimeout(() => setOpen(true), 80);
  };

  const scheduleClose = (): void => {
    cancelTimers();
    closeTimer.current = setTimeout(() => {
      setOpen(false);
      setActiveIndex(-1);
    }, 150);
  };

  // Click-outside + Esc
  useEffect(() => {
    if (!open) return;
    const onDocClick = (ev: MouseEvent): void => {
      if (
        wrapperRef.current &&
        !wrapperRef.current.contains(ev.target as Node)
      ) {
        setOpen(false);
        setActiveIndex(-1);
      }
    };
    const onKey = (ev: KeyboardEvent): void => {
      if (ev.key === "Escape") {
        setOpen(false);
        setActiveIndex(-1);
      }
    };
    document.addEventListener("mousedown", onDocClick, true);
    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("mousedown", onDocClick, true);
      document.removeEventListener("keydown", onKey);
    };
  }, [open]);

  // Cleanup Timer beim Unmount
  useEffect(() => () => cancelTimers(), []);

  const onTopKeyDown = (ev: React.KeyboardEvent<HTMLAnchorElement>): void => {
    if (ev.key === "ArrowDown") {
      ev.preventDefault();
      setOpen(true);
      setActiveIndex(0);
      itemRefs.current[0]?.focus();
    }
  };

  const onItemKeyDown = (
    ev: React.KeyboardEvent<HTMLAnchorElement>,
    idx: number,
  ): void => {
    if (ev.key === "ArrowDown") {
      ev.preventDefault();
      const next = (idx + 1) % subItems.length;
      setActiveIndex(next);
      itemRefs.current[next]?.focus();
    } else if (ev.key === "ArrowUp") {
      ev.preventDefault();
      const next = (idx - 1 + subItems.length) % subItems.length;
      setActiveIndex(next);
      itemRefs.current[next]?.focus();
    } else if (ev.key === "Escape") {
      setOpen(false);
      setActiveIndex(-1);
    }
  };

  return (
    <div
      className="topbar__menu"
      ref={wrapperRef}
      onMouseEnter={scheduleOpen}
      onMouseLeave={scheduleClose}
    >
      <NavLink
        to={to}
        className={({ isActive }) =>
          "topbar__link topbar__link--has-sub" +
          (isActive ? " topbar__link--active" : "")
        }
        aria-haspopup="menu"
        aria-expanded={open}
        onKeyDown={onTopKeyDown}
        onFocus={() => setOpen(true)}
      >
        {label}
        <span className="topbar__chev" aria-hidden>
          ▾
        </span>
      </NavLink>
      {open && (
        <div
          className="topbar__submenu"
          role="menu"
          aria-label={`${label} Untermenü`}
        >
          {subItems.map((item, idx) => (
            <NavLink
              key={item.to}
              to={item.to}
              role="menuitem"
              ref={(el) => {
                itemRefs.current[idx] = el;
              }}
              className={({ isActive }) =>
                "topbar__submenu-item" +
                (isActive ? " topbar__submenu-item--active" : "") +
                (activeIndex === idx ? " topbar__submenu-item--focused" : "")
              }
              onClick={() => {
                setOpen(false);
                setActiveIndex(-1);
              }}
              onKeyDown={(ev) => onItemKeyDown(ev, idx)}
            >
              {item.label}
            </NavLink>
          ))}
        </div>
      )}
    </div>
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

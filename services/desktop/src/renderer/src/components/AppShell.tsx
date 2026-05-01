import type { PropsWithChildren } from "react";
import { NavLink } from "react-router-dom";
import { AlertBell } from "./AlertBell";
import { WatchChip } from "./WatchChip";
import logoUrl from "../assets/logo-aqua.svg";

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
      <main className="app-shell__main">{children}</main>
    </div>
  );
}

function TopBar() {
  return (
    <header className="topbar">
      <div className="topbar__brand" aria-label="AVA">
        <img src={logoUrl} alt="" draggable={false} />
      </div>
      <nav className="topbar__nav">
        <NavItem to="/chat" label="Chat" />
        <NavItem to="/ingest" label="Import" />
        <NavItem to="/transactions" label="Vorgänge" />
        <NavItem to="/companies" label="Firmen" />
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

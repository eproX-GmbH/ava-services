// Phase U3 — Settings filter box.
//
// Static manifest of {label, tab, anchor} entries (one per known
// section + sub-heading). Renders an `<input>` above the sidebar; on
// non-empty value, fuzz-matches manifest entries and shows a flat
// dropdown of "label · tab" rows. Selection navigates to
// `/settings/${tab}#${anchor}`.
//
// Also plumbs into the existing slash-palette so `/einstellungen tarif`
// (or just `/tarif`) shows these entries inline.
//
// Keyboard shortcuts: `g s` from anywhere in the app jumps to
// `/settings`; once on Settings, `/` focuses the filter box.
//
// Status: stub. Wire up in v0.1.140 (separate release). The sidebar
// already mounts this component (hidden via `.settings-shell__search`
// CSS `display: none`) so we own the slot.
export function SettingsSearch() {
  return (
    <div className="settings-shell__search" aria-hidden="true">
      {/* U3 — Suchfeld zieht hier ein. */}
    </div>
  );
}

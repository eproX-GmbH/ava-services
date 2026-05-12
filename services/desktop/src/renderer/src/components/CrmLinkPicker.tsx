// Workstream C4 — manual CRM-link picker dialog.
//
// Opens from the CompanyDetail CRM panel ("Mit CRM verknüpfen") and
// any future surface that wants to attach a HubSpot company id to an
// AVA company. Behaviour:
//   - CRM dropdown: HubSpot enabled today; Salesforce + Dynamics
//     disabled with a "noch nicht eingerichtet" hint.
//   - On open, the search input is pre-filled with the AVA company
//     name + an auto-search is fired so the user sees candidates
//     immediately.
//   - User picks one row, clicks "Verknüpfen"; we call the gateway via
//     `window.api.crm.linkManually` and invalidate the parent's CRM
//     queries on success.
//
// Esc / backdrop click cancels (mirrors LinkedInConsentModal). No CSS
// framework — reuses `.panel`, `.muted`, `.primary`, `.link` from
// styles.css plus a couple of local rules already in the LinkedIn
// modal's overlay vocabulary.

import { useEffect, useRef, useState } from "react";
import { useQueryClient } from "@tanstack/react-query";

interface Props {
  companyId: string;
  defaultQuery: string;
  onClose: () => void;
  onLinked: () => void;
}

type CrmKind = "HUBSPOT" | "SALESFORCE" | "DYNAMICS";

interface HubspotHit {
  id: string;
  name: string | null;
  domain: string | null;
  city: string | null;
}

export function CrmLinkPicker({
  companyId,
  defaultQuery,
  onClose,
  onLinked,
}: Props) {
  // v0.1.153 — Picker is now conditionally MOUNTED by the parent
  // rather than always-rendered with an `open` toggle. That removes
  // the need for a reset-on-open effect (the picker's first render
  // IS the open state) and prevents the flash of stale state from
  // a previous session.
  const [crmKind, setCrmKind] = useState<CrmKind>("HUBSPOT");
  const [query, setQuery] = useState(defaultQuery);
  const [results, setResults] = useState<HubspotHit[]>([]);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  // v0.1.153 — Initial value `true` so the panel renders the "Suche…"
  // hint from the first paint instead of flashing "Keine Treffer." for
  // 250 ms while the initial debounced search is still scheduled.
  // The auto-search effect below clears it via runSearch when the
  // request completes (or sets it false if the query is too short).
  const [searching, setSearching] = useState(true);
  const debounceRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const queryClient = useQueryClient();

  // Esc to dismiss.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose]);

  // Debounced auto-search whenever the query changes. The picker only
  // exercises HubSpot today; other CRMs short-circuit before this fires.
  useEffect(() => {
    if (crmKind !== "HUBSPOT") return;
    if (debounceRef.current) clearTimeout(debounceRef.current);
    const q = query.trim();
    if (q.length < 2) {
      setResults([]);
      setSelectedId(null);
      setSearching(false);
      return;
    }
    // Flip into "searching" SYNCHRONOUSLY so the panel doesn't flash
    // "Keine Treffer." during the 250 ms debounce window. runSearch
    // will set it again (idempotent) and clear it on completion.
    setSearching(true);
    debounceRef.current = setTimeout(() => {
      void runSearch(q);
    }, 250);
    return () => {
      if (debounceRef.current) clearTimeout(debounceRef.current);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [query, crmKind]);

  async function runSearch(q: string) {
    setSearching(true);
    setError(null);
    try {
      const res = await window.api.crm.searchHubspotCompanies({
        query: q,
        limit: 25,
      });
      if (res.error) {
        setError(res.error);
        setResults([]);
        return;
      }
      setResults(res.items);
      setSelectedId(res.items[0]?.id ?? null);
    } finally {
      setSearching(false);
    }
  }

  async function confirmLink() {
    if (busy || !selectedId) return;
    const hit = results.find((r) => r.id === selectedId);
    if (!hit) return;
    setBusy(true);
    setError(null);
    try {
      const res = await window.api.crm.linkManually({
        companyId,
        crmType: "HUBSPOT",
        crmExternalId: hit.id,
        crmDisplayName: hit.name ?? null,
      });
      if (!res.ok) {
        setError(res.error);
        return;
      }
      // Refresh the parent's CRM-link queries.
      void queryClient.invalidateQueries({ queryKey: ["crm-links", companyId] });
      void queryClient.invalidateQueries({ queryKey: ["crm-details", companyId] });
      onLinked();
    } finally {
      setBusy(false);
    }
  }

  return (
    <div
      className="linkedin-consent-overlay"
      role="dialog"
      aria-modal="true"
      aria-labelledby="crm-link-picker-title"
      onMouseDown={(e) => {
        if (e.target === e.currentTarget) onClose();
      }}
      // v0.1.153 — The shared overlay class top-anchors the panel
      // (align-items: flex-start + padding-top: 8vh) because the
      // LinkedIn consent modal is a long-form scroll. The CRM picker
      // is a compact dialog and the off-center placement looked
      // broken — vertical-center for this instance, leaving the
      // shared class behaviour for LinkedIn unchanged.
      style={{ alignItems: "center", paddingTop: 0 }}
    >
      <div
        className="linkedin-consent-panel"
        style={{ maxWidth: "560px", minWidth: "420px" }}
      >
        <header className="linkedin-consent-header">
          <h3 id="crm-link-picker-title">Firma mit CRM verknüpfen</h3>
          <p className="muted small">
            Wähle einen Datensatz aus deinem CRM, der dieser AVA-Firma
            entsprechen soll.
          </p>
        </header>

        <div style={{ marginBottom: "0.75rem" }}>
          <label className="muted small" htmlFor="crm-link-picker-kind">
            CRM
          </label>
          <select
            id="crm-link-picker-kind"
            value={crmKind}
            onChange={(e) => setCrmKind(e.target.value as CrmKind)}
            style={{ display: "block", width: "100%", marginTop: "0.25rem" }}
          >
            <option value="HUBSPOT">HubSpot</option>
            <option value="SALESFORCE" disabled>
              Salesforce (demnächst verfügbar)
            </option>
            <option value="DYNAMICS" disabled>
              Microsoft Dynamics (demnächst verfügbar)
            </option>
          </select>
        </div>

        <div style={{ marginBottom: "0.75rem" }}>
          <label className="muted small" htmlFor="crm-link-picker-q">
            Suche
          </label>
          <input
            id="crm-link-picker-q"
            type="search"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder="Firmenname oder Domain…"
            style={{ display: "block", width: "100%", marginTop: "0.25rem" }}
            autoFocus
          />
        </div>

        <div
          style={{
            maxHeight: "260px",
            overflowY: "auto",
            border: "1px solid var(--border, #2b3a44)",
            borderRadius: "6px",
            padding: "0.25rem",
          }}
        >
          {searching && <p className="muted small" style={{ padding: "0.5rem" }}>Suche…</p>}
          {!searching && results.length === 0 && (
            <p className="muted small" style={{ padding: "0.5rem" }}>
              {query.trim().length < 2
                ? "Mindestens zwei Zeichen eingeben."
                : "Keine Treffer."}
            </p>
          )}
          {results.map((r) => (
            <label
              key={r.id}
              style={{
                display: "flex",
                gap: "0.5rem",
                padding: "0.5rem",
                cursor: "pointer",
                borderRadius: "4px",
                background:
                  selectedId === r.id ? "rgba(56, 142, 142, 0.18)" : "transparent",
              }}
            >
              <input
                type="radio"
                name="crm-link-hit"
                checked={selectedId === r.id}
                onChange={() => setSelectedId(r.id)}
              />
              <span style={{ flex: 1 }}>
                <strong>{r.name ?? "(ohne Namen)"}</strong>
                <span className="muted small" style={{ marginLeft: "0.5rem" }}>
                  {[r.domain, r.city].filter(Boolean).join(" · ")}
                </span>
              </span>
            </label>
          ))}
        </div>

        {error && (
          <p className="error" style={{ marginTop: "0.5rem" }}>
            {error}
          </p>
        )}

        <div className="linkedin-consent-actions">
          <button type="button" className="link" onClick={onClose} disabled={busy}>
            Abbrechen
          </button>
          <button
            type="button"
            className="primary"
            disabled={!selectedId || busy}
            onClick={() => void confirmLink()}
          >
            {busy ? "Verknüpfe…" : "Verknüpfen"}
          </button>
        </div>
      </div>
    </div>
  );
}

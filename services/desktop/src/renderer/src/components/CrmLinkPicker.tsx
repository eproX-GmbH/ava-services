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
  open: boolean;
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
  open,
  companyId,
  defaultQuery,
  onClose,
  onLinked,
}: Props) {
  const [crmKind, setCrmKind] = useState<CrmKind>("HUBSPOT");
  const [query, setQuery] = useState(defaultQuery);
  const [results, setResults] = useState<HubspotHit[]>([]);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [searching, setSearching] = useState(false);
  const debounceRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const queryClient = useQueryClient();

  // Re-initialise every time the modal opens.
  useEffect(() => {
    if (!open) return;
    setQuery(defaultQuery);
    setResults([]);
    setSelectedId(null);
    setError(null);
    setBusy(false);
    setCrmKind("HUBSPOT");
  }, [open, defaultQuery]);

  // Esc to dismiss.
  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [open, onClose]);

  // Debounced auto-search whenever the query changes. The picker only
  // exercises HubSpot today; other CRMs short-circuit before this fires.
  useEffect(() => {
    if (!open) return;
    if (crmKind !== "HUBSPOT") return;
    if (debounceRef.current) clearTimeout(debounceRef.current);
    const q = query.trim();
    if (q.length < 2) {
      setResults([]);
      setSelectedId(null);
      return;
    }
    debounceRef.current = setTimeout(() => {
      void runSearch(q);
    }, 250);
    return () => {
      if (debounceRef.current) clearTimeout(debounceRef.current);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open, query, crmKind]);

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

  if (!open) return null;

  return (
    <div
      className="linkedin-consent-overlay"
      role="dialog"
      aria-modal="true"
      aria-labelledby="crm-link-picker-title"
      onMouseDown={(e) => {
        if (e.target === e.currentTarget) onClose();
      }}
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
              Salesforce (noch nicht eingerichtet)
            </option>
            <option value="DYNAMICS" disabled>
              Microsoft Dynamics (noch nicht eingerichtet)
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

import { useEffect, useState } from "react";
import { Link } from "react-router-dom";
import { useQuery } from "@tanstack/react-query";
import { Search, ChevronLeft, ChevronRight, Building2 } from "lucide-react";
import { gatewayFetch } from "../api/gateway";

// v0.1.61 — global "all companies" matrix.
//
// One row per distinct company the tenant has ever uploaded; one
// column per producer with the LATEST cell state across every
// transaction that ever included this company. Answers questions the
// per-transaction view can't:
//   "Is Foo GmbH's profile already done somewhere?"
//   "Which companies are still missing a website verdict?"
//
// Server-side aggregation lives in db-gateway/.../companies-matrix.ts;
// this component is a thin paginated viewer with a search box.
//
// Live updates aren't wired yet — react-query's refetchOnFocus picks
// up cell-state changes when the user comes back to the tab. The SSE
// bridge would be a follow-up; in practice users open this view to
// inspect, not to babysit a live run.

type StageState =
  | "pending"
  | "in_progress"
  | "completed"
  | "failed"
  | "skipped";

interface StageCell {
  state: StageState;
  updatedAt: string | null;
  errorMessage: string | null;
}

interface CompanyMatrixRow {
  companyId: string;
  name: string;
  location: string;
  lastSeenAt: string;
  stages: Record<string, StageCell>;
}

interface CompaniesMatrixResponse {
  pageNumber: number;
  pageSize: number;
  count: number;
  companies: CompanyMatrixRow[];
}

// Producer keys — must match db-gateway's PRODUCER_NAMES. Ordered to
// mirror the per-transaction matrix so users see a consistent layout.
const PRODUCERS = [
  "structured-content",
  "company-publication",
  "website",
  "company-profile",
  "company-contact",
  "company-evaluation",
] as const;

const PRODUCER_LABEL: Record<(typeof PRODUCERS)[number], string> = {
  "structured-content": "Struktur",
  "company-publication": "Publikation",
  website: "Website",
  "company-profile": "Profil",
  "company-contact": "Kontakt",
  "company-evaluation": "Bewertung",
};

const STATE_LABEL: Record<StageState, string> = {
  pending: "wartet",
  in_progress: "läuft",
  completed: "fertig",
  failed: "fehlgeschlagen",
  skipped: "übersprungen",
};

/** Map our state taxonomy onto the existing `.dot.<class>` styles
 *  (ok/warn/bad/muted/pending) so the matrix uses the same visual
 *  vocabulary as TransactionDetail. */
const STATE_DOT_CLASS: Record<StageState, string> = {
  completed: "ok",
  in_progress: "warn",
  failed: "bad",
  skipped: "muted",
  pending: "pending",
};

const PAGE_SIZE = 50;

export function AllCompanies() {
  const [page, setPage] = useState(1);
  const [searchInput, setSearchInput] = useState("");
  const [search, setSearch] = useState("");

  // Debounce the search box — 300ms after the last keystroke we issue
  // the query. Keeps the typing experience snappy without thrashing
  // master-data with one request per keystroke.
  useEffect(() => {
    const id = setTimeout(() => {
      setSearch(searchInput.trim());
      setPage(1);
    }, 300);
    return () => clearTimeout(id);
  }, [searchInput]);

  const matrix = useQuery<CompaniesMatrixResponse>({
    queryKey: ["companies-matrix", page, search],
    queryFn: () => {
      const qs = new URLSearchParams({
        pageNumber: String(page),
        pageSize: String(PAGE_SIZE),
        ...(search ? { search } : {}),
      });
      return gatewayFetch<CompaniesMatrixResponse>(
        `/v1/companies/matrix?${qs.toString()}`,
      );
    },
    refetchOnWindowFocus: true,
    // 30s polling — cheap enough for a dashboard view, lazy enough that
    // users don't see thrash. Real live updates would need an SSE
    // subscription patching cells in place; deferred to a follow-up.
    refetchInterval: 30_000,
  });

  const totalPages = matrix.data
    ? Math.max(1, Math.ceil(matrix.data.count / matrix.data.pageSize))
    : 1;

  return (
    <section className="all-companies page">
      <header className="ct-page-header all-companies__header">
        <p className="ct-page-header__eyebrow">
          <Building2 className="ct-icon-sm" aria-hidden="true" /> Portfolio
        </p>
        <h2 className="ct-page-header__title">
          <span className="ct-gradient-text">Meine Firmen</span>
        </h2>
        <p className="ct-page-header__lede">
          Status jeder Firma, die du jemals importiert hast — über alle
          Transaktionen hinweg. Eine Zelle zeigt den jüngsten Stand des
          jeweiligen Schritts.
        </p>
      </header>

      <div className="all-companies__filters ct-card" style={{ padding: "0.75rem 1rem" }}>
        <div className="all-companies__search-wrap">
          <Search className="ct-icon-sm all-companies__search-icon" aria-hidden="true" />
          <input
            type="search"
            placeholder="Firma suchen…"
            value={searchInput}
            onChange={(e) => setSearchInput(e.target.value)}
            className="all-companies__search"
            aria-label="Nach Firmenname suchen"
          />
        </div>
        {matrix.data && (
          <span className="ct-pill all-companies__count">
            {matrix.data.count.toLocaleString("de-DE")} Firmen
            {search ? ` · „${search}"` : ""}
          </span>
        )}
      </div>

      {matrix.isLoading && <p>Wird geladen…</p>}
      {matrix.error && (
        <p className="error">
          Fehler beim Laden: {(matrix.error as Error).message}
        </p>
      )}

      {matrix.data && matrix.data.companies.length === 0 && (
        <p className="muted">
          {search
            ? `Keine Firmen passen zu „${search}".`
            : "Du hast noch keine Firmen importiert."}
        </p>
      )}

      {matrix.data && matrix.data.companies.length > 0 && (
        <div className="ct-card all-companies__table-card" style={{ padding: 0, overflow: "hidden" }}>
          <table className="matrix all-companies__matrix">
            <thead>
              <tr>
                <th>Firma</th>
                {PRODUCERS.map((p) => (
                  <th key={p}>{PRODUCER_LABEL[p]}</th>
                ))}
                <th>Zuletzt gesehen</th>
              </tr>
            </thead>
            <tbody>
              {matrix.data.companies.map((row) => (
                <tr key={row.companyId}>
                  <td className="matrix-company">
                    <Link to={`/companies/${row.companyId}`}>{row.name}</Link>
                    <div className="muted small">{row.location}</div>
                  </td>
                  {PRODUCERS.map((p) => {
                    const cell = row.stages[p] ?? {
                      state: "pending" as const,
                      updatedAt: null,
                      errorMessage: null,
                    };
                    return (
                      <td key={p} className="matrix-cell">
                        <span
                          className={`dot ${STATE_DOT_CLASS[cell.state]}`}
                          title={`${PRODUCER_LABEL[p]}: ${STATE_LABEL[cell.state]}${cell.updatedAt ? ` (${formatTime(cell.updatedAt)})` : ""}${cell.errorMessage ? ` — ${cell.errorMessage}` : ""}`}
                          aria-label={`${PRODUCER_LABEL[p]}: ${STATE_LABEL[cell.state]}`}
                        />
                      </td>
                    );
                  })}
                  <td className="muted">{formatTime(row.lastSeenAt)}</td>
                </tr>
              ))}
            </tbody>
          </table>

          <footer className="all-companies__pager">
            <button
              type="button"
              onClick={() => setPage((p) => Math.max(1, p - 1))}
              disabled={page <= 1 || matrix.isFetching}
            >
              <ChevronLeft className="ct-icon-sm" aria-hidden="true" />
              Zurück
            </button>
            <span className="muted">
              Seite {matrix.data.pageNumber} von {totalPages}
            </span>
            <button
              type="button"
              onClick={() =>
                setPage((p) => Math.min(totalPages, p + 1))
              }
              disabled={page >= totalPages || matrix.isFetching}
            >
              Weiter
              <ChevronRight className="ct-icon-sm" aria-hidden="true" />
            </button>
          </footer>
        </div>
      )}
    </section>
  );
}

function formatTime(iso: string): string {
  try {
    return new Date(iso).toLocaleString("de-DE", {
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
      hour: "2-digit",
      minute: "2-digit",
    });
  } catch {
    return iso;
  }
}

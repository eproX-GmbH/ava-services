import { useState, useDeferredValue } from "react";
import { useQuery, keepPreviousData } from "@tanstack/react-query";
import { Link } from "react-router-dom";
import { gatewayFetch } from "../api/gateway";

// W6 — fuzzy search.
// W7 — paginated list with filters (filters deferred to a follow-up; the
//       gateway already accepts pageNumber/pageSize and the upstream's POST
//       body is empty for now).
//
// Search is the primary input. When the box is empty we render the paginated
// list as a fallback so the screen is useful even with no query. useDeferredValue
// keeps the input responsive while the request is in flight; React Query's
// keepPreviousData avoids the page flicker between keystrokes.

// Mirrors CompanyShape in db-gateway/src/routes/v1/schemas.ts. The canonical
// master-data fields are `companyId` + `location` (not `id`/`city`).
interface Company {
  companyId: string;
  name?: string | null;
  location?: string | null;
}
interface SearchResult<T> {
  items: T[];
  total: number;
}
interface Page<T> {
  items: T[];
  page: number;
  pageSize: number;
  total: number;
}

export function Companies() {
  const [q, setQ] = useState("");
  const [page, setPage] = useState(1);
  const pageSize = 25;
  const deferredQ = useDeferredValue(q);

  const search = useQuery({
    queryKey: ["companies", "search", deferredQ],
    queryFn: () =>
      gatewayFetch<SearchResult<Company>>("/v1/companies/search", {
        query: { q: deferredQ, limit: 25 },
      }),
    enabled: deferredQ.trim().length >= 2,
    placeholderData: keepPreviousData,
  });

  const list = useQuery({
    queryKey: ["companies", "list", page, pageSize],
    queryFn: () =>
      gatewayFetch<Page<Company>>("/v1/companies", {
        query: { page, pageSize },
      }),
    enabled: deferredQ.trim().length < 2,
    placeholderData: keepPreviousData,
  });

  const showSearch = deferredQ.trim().length >= 2;
  const items = showSearch ? search.data?.items : list.data?.items;
  const loading = showSearch ? search.isLoading : list.isLoading;
  const error = showSearch ? search.error : list.error;
  const totalPages = list.data ? Math.max(1, Math.ceil(list.data.total / pageSize)) : 1;

  return (
    <section>
      <h2>Companies</h2>
      <div className="toolbar">
        <input
          type="search"
          placeholder="Type 2+ chars to search…"
          value={q}
          onChange={(e) => {
            setQ(e.target.value);
            setPage(1);
          }}
          className="search"
        />
      </div>

      {loading && <p>Loading…</p>}
      {error && <p className="error">{(error as Error).message}</p>}
      {items && items.length === 0 && (
        <p className="muted">{showSearch ? "No matches." : "No companies."}</p>
      )}
      {items && items.length > 0 && (
        <table>
          <thead>
            <tr>
              <th>Name</th>
              <th>City</th>
              <th>ID</th>
            </tr>
          </thead>
          <tbody>
            {items.map((c) => (
              <tr key={c.companyId}>
                <td>
                  <Link to={`/companies/${c.companyId}`}>{c.name ?? "(unnamed)"}</Link>
                </td>
                <td>{c.location ?? <span className="muted">—</span>}</td>
                <td>
                  <code>{c.companyId.slice(0, 12)}…</code>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      )}

      {!showSearch && list.data && (
        <div className="pager">
          <button
            type="button"
            disabled={page <= 1}
            onClick={() => setPage((p) => Math.max(1, p - 1))}
          >
            ← prev
          </button>
          <span className="muted">
            page {page} / {totalPages} ({list.data.total} total)
          </span>
          <button
            type="button"
            disabled={page >= totalPages}
            onClick={() => setPage((p) => p + 1)}
          >
            next →
          </button>
        </div>
      )}
    </section>
  );
}

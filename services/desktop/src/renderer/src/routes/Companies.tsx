import { InsolvenzBadge, LandBadge, LandFilter, RegisterStatusBadge, registerKennung } from "../components/RegisterStatusBadge";
import { useState, useDeferredValue } from "react";
import { useQuery, keepPreviousData } from "@tanstack/react-query";
import { Link } from "react-router-dom";
import { gatewayFetch } from "../api/gateway";
import {
  GRUENDUNG_LEER,
  GruendungsjahrFilter,
  gruendungAktiv,
  gruendungAlsQuery,
  type GruendungsWerte,
} from "../components/GruendungsjahrFilter";

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
  registerStatus?: string | null;
  insolvencyStatus?: string | null;
  country?: string | null;
  registerType?: string | null;
  registerNumber?: string | null;
  /** Nur gesetzt, wenn nach Gruendungsjahr gefiltert oder sortiert wird. */
  foundingYear?: number | null;
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
  const [land, setLand] = useState("");
  const [gruendung, setGruendung] = useState<GruendungsWerte>(GRUENDUNG_LEER);
  const [page, setPage] = useState(1);
  const pageSize = 25;
  const deferredQ = useDeferredValue(q);
  // Gruendungsjahr-Filter: beide Wege (Suche und Liste) kennen ihn, deshalb
  // haengt er nur an der Anfrage und nicht an der Auswahl des Weges.
  const gruendungQuery = gruendungAlsQuery(gruendung);
  const gruendungAn = gruendungAktiv(gruendung);

  const search = useQuery({
    queryKey: ["companies", "search", deferredQ, land, gruendungQuery],
    queryFn: () =>
      gatewayFetch<SearchResult<Company>>("/v1/companies/search", {
        query: { q: deferredQ, limit: 25, ...(land ? { country: land } : {}), ...gruendungQuery },
      }),
    enabled: deferredQ.trim().length >= 2 && !gruendungAn,
    placeholderData: keepPreviousData,
  });

  const list = useQuery({
    queryKey: ["companies", "list", page, pageSize, land, gruendungQuery],
    queryFn: () =>
      gatewayFetch<Page<Company>>("/v1/companies", {
        query: {
          page,
          pageSize,
          ...(land ? { country: land } : {}),
          ...gruendungQuery,
          // Mit Gruendungsjahr-Filter laeuft auch die Namenssuche ueber diesen Weg,
          // damit sich das Ergebnis blaettern laesst.
          ...(gruendungAn && deferredQ.trim().length >= 2 ? { q: deferredQ.trim() } : {}),
        },
      }),
    enabled: deferredQ.trim().length < 2 || gruendungAn,
    placeholderData: keepPreviousData,
  });

  // Mit Gruendungsjahr-Filter immer der Listenweg: er kennt den Filter, liefert
  // das Jahr mit und laesst sich blaettern.
  const showSearch = deferredQ.trim().length >= 2 && !gruendungAn;
  const items = showSearch ? search.data?.items : list.data?.items;
  const loading = showSearch ? search.isLoading : list.isLoading;
  const error = showSearch ? search.error : list.error;
  const totalPages = list.data ? Math.max(1, Math.ceil(list.data.total / pageSize)) : 1;

  return (
    <section className="page">
      <header className="ct-page-header">
        <p className="ct-page-header__eyebrow">Stammdaten</p>
        <h2 className="ct-page-header__title">
          <span className="ct-gradient-text">Firmensuche</span>
        </h2>
        <p className="ct-page-header__lede">
          Suche im gesamten Stammdaten-Bestand nach Firmenname, Standort
          oder Branche. Treffer öffnen das vollständige Firmenprofil.
        </p>
      </header>
      <div className="toolbar">
        <input
          type="search"
          placeholder="Mind. 2 Zeichen zum Suchen…"
          value={q}
          onChange={(e) => {
            setQ(e.target.value);
            setPage(1);
          }}
          className="search"
        />
        <LandFilter
          value={land}
          onChange={(code) => {
            setLand(code);
            setPage(1);
          }}
        />
        <GruendungsjahrFilter
          werte={gruendung}
          onChange={(w) => {
            setGruendung(w);
            setPage(1);
          }}
        />
      </div>
      {gruendungAn && (
        <p className="muted small">
          Der Filter zeigt nur Firmen, deren Gründungsjahr aus dem Handelsregister bekannt ist. Der
          Suchbegriff wird dabei wörtlich im Firmennamen gesucht, nicht unscharf.
        </p>
      )}

      {loading && <p>Lädt…</p>}
      {error && <p className="error">{(error as Error).message}</p>}
      {items && items.length === 0 && (
        <p className="muted">
          {gruendungAn
            ? "Keine Firma mit bekanntem Gründungsjahr passt zu diesem Filter."
            : showSearch
              ? "Keine Treffer."
              : "Keine Firmen vorhanden."}
        </p>
      )}
      {items && items.length > 0 && (
        <table>
          <thead>
            <tr>
              <th>Name</th>
              <th>Stadt</th>
              {gruendungAn && <th>Gegründet</th>}
              <th>Register</th>
              <th>ID</th>
            </tr>
          </thead>
          <tbody>
            {items.map((c) => (
              <tr key={c.companyId}>
                <td>
                  <Link to={`/companies/${c.companyId}`}>
                    {c.name ?? "(ohne Namen)"}
                  </Link>
                  <LandBadge country={c.country} />
                  <RegisterStatusBadge status={c.registerStatus} />
                  <InsolvenzBadge status={c.insolvencyStatus} />
                </td>
                <td>{c.location ?? <span className="muted"></span>}</td>
                {gruendungAn && <td>{c.foundingYear ?? <span className="muted">unbekannt</span>}</td>}
                <td className="muted small">{registerKennung(c) ?? ""}</td>
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
            ← zurück
          </button>
          <span className="muted">
            Seite {page} / {totalPages} ({list.data.total} insgesamt)
          </span>
          <button
            type="button"
            disabled={page >= totalPages}
            onClick={() => setPage((p) => p + 1)}
          >
            weiter →
          </button>
        </div>
      )}
    </section>
  );
}

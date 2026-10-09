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

// W6 — Firmensuche ueber den Stammdaten-Bestand (Elasticsearch, unscharf).
//
// 2026-10-09: Ohne Suchbegriff wird KEINE Liste mehr geladen. Der Listenweg
// zaehlt im master-data die gesamte Tabelle (7,9 Mio. Zeilen) und stand
// deshalb minutenlang auf „Lädt…". Stattdessen ein Leerzustand mit
// Beispielen; die Liste gibt es nur noch mit Gruendungsjahr-Filter (eigener,
// gefilterter Weg, blaetterbar). useDeferredValue haelt die Eingabe fluessig,
// keepPreviousData verhindert das Flackern zwischen zwei Anschlaegen.

// Spiegelt CompanyShape in db-gateway/src/routes/v1/schemas.ts.
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

const BEISPIELE = ["Maschinenbau Straubing", "KUKA", "Software Minden", "Logistik Wien"];
const zahl = new Intl.NumberFormat("de-DE");

function SuchIcon() {
  return (
    <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <circle cx="11" cy="11" r="7" />
      <path d="m20 20-3.5-3.5" />
    </svg>
  );
}

function Chevron() {
  return (
    <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <path d="m9 6 6 6-6 6" />
    </svg>
  );
}

export function Companies() {
  const [q, setQ] = useState("");
  const [land, setLand] = useState("");
  const [gruendung, setGruendung] = useState<GruendungsWerte>(GRUENDUNG_LEER);
  const [page, setPage] = useState(1);
  const pageSize = 25;
  const deferredQ = useDeferredValue(q);
  const gruendungQuery = gruendungAlsQuery(gruendung);
  const gruendungAn = gruendungAktiv(gruendung);
  const suchbegriff = deferredQ.trim();
  const suchbereit = suchbegriff.length >= 2;

  const search = useQuery({
    queryKey: ["companies", "search", suchbegriff, land, gruendungQuery],
    queryFn: () =>
      gatewayFetch<SearchResult<Company>>("/v1/companies/search", {
        query: { q: suchbegriff, limit: 25, ...(land ? { country: land } : {}), ...gruendungQuery },
      }),
    enabled: suchbereit && !gruendungAn,
    placeholderData: keepPreviousData,
  });

  // Listenweg nur mit Gruendungsjahr-Filter: er kennt den Filter, liefert das
  // Jahr mit und laesst sich blaettern. Ohne Filter gibt es keine Liste.
  const list = useQuery({
    queryKey: ["companies", "list", page, pageSize, land, gruendungQuery],
    queryFn: () =>
      gatewayFetch<Page<Company>>("/v1/companies", {
        query: {
          page,
          pageSize,
          ...(land ? { country: land } : {}),
          ...gruendungQuery,
          ...(suchbereit ? { q: suchbegriff } : {}),
        },
      }),
    enabled: gruendungAn,
    placeholderData: keepPreviousData,
  });

  const showSearch = suchbereit && !gruendungAn;
  const aktiv = showSearch || gruendungAn;
  const items = showSearch ? search.data?.items : gruendungAn ? list.data?.items : undefined;
  const total = showSearch ? search.data?.total : gruendungAn ? list.data?.total : undefined;
  const loading = showSearch ? search.isLoading : gruendungAn ? list.isLoading : false;
  const fetching = showSearch ? search.isFetching : gruendungAn ? list.isFetching : false;
  const error = showSearch ? search.error : gruendungAn ? list.error : null;
  const totalPages = list.data ? Math.max(1, Math.ceil(list.data.total / pageSize)) : 1;

  const setzeSuche = (wert: string) => {
    setQ(wert);
    setPage(1);
  };

  return (
    <section className="page firmensuche">
      <header className="ct-page-header">
        <p className="ct-page-header__eyebrow">Stammdaten</p>
        <h2 className="ct-page-header__title">
          <span className="ct-gradient-text">Firmensuche</span>
        </h2>
        <p className="ct-page-header__lede">
          Suche im gesamten Stammdaten-Bestand nach Firmenname, Standort oder Registernummer. Treffer öffnen das
          vollständige Firmenprofil.
        </p>
      </header>

      <div className="firmensuche__panel">
        <label className="firmensuche__eingabe">
          <span className="firmensuche__icon" aria-hidden="true">
            <SuchIcon />
          </span>
          <input
            type="search"
            placeholder="Firmenname, Ort oder Registernummer …"
            value={q}
            onChange={(e) => setzeSuche(e.target.value)}
            aria-label="Suchbegriff"
            autoFocus
          />
          {fetching && aktiv && <span className="firmensuche__spinner" aria-label="Sucht" />}
        </label>
        <div className="firmensuche__filter">
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
          <p className="firmensuche__hinweis">
            Der Filter zeigt nur Firmen, deren Gründungsjahr aus dem Handelsregister bekannt ist. Der Suchbegriff wird
            dabei wörtlich im Firmennamen gesucht, nicht unscharf.
          </p>
        )}
      </div>

      {!aktiv && (
        <div className="firmensuche__leer">
          <p className="firmensuche__leer-titel">Wonach suchst du?</p>
          <p className="muted">
            Ab zwei Zeichen sucht AVA unscharf über 7,9 Millionen Firmen aus Deutschland, Österreich und dem Vereinigten
            Königreich. Tippfehler und Schreibvarianten sind erlaubt.
          </p>
          <div className="firmensuche__beispiele" aria-label="Beispiele">
            {BEISPIELE.map((b) => (
              <button key={b} type="button" className="firmensuche__beispiel" onClick={() => setzeSuche(b)}>
                {b}
              </button>
            ))}
          </div>
        </div>
      )}

      {aktiv && loading && (
        <ul className="firmen-liste" aria-busy="true" aria-label="Lädt">
          {[0, 1, 2, 3, 4].map((i) => (
            <li key={i} className="firmen-treffer firmen-treffer--skelett">
              <span className="firmen-treffer__skelett-zeile" style={{ width: `${48 + ((i * 17) % 30)}%` }} />
              <span className="firmen-treffer__skelett-zeile firmen-treffer__skelett-zeile--klein" style={{ width: `${28 + ((i * 11) % 20)}%` }} />
            </li>
          ))}
        </ul>
      )}
      {error && <p className="error">{(error as Error).message}</p>}

      {aktiv && !loading && items && items.length === 0 && (
        <div className="firmensuche__leer">
          <p className="firmensuche__leer-titel">
            {gruendungAn ? "Keine Firma mit bekanntem Gründungsjahr passt zu diesem Filter." : "Keine Treffer."}
          </p>
          <p className="muted">
            {gruendungAn
              ? "Weite den Zeitraum oder entferne das Land."
              : "Versuch es mit einem kürzeren Begriff, dem Ort oder der Registernummer. Firmen ausserhalb von Deutschland, Österreich und UK sind nicht im Bestand."}
          </p>
        </div>
      )}

      {aktiv && items && items.length > 0 && (
        <>
          <p className="firmensuche__zaehler">
            {typeof total === "number" ? (
              <>
                <strong>{zahl.format(total)}</strong> {total === 1 ? "Treffer" : "Treffer"}
                {total > items.length && !gruendungAn ? `, die ${items.length} besten angezeigt` : ""}
                {gruendungAn ? `, Seite ${page} von ${totalPages}` : ""}
              </>
            ) : (
              `${items.length} Treffer`
            )}
          </p>
          <ul className="firmen-liste">
            {items.map((c) => {
              const kennung = registerKennung(c);
              const meta = [c.location, kennung, gruendungAn ? (c.foundingYear ? `gegründet ${c.foundingYear}` : "Gründungsjahr unbekannt") : null].filter(Boolean);
              return (
                <li key={c.companyId} className="firmen-treffer">
                  <Link to={`/companies/${c.companyId}`} className="firmen-treffer__link">
                    <span className="firmen-treffer__text">
                      <span className="firmen-treffer__name">
                        {c.name ?? "(ohne Namen)"}
                        <LandBadge country={c.country} />
                        <RegisterStatusBadge status={c.registerStatus} />
                        <InsolvenzBadge status={c.insolvencyStatus} />
                      </span>
                      <span className="firmen-treffer__meta">
                        {meta.length > 0 ? meta.join(" · ") : <span className="muted">ohne Ortsangabe</span>}
                      </span>
                    </span>
                    <span className="firmen-treffer__pfeil" aria-hidden="true">
                      <Chevron />
                    </span>
                  </Link>
                </li>
              );
            })}
          </ul>
        </>
      )}

      {gruendungAn && list.data && list.data.total > pageSize && (
        <div className="pager">
          <button type="button" disabled={page <= 1} onClick={() => setPage((p) => Math.max(1, p - 1))}>
            ← zurück
          </button>
          <span className="muted">
            Seite {page} / {totalPages} ({zahl.format(list.data.total)} insgesamt)
          </span>
          <button type="button" disabled={page >= totalPages} onClick={() => setPage((p) => p + 1)}>
            weiter →
          </button>
        </div>
      )}
    </section>
  );
}

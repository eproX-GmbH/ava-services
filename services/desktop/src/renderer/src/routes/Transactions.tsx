import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Link, useNavigate } from "react-router-dom";
import { useState } from "react";
import { gatewayFetch } from "../api/gateway";
import { fmtDate } from "../lib/format";
import { ProcessingToggle } from "../components/ProcessingToggle";

// W2 — list the actor's transactions. Uses the gateway's §4.2 read.

interface Transaction {
  id: string;
  name?: string | null;
  startTime?: string | null;
  companyCount?: number | null;
  createdAt: string;
  /** O8 — mit der Organisation geteilt. */
  shared?: { shareId: string; by: string; byName?: string | null; at: string; note?: string | null; own: boolean };
}
interface Page<T> {
  items: T[];
  page: number;
  pageSize: number;
  total: number;
}

export function Transactions() {
  const qc = useQueryClient();
  const navigate = useNavigate();
  const [adoptId, setAdoptId] = useState<string | null>(null);
  // O8 — geteilte Transaktion uebernehmen: eigene Kopie mit kopiertem Fortschritt.
  const adopt = useMutation({
    mutationFn: (id: string) =>
      gatewayFetch<{ transactionId: string }>(`/v1/transactions/${encodeURIComponent(id)}/adopt`, { method: "POST", body: {} }),
    onSuccess: (r) => {
      void qc.invalidateQueries({ queryKey: ["transactions"] });
      void qc.invalidateQueries({ queryKey: ["companies"] });
      navigate(`/transactions/${r.transactionId}`);
    },
  });
  const q = useQuery({
    queryKey: ["transactions"],
    queryFn: () =>
      gatewayFetch<Page<Transaction>>("/v1/transactions", {
        query: { page: 1, pageSize: 50, includeShared: 1 },
      }),
    // Refetch on every remount — analysts come back to this page
    // expecting to see the latest, not what was cached when they last
    // looked. Cached data still paints immediately to avoid flashing.
    staleTime: 0,
    refetchOnMount: "always",
  });

  const eigene = (q.data?.items ?? []).filter((t) => !t.shared || t.shared.own);
  const geteilte = (q.data?.items ?? []).filter((t) => t.shared && !t.shared.own);

  return (
    <section className="page">
      <header className="ct-page-header">
        <p className="ct-page-header__eyebrow">Pipeline</p>
        <h2 className="ct-page-header__title">
          <span className="ct-gradient-text">Vorgänge</span>
        </h2>
        <p className="ct-page-header__lede">
          Alle Import-Vorgänge mit ihrem aktuellen Status. Jeder Vorgang
          gruppiert die Firmen einer Excel-Datei oder eines manuellen
          Imports.
        </p>
        <div className="proc-toggle-bar">
          <ProcessingToggle />
        </div>
      </header>
      {q.isLoading && <p>Lädt…</p>}
      {q.error && <p className="error">Fehler: {(q.error as Error).message}</p>}
      {q.data && eigene.length === 0 && <p>Noch keine Vorgänge.</p>}
      {q.data && eigene.length > 0 && (
        <table>
          <thead>
            <tr>
              <th>Name</th>
              <th>Gestartet</th>
              <th>Firmen</th>
              <th>Live</th>
            </tr>
          </thead>
          <tbody>
            {eigene.map((t) => (
              <tr key={t.id}>
                <td>
                  <Link to={`/transactions/${t.id}`}>
                    {t.name && t.name.trim().length > 0 ? (
                      t.name
                    ) : (
                      <span className="muted">Ohne Namen</span>
                    )}
                  </Link>
                  {t.shared && <span className="badge ok" style={{ marginLeft: "0.5rem" }}>geteilt</span>}
                </td>
                <td>{t.startTime ? fmtDate(t.startTime) : ""}</td>
                <td>{t.companyCount ?? ""}</td>
                <td>
                  <Link to={`/transactions/${t.id}/stream`}>Live →</Link>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
      {geteilte.length > 0 && (
        <section className="provider-section">
          <h3>Aus der Organisation</h3>
          <p className="muted small">
            Vorgänge, die Kolleginnen und Kollegen mit der Organisation geteilt haben. Du kannst sie ansehen; mit „Übernehmen"
            bekommst du eine eigene Kopie samt Verarbeitungsfortschritt, und die Firmen erscheinen in „Meine Firmen".
          </p>
          <table>
            <thead>
              <tr>
                <th>Name</th>
                <th>Geteilt von</th>
                <th>Firmen</th>
                <th />
              </tr>
            </thead>
            <tbody>
              {geteilte.map((t) => (
                <tr key={t.id}>
                  <td>
                    <Link to={`/transactions/${t.id}`}>
                      {t.name && t.name.trim().length > 0 ? t.name : <span className="muted">Ohne Namen</span>}
                    </Link>
                  </td>
                  <td>
                    {t.shared?.byName ?? `${t.shared?.by.slice(0, 8)}…`}
                    <span className="muted small"> · {t.shared?.at ? fmtDate(t.shared.at) : ""}</span>
                  </td>
                  <td>{t.companyCount ?? ""}</td>
                  <td>
                    <button
                      type="button"
                      className="btn"
                      disabled={adopt.isPending && adoptId === t.id}
                      onClick={() => {
                        setAdoptId(t.id);
                        adopt.mutate(t.id);
                      }}
                    >
                      {adopt.isPending && adoptId === t.id ? "Übernimmt…" : "Übernehmen"}
                    </button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
          {adopt.error && <p className="error">{(adopt.error as Error).message}</p>}
        </section>
      )}
    </section>
  );
}

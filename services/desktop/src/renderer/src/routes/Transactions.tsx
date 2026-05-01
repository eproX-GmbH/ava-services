import { useQuery } from "@tanstack/react-query";
import { Link } from "react-router-dom";
import { gatewayFetch } from "../api/gateway";
import { fmtDate } from "../lib/format";

// W2 — list the actor's transactions. Uses the gateway's §4.2 read.

interface Transaction {
  id: string;
  name?: string | null;
  startTime?: string | null;
  companyCount?: number | null;
  createdAt: string;
}
interface Page<T> {
  items: T[];
  page: number;
  pageSize: number;
  total: number;
}

export function Transactions() {
  const q = useQuery({
    queryKey: ["transactions"],
    queryFn: () =>
      gatewayFetch<Page<Transaction>>("/v1/transactions", {
        query: { page: 1, pageSize: 50 },
      }),
    // Refetch on every remount — analysts come back to this page
    // expecting to see the latest, not what was cached when they last
    // looked. Cached data still paints immediately to avoid flashing.
    staleTime: 0,
    refetchOnMount: "always",
  });

  return (
    <section>
      <h2>Vorgänge</h2>
      {q.isLoading && <p>Lädt…</p>}
      {q.error && <p className="error">Fehler: {(q.error as Error).message}</p>}
      {q.data && q.data.items.length === 0 && <p>Noch keine Vorgänge.</p>}
      {q.data && q.data.items.length > 0 && (
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
            {q.data.items.map((t) => (
              <tr key={t.id}>
                <td>
                  <Link to={`/transactions/${t.id}`}>
                    {t.name && t.name.trim().length > 0 ? (
                      t.name
                    ) : (
                      <span className="muted">Ohne Namen</span>
                    )}
                  </Link>
                </td>
                <td>{t.startTime ? fmtDate(t.startTime) : "—"}</td>
                <td>{t.companyCount ?? "—"}</td>
                <td>
                  <Link to={`/transactions/${t.id}/stream`}>Live →</Link>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </section>
  );
}

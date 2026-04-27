import { useQuery } from "@tanstack/react-query";
import { Link } from "react-router-dom";
import { gatewayFetch } from "../api/gateway";

// W2 — list the actor's transactions. Uses the gateway's §4.2 read.

interface Transaction {
  id: string;
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
  });

  return (
    <section>
      <h2>Transactions</h2>
      {q.isLoading && <p>Loading…</p>}
      {q.error && <p className="error">Error: {(q.error as Error).message}</p>}
      {q.data && q.data.items.length === 0 && <p>No transactions yet.</p>}
      {q.data && q.data.items.length > 0 && (
        <table>
          <thead>
            <tr>
              <th>ID</th>
              <th>Started</th>
              <th>Companies</th>
              <th>Live</th>
            </tr>
          </thead>
          <tbody>
            {q.data.items.map((t) => (
              <tr key={t.id}>
                <td><code>{t.id.slice(0, 8)}…</code></td>
                <td>{t.startTime ?? "—"}</td>
                <td>{t.companyCount ?? "—"}</td>
                <td>
                  <Link to={`/transactions/${t.id}/stream`}>open stream →</Link>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </section>
  );
}

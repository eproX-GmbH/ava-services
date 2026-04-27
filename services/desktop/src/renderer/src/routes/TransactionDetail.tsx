import { useQuery } from "@tanstack/react-query";
import { Link, useParams } from "react-router-dom";
import { gatewayFetch } from "../api/gateway";

// W3 — transaction detail with per-entity state breakdown.
// W5 — processing errors for the transaction.
//
// Three queries on one screen because they're naturally read together: the
// header summary, the per-(transaction, company) entity state matrix, and
// any errors. React Query handles them independently so a slow errors
// upstream doesn't gate the rest of the page.

interface Transaction {
  id: string;
  startTime?: string | null;
  companyCount?: number | null;
  createdAt: string;
  name?: string | null;
}
interface Entity {
  companyId: string;
  service: string;
  state: string;
  updatedAt?: string | null;
}
interface ProcessingError {
  companyId: string;
  service: string;
  message: string;
  occurredAt?: string | null;
}
interface Page<T> {
  items: T[];
  page: number;
  pageSize: number;
  total: number;
}

export function TransactionDetail() {
  const { id } = useParams<{ id: string }>();

  const detail = useQuery({
    queryKey: ["transaction", id],
    queryFn: () => gatewayFetch<Transaction>(`/v1/transactions/${id}`),
    enabled: !!id,
  });

  const entities = useQuery({
    queryKey: ["transaction", id, "entities"],
    queryFn: () =>
      gatewayFetch<Page<Entity>>(`/v1/transactions/${id}/entities`, {
        query: { page: 1, pageSize: 200 },
      }),
    enabled: !!id,
  });

  const errors = useQuery({
    queryKey: ["transaction", id, "errors"],
    queryFn: () =>
      gatewayFetch<{ items: ProcessingError[] }>(`/v1/transactions/${id}/errors`),
    enabled: !!id,
  });

  return (
    <section>
      <h2>
        Transaction <code>{id?.slice(0, 8)}…</code>{" "}
        <Link to={`/transactions/${id}/stream`} className="muted">
          (live stream)
        </Link>{" "}
        <Link to={`/transactions/${id}/evaluations`} className="muted">
          (evaluations)
        </Link>
      </h2>

      {detail.isLoading && <p>Loading…</p>}
      {detail.error && <p className="error">{(detail.error as Error).message}</p>}
      {detail.data && (
        <dl>
          <dt>Name</dt>
          <dd>{detail.data.name ?? <span className="muted">—</span>}</dd>
          <dt>Started</dt>
          <dd>{detail.data.startTime ?? detail.data.createdAt}</dd>
          <dt>Companies</dt>
          <dd>{detail.data.companyCount ?? "—"}</dd>
        </dl>
      )}

      <h3>Per-entity state ({entities.data?.total ?? 0})</h3>
      {entities.isLoading && <p>Loading entities…</p>}
      {entities.error && (
        <p className="error">Entities: {(entities.error as Error).message}</p>
      )}
      {entities.data && entities.data.items.length === 0 && (
        <p className="muted">No entity rows yet.</p>
      )}
      {entities.data && entities.data.items.length > 0 && (
        <table>
          <thead>
            <tr>
              <th>Company</th>
              <th>Service</th>
              <th>State</th>
              <th>Updated</th>
            </tr>
          </thead>
          <tbody>
            {entities.data.items.map((e, i) => (
              <tr key={`${e.companyId}-${e.service}-${i}`}>
                <td>
                  <Link to={`/companies/${e.companyId}`}>
                    <code>{e.companyId.slice(0, 12)}…</code>
                  </Link>
                </td>
                <td>{e.service}</td>
                <td>
                  <StateBadge state={e.state} />
                </td>
                <td className="muted">{e.updatedAt ?? "—"}</td>
              </tr>
            ))}
          </tbody>
        </table>
      )}

      <h3>Errors ({errors.data?.items.length ?? 0})</h3>
      {errors.isLoading && <p>Loading errors…</p>}
      {errors.error && (
        <p className="error">Errors: {(errors.error as Error).message}</p>
      )}
      {errors.data && errors.data.items.length === 0 && (
        <p className="muted">No errors. ✓</p>
      )}
      {errors.data && errors.data.items.length > 0 && (
        <ul className="event-log">
          {errors.data.items.map((e, i) => (
            <li key={i}>
              <strong>{e.service}</strong>{" "}
              <code>{e.companyId.slice(0, 12)}…</code>{" "}
              <span className="muted">{e.occurredAt ?? ""}</span>
              <pre>{e.message}</pre>
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}

function StateBadge({ state }: { state: string }) {
  // Lightweight visual cue — the service-side enum has DONE / IN_PROGRESS /
  // ERROR / INTERIM. We don't enum-check at the renderer because adding a
  // new state upstream shouldn't break the screen.
  const cls =
    state === "DONE" ? "ok" : state === "ERROR" ? "bad" : state === "IN_PROGRESS" ? "warn" : "muted";
  return <span className={`badge ${cls}`}>{state}</span>;
}

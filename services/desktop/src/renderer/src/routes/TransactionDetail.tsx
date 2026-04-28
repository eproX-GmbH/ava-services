import { useEffect, useMemo, useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { Link, useParams } from "react-router-dom";
import { gatewayFetch, gatewaySSE } from "../api/gateway";

// W3 — pipeline matrix view.
//
// One row per company × seven columns (one per pipeline stage). Cells render
// as colored dots and the row is clickable to open a drill-down panel on the
// right with per-stage timeline + errors. Live SSE deltas are patched into
// the cached matrix in-place; we deliberately do NOT re-sort on each event so
// the user's scroll position stays stable while a transaction streams.
//
// Sources:
//   - GET /v1/transactions/:id/pipeline      → snapshot (companyId × stage matrix)
//   - GET /v1/transactions/:id/events (SSE)  → live deltas (one frame per cell)
//   - GET /v1/transactions/:id/errors        → drill-down: errors per company
//   - GET /v1/transactions/:id               → header summary

type StageId =
  | "masterData"
  | "structuredContent"
  | "companyPublication"
  | "website"
  | "companyProfile"
  | "companyContact"
  | "companyEvaluation";

type CellState = "completed" | "failed" | "skipped" | "pending" | "in_progress";

interface PipelineCell {
  state: CellState;
  updatedAt?: string | null;
  errorCount: number;
}

interface PipelineRow {
  companyId: string;
  cells: Record<StageId, PipelineCell>;
  lastActivityAt?: string | null;
}

interface Pipeline {
  transactionId: string;
  totalCompanies: number;
  stages: StageId[];
  unavailableStages: StageId[];
  rows: PipelineRow[];
}

interface Transaction {
  id: string;
  startTime?: string | null;
  companyCount?: number | null;
  createdAt: string;
  name?: string | null;
}

interface ProcessingError {
  companyId: string;
  service?: string;
  errorReason?: string;
  message?: string;
  occurredAt?: string | null;
  createdAt?: string | null;
}

const STAGE_LABEL: Record<StageId, string> = {
  masterData: "Master",
  structuredContent: "Structured",
  companyPublication: "Publication",
  website: "Website",
  companyProfile: "Profile",
  companyContact: "Contact",
  companyEvaluation: "Evaluation",
};

// Map upstream `service` field on AMQP progress events → matrix stage id.
// AMQP `service` values come from each producer's `SERVICE_NAME` constant.
const SERVICE_TO_STAGE: Record<string, StageId> = {
  "master-data": "masterData",
  "structured-content": "structuredContent",
  "company-publication": "companyPublication",
  website: "website",
  "company-profile": "companyProfile",
  "company-contact": "companyContact",
  "company-evaluation": "companyEvaluation",
};

export function TransactionDetail() {
  const { id } = useParams<{ id: string }>();
  const queryClient = useQueryClient();
  const [openCompanyId, setOpenCompanyId] = useState<string | null>(null);

  const detail = useQuery({
    queryKey: ["transaction", id],
    queryFn: () => gatewayFetch<Transaction>(`/v1/transactions/${id}`),
    enabled: !!id,
  });

  const pipeline = useQuery({
    queryKey: ["transaction", id, "pipeline"],
    queryFn: () => gatewayFetch<Pipeline>(`/v1/transactions/${id}/pipeline`),
    enabled: !!id,
  });

  const errors = useQuery({
    queryKey: ["transaction", id, "errors"],
    queryFn: () =>
      gatewayFetch<{ items: ProcessingError[] }>(`/v1/transactions/${id}/errors`),
    enabled: !!id,
  });

  // Live SSE binding — patch matching cells in-place.
  // We don't re-sort on each event: user-driven scroll position should stay
  // stable while events stream in. lastActivityAt is still updated, so any
  // explicit re-fetch (or the next mount) will re-sort naturally.
  useEffect(() => {
    if (!id) return;
    let stop: (() => void) | null = null;
    let cancelled = false;
    void gatewaySSE(
      `/v1/transactions/${id}/events`,
      (ev) => {
        if (ev.type !== "progress" || !ev.data || typeof ev.data !== "object") return;
        const payload = ev.data as {
          service?: string;
          companyId?: string;
          state?: CellState;
          updatedAt?: string;
          errorMessage?: string;
        };
        const stage = SERVICE_TO_STAGE[payload.service ?? ""];
        if (!stage || !payload.companyId || !payload.state) return;
        const evCompanyId: string = payload.companyId;
        const evState: CellState = payload.state;

        queryClient.setQueryData<Pipeline | undefined>(
          ["transaction", id, "pipeline"],
          (prev) => {
            if (!prev) return prev;
            const idx = prev.rows.findIndex((r) => r.companyId === evCompanyId);
            if (idx === -1) {
              // New companyId arriving via SSE before snapshot caught it;
              // append a fresh row with this single cell populated. Matches
              // the matrix's "any company in any stage" union semantics.
              const blank: PipelineCell = { state: "pending", errorCount: 0 };
              const cells: Record<StageId, PipelineCell> = {
                masterData: { state: "completed", errorCount: 0 },
                structuredContent: blank,
                companyPublication: blank,
                website: blank,
                companyProfile: blank,
                companyContact: blank,
                companyEvaluation: blank,
              };
              cells[stage] = {
                state: evState,
                updatedAt: payload.updatedAt ?? new Date().toISOString(),
                errorCount: evState === "failed" ? 1 : 0,
              };
              return {
                ...prev,
                totalCompanies: prev.totalCompanies + 1,
                rows: [
                  ...prev.rows,
                  {
                    companyId: evCompanyId,
                    cells,
                    lastActivityAt: payload.updatedAt ?? new Date().toISOString(),
                  },
                ],
              };
            }
            const row = prev.rows[idx]!;
            const newCell: PipelineCell = {
              state: evState,
              updatedAt: payload.updatedAt ?? new Date().toISOString(),
              errorCount: evState === "failed" ? 1 : 0,
            };
            const newRow: PipelineRow = {
              ...row,
              cells: { ...row.cells, [stage]: newCell },
              lastActivityAt: newCell.updatedAt ?? row.lastActivityAt,
            };
            const rows = prev.rows.slice();
            rows[idx] = newRow;
            return { ...prev, rows };
          },
        );

        // Failed cell → bump the errors query so the drill-down panel refreshes.
        if (payload.state === "failed") {
          void queryClient.invalidateQueries({ queryKey: ["transaction", id, "errors"] });
        }
      },
      () => {
        // Soft-fail: matrix stays usable from the snapshot. We could surface a
        // "live updates paused" banner here in a follow-up.
      },
    ).then((teardown) => {
      if (cancelled) teardown();
      else stop = teardown;
    });
    return () => {
      cancelled = true;
      stop?.();
    };
  }, [id, queryClient]);

  const stages: StageId[] = pipeline.data?.stages ?? [
    "masterData",
    "structuredContent",
    "companyPublication",
    "website",
    "companyProfile",
    "companyContact",
    "companyEvaluation",
  ];

  const openRow = useMemo(
    () => pipeline.data?.rows.find((r) => r.companyId === openCompanyId) ?? null,
    [pipeline.data, openCompanyId],
  );

  const openErrors = useMemo(() => {
    if (!openCompanyId || !errors.data) return [];
    return errors.data.items.filter((e) => e.companyId === openCompanyId);
  }, [errors.data, openCompanyId]);

  return (
    <section className={openCompanyId ? "tx-detail tx-detail--with-panel" : "tx-detail"}>
      <div className="tx-detail__main">
        <h2>
          Transaction <code>{id?.slice(0, 8)}…</code>{" "}
          <Link to={`/transactions/${id}/stream`} className="muted">
            (raw event log)
          </Link>{" "}
          <Link to={`/transactions/${id}/evaluations`} className="muted">
            (evaluations)
          </Link>
        </h2>

        {detail.isLoading && <p>Loading…</p>}
        {detail.error && <p className="error">{(detail.error as Error).message}</p>}
        {detail.data && (
          <dl className="tx-summary">
            <div>
              <dt>Name</dt>
              <dd>{detail.data.name ?? <span className="muted">—</span>}</dd>
            </div>
            <div>
              <dt>Started</dt>
              <dd>{detail.data.startTime ?? detail.data.createdAt}</dd>
            </div>
            <div>
              <dt>Companies</dt>
              <dd>{detail.data.companyCount ?? "—"}</dd>
            </div>
          </dl>
        )}

        {pipeline.isLoading && <p>Loading pipeline…</p>}
        {pipeline.error && (
          <p className="error">Pipeline: {(pipeline.error as Error).message}</p>
        )}

        {pipeline.data && pipeline.data.rows.length === 0 && (
          <p className="muted">No companies have started yet.</p>
        )}

        {pipeline.data && pipeline.data.rows.length > 0 && (
          <>
            {pipeline.data.unavailableStages.length > 0 && (
              <p className="warn">
                Unavailable stages (cells shown as pending):{" "}
                {pipeline.data.unavailableStages.map((s) => STAGE_LABEL[s]).join(", ")}
              </p>
            )}
            <table className="matrix">
              <thead>
                <tr>
                  <th>Company</th>
                  {stages.map((s) => (
                    <th key={s} className={pipeline.data!.unavailableStages.includes(s) ? "muted" : ""}>
                      {STAGE_LABEL[s]}
                    </th>
                  ))}
                  <th>Last activity</th>
                </tr>
              </thead>
              <tbody>
                {pipeline.data.rows.map((row) => (
                  <tr
                    key={row.companyId}
                    className={openCompanyId === row.companyId ? "active" : ""}
                    onClick={() => setOpenCompanyId(row.companyId)}
                  >
                    <td>
                      <code>{row.companyId.slice(0, 12)}…</code>
                    </td>
                    {stages.map((s) => (
                      <td key={s} className="matrix-cell">
                        <CellDot cell={row.cells[s]} />
                      </td>
                    ))}
                    <td className="muted">
                      {row.lastActivityAt ? formatTime(row.lastActivityAt) : "—"}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </>
        )}
      </div>

      {openCompanyId && openRow && (
        <aside className="drill-panel">
          <header>
            <h3>
              <code>{openCompanyId.slice(0, 16)}…</code>
            </h3>
            <button
              type="button"
              className="link"
              onClick={() => setOpenCompanyId(null)}
              aria-label="Close drill-down"
            >
              ×
            </button>
          </header>
          <p>
            <Link to={`/companies/${openCompanyId}`}>Open company detail →</Link>
          </p>

          <h4>Pipeline timeline</h4>
          <ol className="timeline">
            {stages.map((s) => {
              const cell = openRow.cells[s];
              return (
                <li key={s} className={`timeline__item state-${cell.state}`}>
                  <span className="timeline__stage">{STAGE_LABEL[s]}</span>
                  <span className="badge">{cell.state}</span>
                  <span className="muted timeline__time">
                    {cell.updatedAt ? formatTime(cell.updatedAt) : "—"}
                  </span>
                </li>
              );
            })}
          </ol>

          <h4>Errors ({openErrors.length})</h4>
          {errors.isLoading && <p className="muted">Loading errors…</p>}
          {openErrors.length === 0 && !errors.isLoading && (
            <p className="muted">No errors. ✓</p>
          )}
          {openErrors.length > 0 && (
            <ul className="event-log">
              {openErrors.map((e, i) => (
                <li key={i}>
                  <strong>{e.service ?? "—"}</strong>{" "}
                  <span className="muted">{e.occurredAt ?? e.createdAt ?? ""}</span>
                  <pre>{e.errorReason ?? e.message ?? "(no reason)"}</pre>
                </li>
              ))}
            </ul>
          )}

          <h4>Retry</h4>
          <RetryStagePicker
            transactionId={id!}
            companyId={openCompanyId}
            row={openRow}
            onDispatched={() => {
              // Refetch errors so the panel reflects the new run; the SSE
              // bridge will update the matrix as the producer publishes
              // progress.
              queryClient.invalidateQueries({
                queryKey: ["transaction", id, "errors"],
              });
            }}
          />
        </aside>
      )}
    </section>
  );
}

// Retry stages the gateway accepts (everything except masterData — there is
// no upstream of master-data to republish from). Default selection is the
// first failed stage in the row, so a user clicking a row with a red dot
// can hit "Retry" without picking from the list.
const RETRY_STAGES: Array<{ id: StageId; label: string }> = [
  { id: "structuredContent", label: "Structured Content" },
  { id: "companyPublication", label: "Company Publication" },
  { id: "website", label: "Website" },
  { id: "companyProfile", label: "Company Profile" },
  { id: "companyContact", label: "Company Contact" },
  { id: "companyEvaluation", label: "Company Evaluation" },
];

interface RetryDispatch {
  upstream: string;
  stage: string;
  ok: boolean;
  status?: number;
  error?: string;
}

interface RetryResult {
  transactionId: string;
  companyId: string;
  stage: string;
  dispatched: RetryDispatch[];
  ok: boolean;
}

function RetryStagePicker({
  transactionId,
  companyId,
  row,
  onDispatched,
}: {
  transactionId: string;
  companyId: string;
  row: PipelineRow;
  onDispatched: () => void;
}) {
  const firstFailed = useMemo<StageId>(() => {
    const failed = RETRY_STAGES.find(
      (s) => row.cells[s.id]?.state === "failed",
    );
    return failed?.id ?? "structuredContent";
  }, [row]);

  const [stage, setStage] = useState<StageId>(firstFailed);
  const [companyName, setCompanyName] = useState<string>("");
  const [busy, setBusy] = useState(false);
  const [result, setResult] = useState<RetryResult | null>(null);
  const [err, setErr] = useState<string | null>(null);

  // Re-default the stage selection when the user switches to a different row.
  useEffect(() => {
    setStage(firstFailed);
    setResult(null);
    setErr(null);
  }, [firstFailed, companyId]);

  const onClick = async () => {
    setBusy(true);
    setErr(null);
    setResult(null);
    try {
      const body: { stage: StageId; companyName?: string } = { stage };
      if (stage === "companyContact" && companyName.trim()) {
        body.companyName = companyName.trim();
      }
      const res = await gatewayFetch<RetryResult>(
        `/v1/transactions/${transactionId}/entities/${companyId}/retry`,
        { method: "POST", body },
      );
      setResult(res);
      onDispatched();
    } catch (e) {
      setErr(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="retry-form">
      <label className="retry-form__row">
        <span>Stage</span>
        <select
          value={stage}
          onChange={(e) => setStage(e.target.value as StageId)}
          disabled={busy}
        >
          {RETRY_STAGES.map((s) => (
            <option key={s.id} value={s.id}>
              {s.label}
              {row.cells[s.id]?.state === "failed" ? " (failed)" : ""}
            </option>
          ))}
        </select>
      </label>
      {stage === "companyContact" && (
        <label className="retry-form__row">
          <span>Company name</span>
          <input
            type="text"
            placeholder="Required for companyContact"
            value={companyName}
            onChange={(e) => setCompanyName(e.target.value)}
            disabled={busy}
          />
        </label>
      )}
      <button type="button" onClick={onClick} disabled={busy}>
        {busy ? "Dispatching…" : "Retry stage"}
      </button>
      {err && <p className="bad">Error: {err}</p>}
      {result && (
        <div className={`retry-result ${result.ok ? "ok" : "warn"}`}>
          <p>
            <strong>{result.ok ? "✓ Dispatched" : "⚠ Partial dispatch"}</strong>{" "}
            <span className="muted">
              ({result.dispatched.filter((d) => d.ok).length}/
              {result.dispatched.length})
            </span>
          </p>
          <ul>
            {result.dispatched.map((d, i) => (
              <li key={i} className={d.ok ? "ok" : "bad"}>
                <code>{d.upstream}</code> → {d.stage} ·{" "}
                {d.ok ? "ok" : `failed: ${d.error ?? "unknown"}`}
              </li>
            ))}
          </ul>
        </div>
      )}
    </div>
  );
}

function CellDot({ cell }: { cell: PipelineCell }) {
  const cls = stateClass(cell.state);
  const title = `${cell.state}${cell.updatedAt ? ` · ${formatTime(cell.updatedAt)}` : ""}${
    cell.errorCount ? ` · ${cell.errorCount} error(s)` : ""
  }`;
  return <span className={`dot ${cls}`} title={title} aria-label={title} />;
}

function stateClass(state: CellState): string {
  switch (state) {
    case "completed":
      return "ok";
    case "failed":
      return "bad";
    case "in_progress":
      return "warn";
    case "skipped":
      return "muted";
    case "pending":
    default:
      return "pending";
  }
}

function formatTime(iso: string): string {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return iso;
  // Compact local time — drilldown panel has full ISO via tooltip elsewhere.
  return d.toLocaleString();
}

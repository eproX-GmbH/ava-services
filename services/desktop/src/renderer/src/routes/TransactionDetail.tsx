import { useEffect, useMemo, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Link, useNavigate, useParams } from "react-router-dom";
import { useAuthStore } from "../store/auth";
import { gatewayFetch, gatewaySSE } from "../api/gateway";
import { fmtDate } from "../lib/format";
import { DiagnosticsPanel } from "../components/DiagnosticsPanel";
import { CrmBadgeRow } from "../components/CrmBadge";
import { RetryStageForm, RETRY_STAGES } from "../components/RetryStageForm";

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
  // v0.1.118 — heartbeat-driven auto-retry counters. Undefined on
  // derived cells (masterData, companyEvaluation) and on pre-v0.1.118
  // rows; treat as "no retry state" in that case.
  attempts?: number;
  nextRetryAt?: string | null;
  giveUpAt?: string | null;
  /** v0.1.459 — Fehlertext der EntityProgress-Zeile; erlaubt die
   *  orange Timeout-Markierung (gleiches Muster wie AllCompanies). */
  errorMessage?: string | null;
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
  userId?: string;
  /** O8 — mit der Organisation geteilt. */
  shared?: { shareId: string; by: string; byName?: string | null; at: string; note?: string | null; own: boolean };
}

interface ProcessingError {
  companyId: string;
  service?: string;
  errorReason?: string;
  message?: string;
  occurredAt?: string | null;
  createdAt?: string | null;
}

// Pipeline-stage labels stay close to the gateway's API vocabulary
// (Master, Structured, …) so screenshots and the Settings/advanced
// view match. We translate the few that read awkwardly in German UI:
// "Profile" → "Profil", "Contact" → "Kontakt", "Evaluation" → "Bewertung".
const STAGE_LABEL: Record<StageId, string> = {
  masterData: "Stamm",
  structuredContent: "Struktur",
  companyPublication: "Publikation",
  website: "Website",
  companyProfile: "Profil",
  companyContact: "Kontakt",
  companyEvaluation: "Bewertung",
};

const CELL_STATE_LABEL: Record<CellState, string> = {
  completed: "fertig",
  failed: "fehlgeschlagen",
  skipped: "übersprungen",
  pending: "wartet",
  in_progress: "läuft",
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

// Inverse mapping — drives the diagnostics panel which addresses
// producers by their service name (matches the on-disk producer dir
// name and the supervisor's ProducerStatus.name). master-data isn't
// a local producer (cloud-only), so it's intentionally absent.
const STAGE_TO_PRODUCER: Partial<Record<StageId, string>> = {
  structuredContent: "structured-content",
  companyPublication: "company-publication",
  website: "website",
  companyProfile: "company-profile",
  companyContact: "company-contact",
  companyEvaluation: "company-evaluation",
};

export function TransactionDetail() {
  const { id } = useParams<{ id: string }>();
  const queryClient = useQueryClient();
  const [openCompanyId, setOpenCompanyId] = useState<string | null>(null);

  // The detail/pipeline/errors queries opt into `refetchOnMount: "always"`
  // (and a 0-ms stale window) so revisiting the page after a navigation
  // round-trip kicks off a fresh server fetch, even if the global
  // 30-second staleTime hasn't elapsed. The cached payload still paints
  // immediately to keep the matrix from flashing, and the live
  // /transactions/:id/events SSE bridge below patches new deltas into
  // the cache as they arrive — but the boundary fetch is what catches
  // up state that changed while the user was on a different route.
  const detail = useQuery({
    queryKey: ["transaction", id],
    queryFn: () => gatewayFetch<Transaction>(`/v1/transactions/${id}`),
    enabled: !!id,
    staleTime: 0,
    refetchOnMount: "always",
  });

  const pipeline = useQuery({
    queryKey: ["transaction", id, "pipeline"],
    queryFn: () => gatewayFetch<Pipeline>(`/v1/transactions/${id}/pipeline`),
    enabled: !!id,
    staleTime: 0,
    refetchOnMount: "always",
  });

  const errors = useQuery({
    queryKey: ["transaction", id, "errors"],
    queryFn: () =>
      gatewayFetch<{ items: ProcessingError[] }>(`/v1/transactions/${id}/errors`),
    enabled: !!id,
    staleTime: 0,
    refetchOnMount: "always",
  });

  // The gateway's `/transactions/:id/pipeline` endpoint omits company
  // names (it's already a heavy fan-out); resolve them client-side via
  // a single batched query keyed on the row set so React Query
  // dedupes across re-renders. We only paint names — the matrix and
  // SSE deltas continue to address rows by `companyId` internally.
  const companyIds = useMemo(() => {
    const ids = (pipeline.data?.rows ?? []).map((r) => r.companyId);
    ids.sort();
    return ids;
  }, [pipeline.data]);
  const companyNames = useQuery({
    queryKey: ["companyNames", companyIds],
    queryFn: async () => {
      const map = new Map<string, string>();
      await Promise.all(
        companyIds.map(async (cid) => {
          try {
            const data = await gatewayFetch<{
              name?: string | null;
              companyName?: string | null;
            }>(`/v1/companies/${encodeURIComponent(cid)}`);
            const n = data.name ?? data.companyName;
            if (n && n.trim().length > 0) map.set(cid, n.trim());
          } catch {
            // Leave the entry missing; nameFor falls back to the id.
          }
        }),
      );
      return map;
    },
    enabled: companyIds.length > 0,
    // Names are slow-changing master-data; 5 min keeps the cache warm
    // while the user clicks through the matrix without forcing fresh
    // round-trips on every focus.
    // (CRM-link badge fan-out below uses the same id set.)
    staleTime: 5 * 60_000,
  });

  // Workstream C4 — CRM badges next to each company name. One POST
  // resolves every visible row's CompanyCrmLink summary; tenants
  // who never imported from a CRM see no badges (empty response).
  const crmLinks = useQuery({
    queryKey: ["crm-links-batch", companyIds],
    enabled: companyIds.length > 0,
    queryFn: () =>
      gatewayFetch<{
        links: Record<
          string,
          Array<{ crmType: "HUBSPOT" | "SALESFORCE" | "DYNAMICS"; crmDisplayName: string | null }>
        >;
      }>(`/v1/companies/crm-links/batch`, {
        method: "POST",
        body: { companyIds },
      }),
    staleTime: 60_000,
  });

  const nameFor = (cid: string): string =>
    companyNames.data?.get(cid) ?? `${cid.slice(0, 12)}…`;

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
                errorMessage: payload.errorMessage ?? null,
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
              errorMessage: payload.errorMessage ?? null,
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
        <header className="ct-page-header">
          <p className="ct-page-header__eyebrow">Vorgang</p>
          <h2 className="ct-page-header__title">
            <span className="ct-gradient-text">{detail.data?.name ?? "Vorgang"}</span>
          </h2>
          <p className="ct-page-header__lede">
            <Link to={`/transactions/${id}/stream`}>Roh-Eventprotokoll</Link>
            {" · "}
            <Link to={`/transactions/${id}/evaluations`}>Bewertungen</Link>
          </p>
        </header>

        {detail.isLoading && <p>Lädt…</p>}
        {detail.error && <p className="error">{(detail.error as Error).message}</p>}
        {detail.data && (
          <dl className="tx-summary">
            <div>
              <dt>Gestartet</dt>
              <dd>{fmtDate(detail.data.startTime ?? detail.data.createdAt)}</dd>
            </div>
            <div>
              <dt>Firmen</dt>
              <dd>{detail.data.companyCount ?? ""}</dd>
            </div>
            {detail.data.shared && (
              <div>
                <dt>Organisation</dt>
                <dd>
                  {detail.data.shared.own
                    ? `von dir geteilt am ${fmtDate(detail.data.shared.at)}`
                    : `geteilt von ${detail.data.shared.byName ?? `${detail.data.shared.by.slice(0, 8)}…`} am ${fmtDate(detail.data.shared.at)}`}
                </dd>
              </div>
            )}
          </dl>
        )}
        {detail.data && <OrgAktionen tx={detail.data} />}

        {pipeline.isLoading && <p>Pipeline wird geladen…</p>}
        {pipeline.error && (
          <p className="error">Pipeline: {(pipeline.error as Error).message}</p>
        )}

        {pipeline.data && pipeline.data.rows.length === 0 && (
          <p className="muted">Noch keine Firmen gestartet.</p>
        )}

        {pipeline.data && pipeline.data.rows.length > 0 && (
          <>
            {pipeline.data.unavailableStages.length > 0 && (
              <p className="warn">
                Nicht verfügbare Schritte (als „wartet" angezeigt):{" "}
                {pipeline.data.unavailableStages.map((s) => STAGE_LABEL[s]).join(", ")}
              </p>
            )}
            <table className="matrix">
              <thead>
                <tr>
                  <th>Firma</th>
                  {stages.map((s) => (
                    <th key={s} className={pipeline.data!.unavailableStages.includes(s) ? "muted" : ""}>
                      {STAGE_LABEL[s]}
                    </th>
                  ))}
                  <th>Letzte Aktivität</th>
                </tr>
              </thead>
              <tbody>
                {pipeline.data.rows.map((row) => (
                  <tr
                    key={row.companyId}
                    className={openCompanyId === row.companyId ? "active" : ""}
                    onClick={() => setOpenCompanyId(row.companyId)}
                  >
                    <td className="matrix-company">
                      {nameFor(row.companyId)}
                      <CrmBadgeRow
                        links={crmLinks.data?.links[row.companyId] ?? []}
                      />
                    </td>
                    {stages.map((s) => (
                      <td key={s} className="matrix-cell">
                        <CellDot cell={row.cells[s]} />
                      </td>
                    ))}
                    <td className="muted">
                      {row.lastActivityAt ? formatTime(row.lastActivityAt) : ""}
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
            <h3>{nameFor(openCompanyId)}</h3>
            <button
              type="button"
              className="link"
              onClick={() => setOpenCompanyId(null)}
              aria-label="Detail schließen"
            >
              ×
            </button>
          </header>
          <p>
            <Link to={`/companies/${openCompanyId}`}>Firmendetails öffnen →</Link>
          </p>

          <h4>Pipeline-Verlauf</h4>
          <ol className="timeline">
            {stages.map((s) => {
              const cell = openRow.cells[s];
              return (
                <li key={s} className={`timeline__item state-${cell.state}`}>
                  <span className="timeline__stage">{STAGE_LABEL[s]}</span>
                  <span className="badge">{CELL_STATE_LABEL[cell.state]}</span>
                  <span className="muted timeline__time">
                    {cell.updatedAt ? formatTime(cell.updatedAt) : ""}
                  </span>
                </li>
              );
            })}
          </ol>

          <h4>Fehler ({openErrors.length})</h4>
          {errors.isLoading && <p className="muted">Fehler werden geladen…</p>}
          {openErrors.length === 0 && !errors.isLoading && (
            <p className="muted">Keine Fehler. ✓</p>
          )}
          {openErrors.length > 0 && (
            <ul className="event-log">
              {openErrors.map((e, i) => (
                <li key={i}>
                  <strong>{stageLabelForService(e.service)}</strong>{" "}
                  <span className="muted">
                    {fmtErrorTime(e.occurredAt ?? e.createdAt)}
                  </span>
                  <pre>{e.errorReason ?? e.message ?? "(kein Grund angegeben)"}</pre>
                </li>
              ))}
            </ul>
          )}

          <h4>Erneut versuchen</h4>
          <RetryStageForm
            transactionId={id!}
            companyId={openCompanyId}
            defaultCompanyName={companyNames.data?.get(openCompanyId) ?? null}
            failedStages={RETRY_STAGES.map((s) => s.id).filter(
              (sid) => openRow.cells[sid]?.state === "failed",
            )}
            onDispatched={() => {
              // Refetch errors so the panel reflects the new run; the SSE
              // bridge will update the matrix as the producer publishes
              // progress.
              queryClient.invalidateQueries({
                queryKey: ["transaction", id, "errors"],
              });
            }}
          />

          {/* v0.1.50 — live producer logs + Selenium screenshots scoped
              to this company. The dropdown ALWAYS lists every local
              producer (not filtered by `stages` from the pipeline
              endpoint) so we never accidentally hide one a user wants
              to inspect. Picks the most "interesting" producer by
              default (failed > in_progress > structured-content first)
              so a user clicking a red cell drops straight into the
              relevant log. */}
          {(() => {
            const allProducers = [
              "structured-content",
              "company-publication",
              "website",
              "company-profile",
              "company-contact",
              "company-evaluation",
            ];
            const interesting = (() => {
              for (const s of stages) {
                if (openRow.cells[s].state === "failed") {
                  const p = STAGE_TO_PRODUCER[s];
                  if (p) return p;
                }
              }
              for (const s of stages) {
                if (openRow.cells[s].state === "in_progress") {
                  const p = STAGE_TO_PRODUCER[s];
                  if (p) return p;
                }
              }
              return allProducers[0];
            })();
            return (
              <>
                <h4>Diagnose</h4>
                <DiagnosticsPanel
                  runId={`${id}:${openCompanyId}`}
                  producers={allProducers}
                  initialProducer={interesting}
                />
              </>
            );
          })()}
        </aside>
      )}
    </section>
  );
}

// Retry stages the gateway accepts (everything except masterData — there is
// no upstream of master-data to republish from). Default selection is the
// first failed stage in the row, so a user clicking a row with a red dot
// can hit "Retry" without picking from the list.
function CellDot({ cell }: { cell: PipelineCell }) {
  // v0.1.459 — Reaper-Timeouts ("kein Lebenszeichen" nach 30 Min) orange
  // statt rot markieren, wie in der AllCompanies-Matrix: gleicher
  // DB-Zustand (failed), aber Infrastruktur-Engpass statt Datenfehler.
  const isTimeout =
    cell.state === "failed" &&
    (cell.errorMessage ?? "").startsWith("Zeitüberschreitung");
  const cls = isTimeout ? "timeout" : stateClass(cell.state);
  // v0.1.118 — derive a retry-status label for failed cells. The
  // heartbeat-driven orchestrator (Settings → Meldungen) walks rows
  // whose nextRetryAt has matured every ~10 min; we surface where
  // that row sits in the cycle so the user knows whether to wait or
  // intervene manually.
  let retryLabel = "";
  let badge: string | null = null;
  if (cell.state === "failed") {
    if (cell.giveUpAt) {
      retryLabel =
        "Aufgegeben nach 5 Versuchen (manueller Retry möglich)";
    } else if (cell.nextRetryAt) {
      const nextAt = new Date(cell.nextRetryAt).getTime();
      const now = Date.now();
      if (nextAt <= now) {
        retryLabel = "Erneuter Versuch fällig";
      } else {
        retryLabel = `Wartet auf erneuten Versuch in ${formatRetryDelta(
          nextAt - now,
        )}`;
      }
    } else {
      retryLabel = "Fehlgeschlagen";
    }
    // Small attempt-count badge — only after the second failure so the
    // matrix isn't noisy on first-time hiccups.
    if (typeof cell.attempts === "number" && cell.attempts >= 2) {
      badge = `${cell.attempts}×`;
    }
  }
  const title = [
    isTimeout
      ? "Zeitüberschreitung (abgebrochen — kein Datenfehler)"
      : CELL_STATE_LABEL[cell.state],
    cell.updatedAt ? formatTime(cell.updatedAt) : null,
    cell.errorCount ? `${cell.errorCount} Fehler` : null,
    retryLabel || null,
  ]
    .filter(Boolean)
    .join(" · ");
  return (
    <span className="cell-dot" title={title} aria-label={title}>
      <span className={`dot ${cls}`} />
      {badge && <span className="cell-dot__badge">{badge}</span>}
    </span>
  );
}

/** Compact German label for a time-delta (ms). Used in the cell
 *  tooltip ("in 8 Min", "in 2 Std"). Falls back to a coarse unit so
 *  the tooltip stays a single line. */
function formatRetryDelta(ms: number): string {
  if (ms <= 0) return "Kürze";
  const mins = Math.round(ms / 60_000);
  if (mins < 60) return `${mins} Min`;
  const hours = Math.round(mins / 60);
  if (hours < 24) return `${hours} Std`;
  const days = Math.round(hours / 24);
  return `${days} Tag${days === 1 ? "" : "en"}`;
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
  // Compact German local time — drilldown panel has full ISO via tooltip elsewhere.
  return d.toLocaleString("de-DE");
}

// Map an upstream `service` field (as stamped by the gateway's errors fan-out)
// onto the matrix-stage label. The gateway tags each error row with its stage
// id (e.g. "companyProfile", "structuredContent"); fall back to the raw value
// for forward-compat, or "" if the upstream didn't set it.
function stageLabelForService(service?: string): string {
  if (!service) return "";
  const known = STAGE_LABEL[service as StageId];
  return known ?? service;
}

function fmtErrorTime(input?: string | null): string {
  if (!input) return "";
  return formatTime(input);
}


// O8 — Teilen (Eigentuemer) / Freigabe zuruecknehmen / Uebernehmen (Mitglied).
function OrgAktionen({ tx }: { tx: Transaction }) {
  const qc = useQueryClient();
  const navigate = useNavigate();
  const actorId = useAuthStore((s) => s.actorId);
  const istEigentuemer = !tx.userId || tx.userId === actorId;
  const geteilt = tx.shared ?? null;
  const [meldung, setMeldung] = useState<string | null>(null);

  const teilen = useMutation({
    mutationFn: () => gatewayFetch("/v1/tenants/me/shares", { method: "POST", body: { kind: "transaction", refId: tx.id } }),
    onSuccess: () => {
      setMeldung("Mit der Organisation geteilt. Mitglieder sehen den Vorgang unter 'Aus der Organisation'.");
      void qc.invalidateQueries({ queryKey: ["transaction", tx.id] });
      void qc.invalidateQueries({ queryKey: ["transactions"] });
    },
    onError: (e) => setMeldung((e as Error).message),
  });
  const zurueck = useMutation({
    mutationFn: () => gatewayFetch(`/v1/tenants/me/shares/${encodeURIComponent(geteilt!.shareId)}`, { method: "DELETE" }),
    onSuccess: () => {
      setMeldung("Freigabe zurückgenommen. Bereits übernommene Kopien bleiben bei den Kolleginnen und Kollegen.");
      void qc.invalidateQueries({ queryKey: ["transaction", tx.id] });
      void qc.invalidateQueries({ queryKey: ["transactions"] });
    },
    onError: (e) => setMeldung((e as Error).message),
  });
  const uebernehmen = useMutation({
    mutationFn: () =>
      gatewayFetch<{ transactionId: string; copiedProgress: number }>(`/v1/transactions/${encodeURIComponent(tx.id)}/adopt`, { method: "POST", body: {} }),
    onSuccess: (r) => {
      void qc.invalidateQueries({ queryKey: ["transactions"] });
      void qc.invalidateQueries({ queryKey: ["companies"] });
      navigate(`/transactions/${r.transactionId}`);
    },
    onError: (e) => setMeldung((e as Error).message),
  });

  const busy = teilen.isPending || zurueck.isPending || uebernehmen.isPending;
  return (
    <div className="org-actions" style={{ marginBottom: "1rem" }}>
      {istEigentuemer && !geteilt && (
        <button type="button" className="btn" disabled={busy} onClick={() => teilen.mutate()} title="Mitglieder deiner Organisation können den Vorgang ansehen und übernehmen">
          Mit Organisation teilen
        </button>
      )}
      {istEigentuemer && geteilt && (
        <button type="button" className="btn" disabled={busy} onClick={() => zurueck.mutate()}>
          Freigabe zurücknehmen
        </button>
      )}
      {!istEigentuemer && (
        <button type="button" className="primary" disabled={busy} onClick={() => uebernehmen.mutate()} title="Eigene Kopie mit kopiertem Verarbeitungsfortschritt; die Firmen erscheinen in 'Meine Firmen'">
          {uebernehmen.isPending ? "Übernimmt…" : "Firmen aus diesem Vorgang übernehmen"}
        </button>
      )}
      {meldung && <span className="muted small">{meldung}</span>}
    </div>
  );
}

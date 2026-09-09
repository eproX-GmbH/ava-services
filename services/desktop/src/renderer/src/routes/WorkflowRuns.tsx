// v0.1.612 — Historie aller Workflow-Laeufe (wie die Executions-Liste in n8n):
// Filter nach Status, Workflow und Zeitraum; Klick oeffnet den Lauf im Editor
// mit Ein-/Ausgaben je Schritt.

import { useCallback, useEffect, useMemo, useState } from "react";
import { Link, useNavigate } from "react-router-dom";
import type { WorkflowExecution, WorkflowListEntry, WorkflowProgressFrame } from "../../../shared/workflow-types";
import { statusPill, triggerText } from "./Workflows";

export function dauerText(ex: WorkflowExecution): string {
  const ende = ex.finishedAt ? Date.parse(ex.finishedAt) : Date.now();
  const ms = Math.max(0, ende - Date.parse(ex.startedAt));
  if (ms < 1000) return "<1 s";
  if (ms < 60_000) return `${Math.round(ms / 1000)} s`;
  if (ms < 3_600_000) return `${Math.round(ms / 60_000)} min`;
  if (ms < 86_400_000) return `${(ms / 3_600_000).toFixed(1)} h`;
  return `${(ms / 86_400_000).toFixed(1)} Tage`;
}

export function firmaText(ex: WorkflowExecution): string {
  return ex.scope?.companyName ?? ex.scope?.companyId ?? ex.scope?.discoveryId ?? "–";
}

export function WorkflowRuns(): JSX.Element {
  const navigate = useNavigate();
  const [rows, setRows] = useState<WorkflowExecution[]>([]);
  const [workflows, setWorkflows] = useState<WorkflowListEntry[]>([]);
  const [status, setStatus] = useState<string>("");
  const [workflowId, setWorkflowId] = useState<string>("");
  const [tage, setTage] = useState<number>(7);
  const [laden, setLaden] = useState(false);

  const reload = useCallback(async () => {
    setLaden(true);
    try {
      const [ex, wl] = await Promise.all([
        window.api.workflows.executionsAll({ ...(status ? { status } : {}), ...(workflowId ? { workflowId } : {}), ...(tage > 0 ? { sinceDays: tage } : {}), limit: 300 }),
        window.api.workflows.list(),
      ]);
      setRows(ex);
      setWorkflows(wl);
    } finally {
      setLaden(false);
    }
  }, [status, workflowId, tage]);

  useEffect(() => {
    void reload();
  }, [reload]);
  useEffect(
    () =>
      window.api.workflows.onProgress((f: WorkflowProgressFrame) => {
        if (f.kind === "execution-started" || f.kind === "execution-finished") void reload();
      }),
    [reload],
  );

  const zaehler = useMemo(() => {
    const z = { success: 0, error: 0, running: 0, waiting: 0, cancelled: 0 } as Record<string, number>;
    for (const r of rows) z[r.status] = (z[r.status] ?? 0) + 1;
    return z;
  }, [rows]);

  return (
    <div className="radar-page wf-page">
      <div className="radar-head">
        <div>
          <h1>Workflow-Läufe</h1>
          <p className="radar-sub">
            Historie aller Läufe. Klick auf einen Lauf öffnet ihn im Editor mit Eingaben und Ausgaben je Schritt.
            {rows.length > 0 && (
              <>
                {" "}
                {rows.length} Läufe · {zaehler.success ?? 0} erfolgreich · {zaehler.error ?? 0} Fehler · {(zaehler.running ?? 0) + (zaehler.waiting ?? 0)} aktiv
              </>
            )}
          </p>
        </div>
        <div className="radar-actions">
          <Link to="/workflows" className="proc-toggle">
            ← Workflows
          </Link>
          <button type="button" className="proc-toggle" onClick={() => void reload()} disabled={laden}>
            Aktualisieren
          </button>
        </div>
      </div>
      <div className="wf-runs__filter">
        <label className="field">
          <span>Status</span>
          <select value={status} onChange={(e) => setStatus(e.target.value)}>
            <option value="">alle</option>
            <option value="success">erfolgreich</option>
            <option value="error">Fehler</option>
            <option value="running">läuft</option>
            <option value="waiting">wartet auf Vorgang</option>
            <option value="paused">wartet auf Freigabe</option>
            <option value="cancelled">abgebrochen</option>
          </select>
        </label>
        <label className="field">
          <span>Workflow</span>
          <select value={workflowId} onChange={(e) => setWorkflowId(e.target.value)}>
            <option value="">alle</option>
            {workflows.map((w) => (
              <option key={w.id} value={w.id}>
                {w.name}
              </option>
            ))}
          </select>
        </label>
        <label className="field">
          <span>Zeitraum</span>
          <select value={tage} onChange={(e) => setTage(Number(e.target.value))}>
            <option value={1}>heute</option>
            <option value={7}>7 Tage</option>
            <option value={30}>30 Tage</option>
            <option value={0}>alles</option>
          </select>
        </label>
      </div>
      {rows.length === 0 ? (
        <p className="muted">Keine Läufe im gewählten Zeitraum.</p>
      ) : (
        <div className="wf-runs__tablewrap">
          <table className="radar-table wf-runs__table">
            <thead>
              <tr>
                <th>Start</th>
                <th>Dauer</th>
                <th>Workflow</th>
                <th>Auslöser</th>
                <th>Firma</th>
                <th>Schritte</th>
                <th>Status</th>
                <th>Ergebnis</th>
              </tr>
            </thead>
            <tbody>
              {rows.map((ex) => {
                const schritte = Object.keys(ex.nodeRuns).length;
                const fehler = Object.entries(ex.nodeRuns).filter(([, runs]) => runs.at(-1)?.status === "error").length;
                return (
                  <tr key={ex.id} className="wf-runs__row" onClick={() => navigate(`/workflows/${encodeURIComponent(ex.workflowId)}?lauf=${encodeURIComponent(ex.id)}`)}>
                    <td>{new Date(ex.startedAt).toLocaleString("de-DE", { dateStyle: "short", timeStyle: "short" })}</td>
                    <td>{dauerText(ex)}</td>
                    <td>{ex.workflowName}</td>
                    <td>{ex.trigger === "test" ? "Trockenlauf" : triggerText({ kind: ex.trigger === "manual" ? "manual" : ex.trigger === "schedule" ? "schedule" : ex.trigger === "event" ? "event" : "chat" } as never)}</td>
                    <td>{firmaText(ex)}</td>
                    <td>
                      {schritte}
                      {fehler > 0 && <span className="muted"> · {fehler} Fehler</span>}
                    </td>
                    <td>
                      {statusPill(ex.status)}
                      {ex.waiting && <span className="muted small"> {ex.waiting.fertig ?? ex.waiting.weitergegeben.length} weitergegeben, {ex.waiting.offen ?? "?"} offen</span>}
                    </td>
                    <td className="wf-runs__summary" title={ex.error ?? ex.summary ?? ""}>
                      {ex.error ?? ex.summary ?? ""}
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}

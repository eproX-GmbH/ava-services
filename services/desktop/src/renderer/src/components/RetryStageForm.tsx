// v0.1.492 — Wiederverwendbares "Erneut versuchen"-Formular.
//
// Vorher lebte das nur versteckt im Vorgangs-Detail (RetryStagePicker);
// jetzt teilen sich TransactionDetail UND der Firmen-Drill-Down in
// "Meine Firmen" dieselbe Komponente. Der Firmenname ist vorbefuellt
// (Pflichtfeld des Kontakt-Producers), bleibt aber editierbar.

import { useEffect, useMemo, useState } from "react";
import { gatewayFetch, GatewayError } from "../api/gateway";

/** v0.1.504 — verstaendliche Fehlertexte statt "gateway 403". Der
 *  Status allein sagt Nutzern nichts; jede Zeile nennt Ursache UND
 *  naechsten Schritt. */
function fehlertext(e: unknown): string {
  if (e instanceof GatewayError) {
    if (e.status === 403) {
      return (
        "Dieser Verarbeitungs-Vorgang gehört nicht zu deinem Konto oder " +
        "existiert nicht mehr. Falls die Firma zwischenzeitlich gelöscht " +
        "wurde: einmal neu importieren."
      );
    }
    if (e.status === 409) {
      return (
        "Die Verarbeitung dieser Firma ist ausgesetzt (pausiert). " +
        "In der Firmenübersicht fortsetzen, dann erneut versuchen."
      );
    }
    if (e.status === 404) {
      return "Vorgang oder Firma nicht gefunden — vermutlich zwischenzeitlich gelöscht.";
    }
    if (e.status === 429) {
      return "Zu viele Anfragen. Bitte kurz warten und erneut versuchen.";
    }
    if (e.status >= 500) {
      return `Der Server meldet einen Fehler (HTTP ${e.status}). Bitte später erneut versuchen.`;
    }
    return e.message;
  }
  return e instanceof Error ? e.message : String(e);
}

export type RetryStageId =
  | "structuredContent"
  | "companyPublication"
  | "website"
  | "companyProfile"
  | "companyContact"
  | "companyEvaluation";

export const RETRY_STAGES: Array<{ id: RetryStageId; label: string }> = [
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

export function RetryStageForm({
  transactionId,
  transactionIdByStage,
  companyId,
  defaultCompanyName,
  failedStages,
  onDispatched,
}: {
  /** Fallback-Vorgang fuer alle Stufen. */
  transactionId: string;
  /** Optional: stufen-spezifischer Vorgang (Firmen-Matrix traegt je
   *  Zelle die transactionId ihres letzten Laufs). */
  transactionIdByStage?: Partial<Record<RetryStageId, string>>;
  companyId: string;
  /** Vorbefuellung fuer das Pflichtfeld des Kontakt-Producers. */
  defaultCompanyName?: string | null;
  failedStages?: RetryStageId[];
  onDispatched?: () => void;
}) {
  const firstFailed = useMemo<RetryStageId>(
    () => failedStages?.[0] ?? "structuredContent",
    [failedStages],
  );

  const [stage, setStage] = useState<RetryStageId>(firstFailed);
  const [companyName, setCompanyName] = useState<string>(
    defaultCompanyName ?? "",
  );
  const [busy, setBusy] = useState(false);
  const [result, setResult] = useState<RetryResult | null>(null);
  const [err, setErr] = useState<string | null>(null);

  // Re-default when the user switches to a different company row.
  useEffect(() => {
    setStage(firstFailed);
    setCompanyName(defaultCompanyName ?? "");
    setResult(null);
    setErr(null);
  }, [firstFailed, companyId, defaultCompanyName]);

  const effectiveTx = transactionIdByStage?.[stage] ?? transactionId;

  const onClick = async () => {
    setBusy(true);
    setErr(null);
    setResult(null);
    try {
      const body: { stage: RetryStageId; companyName?: string } = { stage };
      if (stage === "companyContact" && companyName.trim()) {
        body.companyName = companyName.trim();
      }
      const res = await gatewayFetch<RetryResult>(
        `/v1/transactions/${effectiveTx}/entities/${companyId}/retry`,
        { method: "POST", body },
      );
      setResult(res);
      onDispatched?.();
    } catch (e) {
      setErr(fehlertext(e));
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="retry-form">
      <label className="retry-form__row">
        <span>Schritt</span>
        <select
          value={stage}
          onChange={(e) => setStage(e.target.value as RetryStageId)}
          disabled={busy}
        >
          {RETRY_STAGES.map((s) => (
            <option key={s.id} value={s.id}>
              {s.label}
              {failedStages?.includes(s.id) ? " (fehlgeschlagen)" : ""}
            </option>
          ))}
        </select>
      </label>
      {stage === "companyContact" && (
        <label className="retry-form__row">
          <span>Firmenname</span>
          <input
            type="text"
            placeholder={`Pflichtfeld für „Kontakt"`}
            value={companyName}
            onChange={(e) => setCompanyName(e.target.value)}
            disabled={busy}
          />
        </label>
      )}
      <button type="button" onClick={onClick} disabled={busy}>
        {busy ? "Wird ausgelöst…" : "Schritt erneut starten"}
      </button>
      {err && <p className="bad">Fehler: {err}</p>}
      {result && (
        <div className={`retry-result ${result.ok ? "ok" : "warn"}`}>
          <p>
            <strong>
              {result.ok ? "✓ Ausgelöst" : "⚠ Teilweise ausgelöst"}
            </strong>{" "}
            <span className="muted">
              ({result.dispatched.filter((d) => d.ok).length}/
              {result.dispatched.length})
            </span>
          </p>
          <ul>
            {result.dispatched.map((d, i) => (
              <li key={i} className={d.ok ? "ok" : "bad"}>
                <code>{d.upstream}</code> → {d.stage} ·{" "}
                {d.ok ? "ok" : `fehlgeschlagen: ${d.error ?? "unbekannt"}`}
              </li>
            ))}
          </ul>
        </div>
      )}
    </div>
  );
}

// Vorgangs-Matrix im Chat (Nutzerwunsch 2026-10-13): Bei Importen mit bis zu
// fuenf Firmen zeigt die Aufgabenkarte die Stufen je Firma direkt im Verlauf
// (gleiche Punkte wie in der Vorgangsansicht), damit man im Chat sieht, wie
// weit die Verarbeitung ist. Groessere Vorgaenge behalten die Zeile mit dem
// Zaehler; die Vorgangsansicht ist in beiden Faellen verlinkt.
import { useEffect, useState } from "react";
import { Link } from "react-router-dom";
import { gatewayFetch } from "../api/gateway";

/** Ab so vielen Firmen bleibt es bei der Zusammenfassung. */
export const INLINE_MAX_FIRMEN = 5;

type CellState = "completed" | "failed" | "skipped" | "pending" | "in_progress";
interface Cell { state: CellState; errorMessage?: string | null; updatedAt?: string | null }
interface Pipeline {
  stages: string[];
  unavailableStages: string[];
  rows: Array<{ companyId: string; cells: Record<string, Cell> }>;
}

const STAGE_LABEL: Record<string, string> = {
  masterData: "Stamm",
  structuredContent: "Struktur",
  companyPublication: "Publikation",
  website: "Website",
  companyProfile: "Profil",
  companyContact: "Kontakt",
  companyEmail: "E-Mail",
};
const STATE_LABEL: Record<CellState, string> = {
  completed: "fertig",
  failed: "fehlgeschlagen",
  skipped: "übersprungen",
  pending: "wartet",
  in_progress: "läuft",
};
function stateClass(state: CellState, fehler?: string | null): string {
  if (state === "failed" && (fehler ?? "").startsWith("Zeitüberschreitung")) return "timeout";
  switch (state) {
    case "completed": return "ok";
    case "failed": return "bad";
    case "in_progress": return "warn";
    case "skipped": return "muted";
    default: return "pending";
  }
}

export function VorgangInline({ transactionId, laeuft }: { transactionId: string; laeuft: boolean }) {
  const [pipeline, setPipeline] = useState<Pipeline | null>(null);
  const [namen, setNamen] = useState<Record<string, string>>({});
  useEffect(() => {
    let aktiv = true;
    const laden = async () => {
      try {
        const p = await gatewayFetch<Pipeline>(`/v1/transactions/${encodeURIComponent(transactionId)}/pipeline`);
        if (!aktiv) return;
        setPipeline(p);
        const fehlend = p.rows.map((r) => r.companyId).filter((id) => !(id in namen));
        if (fehlend.length > 0) {
          const neu: Record<string, string> = {};
          await Promise.all(fehlend.map(async (id) => {
            try {
              const d = await gatewayFetch<{ name?: string | null }>(`/v1/companies/${encodeURIComponent(id)}`);
              if (d.name) neu[id] = d.name;
            } catch { /* Name bleibt die ID */ }
          }));
          if (aktiv && Object.keys(neu).length > 0) setNamen((alt) => ({ ...alt, ...neu }));
        }
      } catch { /* naechster Takt */ }
    };
    void laden();
    // Waehrend der Vorgang laeuft, im Takt des Aufgaben-Waechters nachladen.
    const t = laeuft ? setInterval(() => void laden(), 20_000) : null;
    return () => {
      aktiv = false;
      if (t) clearInterval(t);
    };
    // namen absichtlich nicht als Abhaengigkeit: nur fehlende werden nachgeladen.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [transactionId, laeuft]);

  if (!pipeline || pipeline.rows.length === 0 || pipeline.rows.length > INLINE_MAX_FIRMEN) return null;
  const stufen = pipeline.stages.filter((s) => s in STAGE_LABEL && !pipeline.unavailableStages.includes(s));
  return (
    <div className="vorgang-inline">
      <table className="matrix vorgang-inline__tabelle">
        <thead>
          <tr>
            <th>Firma</th>
            {stufen.map((s) => <th key={s}>{STAGE_LABEL[s]}</th>)}
          </tr>
        </thead>
        <tbody>
          {pipeline.rows.map((r) => (
            <tr key={r.companyId}>
              <td className="matrix-company">
                <Link to={`/companies/${encodeURIComponent(r.companyId)}`}>{namen[r.companyId] ?? r.companyId}</Link>
              </td>
              {stufen.map((s) => {
                const z = r.cells[s];
                const titel = z ? `${STAGE_LABEL[s]}: ${STATE_LABEL[z.state]}${z.errorMessage ? ` · ${z.errorMessage.slice(0, 120)}` : ""}` : STAGE_LABEL[s];
                return (
                  <td key={s} className="matrix-cell">
                    <span className="cell-dot" title={titel} aria-label={titel}>
                      <span className={`dot ${z ? stateClass(z.state, z.errorMessage) : "pending"}`} />
                    </span>
                  </td>
                );
              })}
            </tr>
          ))}
        </tbody>
      </table>
      <Link className="vorgang-inline__link" to={`/transactions/${encodeURIComponent(transactionId)}`}>Vorgang öffnen</Link>
    </div>
  );
}

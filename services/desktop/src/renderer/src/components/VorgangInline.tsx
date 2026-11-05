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
/** Kurzform fuer die Kopfzeile (52 px je Spalte); die Langform steht im Tooltip. */
const STAGE_KURZ: Record<string, string> = { companyPublication: "Publik.", structuredContent: "Struktur" };
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
  // 2026-11-05 (Joyce): keine Tabelle mehr — ein Raster, das sich ueber
  // Container-Abfragen der Kartenbreite anpasst (schmal: Punkte unter dem
  // Namen, Stufenkopf weg), Firmenname ohne Link-Blau, Fehler je Firma als
  // eigene Zeile statt nur im Tooltip.
  return (
    <div className="vorgang-inline">
      <div className="vi-kopf" aria-hidden="true">
        <span className="vi-kopf__firma">Firma</span>
        <div className="vi-stufen vi-stufen--kopf">
          {stufen.map((s) => <span key={s} className="vi-stufe vi-stufe--label" title={STAGE_LABEL[s]}>{STAGE_KURZ[s] ?? STAGE_LABEL[s]}</span>)}
        </div>
      </div>
      <ul className="vi-liste">
        {pipeline.rows.map((r) => {
          const fehler = stufen
            .map((s) => ({ s, z: r.cells[s] }))
            .filter((x): x is { s: string; z: Cell } => Boolean(x.z && x.z.state === "failed"));
          const fertig = stufen.filter((s) => r.cells[s]?.state === "completed").length;
          return (
            <li key={r.companyId} className="vi-zeile">
              <Link className="vi-firma" to={`/companies/${encodeURIComponent(r.companyId)}`} title={namen[r.companyId] ?? r.companyId}>
                {namen[r.companyId] ?? r.companyId}
              </Link>
              <div className="vi-stufen" role="img" aria-label={`${fertig} von ${stufen.length} Stufen fertig`}>
                {stufen.map((s) => {
                  const z = r.cells[s];
                  const titel = z ? `${STAGE_LABEL[s]}: ${STATE_LABEL[z.state]}${z.errorMessage ? ` · ${z.errorMessage.slice(0, 120)}` : ""}` : STAGE_LABEL[s];
                  return (
                    <span key={s} className="vi-stufe" title={titel}>
                      <span className={`dot ${z ? stateClass(z.state, z.errorMessage) : "pending"}`} />
                    </span>
                  );
                })}
              </div>
              {fehler.length > 0 && (
                <div className="vi-fehler">
                  {fehler.map(({ s, z }) => (
                    <span key={s}>
                      <strong>{STAGE_LABEL[s]}</strong> {STATE_LABEL[z.state]}
                      {z.errorMessage ? `: ${z.errorMessage.slice(0, 90)}` : ""}
                    </span>
                  ))}
                </div>
              )}
            </li>
          );
        })}
      </ul>
      <Link className="vi-oeffnen" to={`/transactions/${encodeURIComponent(transactionId)}`}>
        Vorgang öffnen
        <svg width="12" height="12" viewBox="0 0 12 12" aria-hidden="true"><path d="M4 2.5L7.5 6 4 9.5" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" fill="none" /></svg>
      </Link>
    </div>
  );
}

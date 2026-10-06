// Reiter „Kunden“ (docs/PLAN_KUNDEN.md, K3): Kunden, Partner und
// Referenzprojekte, die die Firma auf ihrer Website nennt, mit Beleg und
// Stammdaten-Treffer. Ein Treffer laesst sich direkt uebernehmen (Import plus
// Verarbeitung) oder oeffnen, wenn er schon in „Meine Firmen“ steht.

import { useNavigate } from "react-router-dom";
import { FirmaUebernehmen, useIstUebernommen } from "../routes/firma-uebernehmen";

export interface Kunde {
  id: string;
  name: string;
  art: "kunde" | "partner" | "referenzprojekt";
  beleg: string | null;
  quelle: string | null;
  konfidenz: string | null;
  erstGesehen: string;
  zuletztGesehen: string;
  match: { companyId: string; name: string; location: string | null } | null;
}

const ART_LABEL: Record<Kunde["art"], string> = {
  kunde: "Kunde",
  partner: "Partner",
  referenzprojekt: "Referenzprojekt",
};

function Treffer({ match, onFertig }: { match: NonNullable<Kunde["match"]>; onFertig: () => void }) {
  const navigate = useNavigate();
  const uebernommen = useIstUebernommen(match.companyId);
  return (
    <div className="kunden-treffer">
      <button
        type="button"
        className="link-button"
        onClick={() => navigate(`/companies/${encodeURIComponent(match.companyId)}`)}
        title="Firma öffnen"
      >
        {match.name}
        {match.location ? `, ${match.location}` : ""}
      </button>
      <FirmaUebernehmen
        name={match.name}
        ort={match.location}
        uebernommen={uebernommen}
        companyId={match.companyId}
        onFertig={onFertig}
      />
    </div>
  );
}

export function KundenTab({ items, onFertig }: { items: Kunde[]; onFertig: () => void }) {
  if (items.length === 0) return <p className="muted">Noch keine Kunden oder Referenzen erkannt.</p>;
  const gruppen: Array<[Kunde["art"], Kunde[]]> = (["kunde", "referenzprojekt", "partner"] as const)
    .map((art) => [art, items.filter((k) => k.art === art)] as [Kunde["art"], Kunde[]])
    .filter(([, l]) => l.length > 0);
  return (
    <>
      <p className="muted small" style={{ marginTop: 0 }}>
        Von der Website der Firma erkannt (Referenzseiten, Logowände, Fallstudien). Der Stammdaten-Treffer ist ein
        Vorschlag; „Übernehmen“ importiert die Firma in „Meine Firmen“ und startet die Verarbeitung.
      </p>
      {gruppen.map(([art, liste]) => (
        <section key={art} style={{ marginBottom: 20 }}>
          <h3 style={{ marginBottom: 8 }}>
            {ART_LABEL[art]} <span className="muted">({liste.length})</span>
          </h3>
          <table className="kunden-tabelle">
            <thead>
              <tr>
                <th>Name</th>
                <th>Beleg</th>
                <th>In den Stammdaten</th>
              </tr>
            </thead>
            <tbody>
              {liste.map((k) => (
                <tr key={k.id}>
                  <td>
                    <strong>{k.name}</strong>
                    {k.konfidenz === "mittel" && (
                      <span className="muted small" title="Nur als Logo ohne Kontext gefunden"> · unsicher</span>
                    )}
                  </td>
                  <td className="small">
                    {k.beleg && <span>„{k.beleg}“ </span>}
                    {k.quelle && (
                      <a href={k.quelle} target="_blank" rel="noreferrer" title={k.quelle}>
                        Quelle öffnen ↗
                      </a>
                    )}
                  </td>
                  <td>
                    {k.match ? (
                      <Treffer match={k.match} onFertig={onFertig} />
                    ) : (
                      <span className="muted small">nicht gefunden</span>
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </section>
      ))}
    </>
  );
}

// Reiter „Kunden“ (docs/PLAN_KUNDEN.md, K3): Kunden, Partner und
// Referenzprojekte, die die Firma auf ihrer Website nennt, mit Beleg und
// Stammdaten-Treffer. Ein Treffer laesst sich direkt uebernehmen (Import plus
// Verarbeitung) oder oeffnen, wenn er schon in „Meine Firmen“ steht.

import { useNavigate } from "react-router-dom";
import { FirmaUebernehmen, useIstUebernommen } from "../routes/firma-uebernehmen";

export interface Kunde {
  id: string;
  name: string;
  art: "kunde" | "partner" | "referenzprojekt" | "zertifikat" | "technologiepartner";
  beleg: string | null;
  quelle: string | null;
  konfidenz: string | null;
  erstGesehen: string;
  zuletztGesehen: string;
  match: { companyId: string; name: string; location: string | null } | null;
}

const ART_LABEL: Record<Kunde["art"], string> = {
  kunde: "Kunden",
  referenzprojekt: "Referenzprojekte",
  partner: "Partner",
  technologiepartner: "Technologiepartner",
  zertifikat: "Zertifikate und Siegel",
};
/** Zertifikate sind keine Firmen: ohne Stammdaten-Spalte und ohne Aktion. */
const OHNE_STAMMDATEN = new Set<Kunde["art"]>(["zertifikat"]);

function TrefferLink({ match }: { match: NonNullable<Kunde["match"]> }) {
  const navigate = useNavigate();
  return (
    <button
      type="button"
      className="link-button"
      onClick={() => navigate(`/companies/${encodeURIComponent(match.companyId)}`)}
      title="Firma öffnen"
    >
      {match.name}
      {match.location ? `, ${match.location}` : ""}
    </button>
  );
}

/** Eigene Spalte: ein zurückhaltender Knopf je Zeile, rechtsbündig. */
function Aktion({ match, onFertig }: { match: NonNullable<Kunde["match"]>; onFertig: () => void }) {
  const uebernommen = useIstUebernommen(match.companyId);
  return (
    <FirmaUebernehmen
      name={match.name}
      ort={match.location}
      uebernommen={uebernommen}
      companyId={match.companyId}
      onFertig={onFertig}
      kompakt
    />
  );
}

export function KundenTab({ items, onFertig }: { items: Kunde[]; onFertig: () => void }) {
  if (items.length === 0) return <p className="muted">Noch keine Kunden oder Referenzen erkannt.</p>;
  const gruppen: Array<[Kunde["art"], Kunde[]]> = (["kunde", "referenzprojekt", "partner", "technologiepartner", "zertifikat"] as const)
    .map((art) => [art, items.filter((k) => k.art === art)] as [Kunde["art"], Kunde[]])
    .filter(([, l]) => l.length > 0);
  return (
    <>
      <p className="muted small" style={{ marginTop: 0 }}>
        Von der Website der Firma erkannt (Referenzseiten, Logowände, Fallstudien, Partner- und Zertifikatslogos). Der
        Stammdaten-Treffer ist ein Vorschlag; „Übernehmen“ importiert die Firma in „Meine Firmen“ und startet die
        Verarbeitung.
      </p>
      {gruppen.map(([art, liste]) => (
        <section key={art} style={{ marginBottom: 20 }}>
          <h3 style={{ marginBottom: 8 }}>
            {ART_LABEL[art]} <span className="muted">({liste.length})</span>
          </h3>
          <table className="kunden-tabelle">
            {/* Feste Spaltenbreiten: Die Gruppen sind eigene Tabellen und
                sollen trotzdem wie EINE Liste lesen — gleiche Kanten. */}
            <colgroup>
              <col style={{ width: "22%" }} />
              <col style={{ width: "42%" }} />
              <col style={{ width: "24%" }} />
              <col style={{ width: "12%" }} />
            </colgroup>
            <thead>
              <tr>
                <th>Name</th>
                <th>Beleg</th>
                <th>In den Stammdaten</th>
                <th className="kunden-aktion" aria-label="Aktion" />
              </tr>
            </thead>
            <tbody>
              {liste.map((k) => (
                <tr key={k.id}>
                  <td>
                    <strong>{k.name}</strong>
                  </td>
                  <td className="small kunden-beleg">
                    {k.beleg && <span className="kunden-zitat">„{k.beleg}“</span>}
                    {k.quelle && (
                      <a href={k.quelle} target="_blank" rel="noreferrer" title={k.quelle}>
                        Quelle öffnen ↗
                      </a>
                    )}
                  </td>
                  <td>
                    {OHNE_STAMMDATEN.has(art) ? (
                      <span className="muted small">–</span>
                    ) : k.match ? (
                      <TrefferLink match={k.match} />
                    ) : (
                      <span className="muted small">nicht gefunden</span>
                    )}
                  </td>
                  <td className="kunden-aktion">{k.match && !OHNE_STAMMDATEN.has(art) && <Aktion match={k.match} onFertig={onFertig} />}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </section>
      ))}
    </>
  );
}

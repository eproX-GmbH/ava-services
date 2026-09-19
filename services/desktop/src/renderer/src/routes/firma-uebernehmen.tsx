// "Übernehmen und verarbeiten" im Kopf der Firmenansicht.
//
// Bis v0.1.699 führte aus der Firmenansicht kein Weg in den eigenen
// Bestand: Wer eine Firma über die Suche fand, musste in den Chat wechseln
// und sie dort importieren lassen.
//
// Ein Knopf, nicht zwei: "In Meine Firmen übernehmen" und "Import starten"
// sind dieselbe Aktion. "Meine Firmen" ist keine eigene Liste, sondern die
// Sicht auf alle Firmen, für die im eigenen Mandanten ein
// Verarbeitungsstand existiert — der entsteht genau durch den Import. Zwei
// Knöpfe mit identischer Wirkung nebeneinander wären eine Falle.
//
// Stattdessen richtet sich der Knopf nach dem Zustand: noch nicht
// übernommen → übernehmen; schon übernommen → erneut verarbeiten, mit
// einem Verweis in die Firmenliste.
import { useState } from "react";
import { Link } from "react-router-dom";
import { gatewayFetch } from "../api/gateway";

export interface UebernehmenProps {
  /** Firmenname, wie er im Register steht. */
  name: string | null | undefined;
  /** Ort für die Zuordnung — Registersitz, sonst Anschrift. */
  ort: string | null | undefined;
  /** true, sobald für die Firma ein Verarbeitungsstand vorliegt. */
  uebernommen: boolean;
  /** Nach erfolgreichem Anstoß: Ansicht neu laden. */
  onFertig?: () => void;
}

/** Wurde die Firma im eigenen Mandanten schon verarbeitet? */
export function istUebernommen(stages: Record<string, unknown> | null | undefined): boolean {
  return Boolean(stages) && Object.keys(stages as object).length > 0;
}

export function FirmaUebernehmen({ name, ort, uebernommen, onFertig }: UebernehmenProps) {
  const [laeuft, setLaeuft] = useState(false);
  const [meldung, setMeldung] = useState<string | null>(null);
  const [fehler, setFehler] = useState<string | null>(null);
  const [vorgang, setVorgang] = useState<string | null>(null);

  // Ohne Name und Ort findet die Zuordnung die Firma nicht — dann lieber
  // keinen Knopf als einen, der ins Leere greift.
  if (!name?.trim() || !ort?.trim()) return null;

  const anstossen = async () => {
    setLaeuft(true);
    setMeldung(null);
    setFehler(null);
    try {
      const r = await gatewayFetch<{ transactionId: string; companyCount: number }>(
        "/v1/imports/from-list",
        {
          method: "POST",
          body: {
            companies: [{ name: name.trim(), city: ort.trim() }],
            transactionName: `${name.trim()} (aus der Firmenansicht)`,
          },
        },
      );
      setVorgang(r.transactionId);
      setMeldung(
        uebernommen
          ? "Verarbeitung erneut angestoßen."
          : "Übernommen — die Verarbeitung läuft.",
      );
      onFertig?.();
    } catch (e) {
      setFehler(e instanceof Error ? e.message : String(e));
    } finally {
      setLaeuft(false);
    }
  };

  return (
    <div className="firma-aktion">
      <div className="firma-aktion__knoepfe">
        <button
          type="button"
          className={uebernommen ? "btn" : "primary"}
          disabled={laeuft}
          onClick={() => void anstossen()}
          title={
            uebernommen
              ? "Alle Daten dieser Firma erneut holen und bewerten"
              : "Die Firma in den eigenen Bestand holen und alle Daten erheben"
          }
        >
          {laeuft
            ? "Wird angestoßen …"
            : uebernommen
              ? "Neu verarbeiten"
              : "Übernehmen und verarbeiten"}
        </button>
        {uebernommen && (
          <Link className="firma-aktion__verweis" to="/alle-firmen">
            in Meine Firmen
          </Link>
        )}
      </div>
      {meldung && (
        <p className="firma-aktion__hinweis">
          {meldung}
          {vorgang && (
            <>
              {" "}
              <Link to={`/transactions/${vorgang}`}>Fortschritt ansehen</Link>
            </>
          )}
        </p>
      )}
      {fehler && <p className="firma-aktion__fehler">{fehler}</p>}
    </div>
  );
}

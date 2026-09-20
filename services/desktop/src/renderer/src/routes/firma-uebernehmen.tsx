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
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { gatewayFetch } from "../api/gateway";

export interface UebernehmenProps {
  /** Firmenname, wie er im Register steht. */
  name: string | null | undefined;
  /** Ort für die Zuordnung — Registersitz, sonst Anschrift. */
  ort: string | null | undefined;
  /** true = steht in "Meine Firmen". `undefined`, solange das noch nicht
   *  feststeht — dann behauptet der Knopf nichts. */
  uebernommen: boolean | undefined;
  /** Nach erfolgreichem Anstoß: Ansicht neu laden. */
  onFertig?: () => void;
  /** Für die Relevanz: Ein Import ist eine der teuersten Handlungen, die
   *  ein Nutzer an einer Firma vornimmt — entsprechend schwer wiegt sie. */
  companyId?: string;
}

/**
 * Steht die Firma in "Meine Firmen"?
 *
 * Frueher wurde das aus dem Verarbeitungsstand abgeleitet ("hat irgendeine
 * Stufe eine Zeile?"). Das war falsch: Eine Firma bekommt einen
 * Verarbeitungsstand, sobald sie IRGENDJEMAND verarbeitet hat — ueber die
 * Firmensuche, das Radar oder den Vorgang einer Kollegin. Die Ansicht
 * behauptete dann "in Meine Firmen", obwohl die Firma in der eigenen Liste
 * gar nicht auftauchte.
 *
 * "Meine Firmen" sind die Firmen aus den EIGENEN Vorgaengen des Nutzers —
 * genau das, was die Liste unter Firmen zeigt. Deshalb wird jetzt dieselbe
 * Quelle gefragt, nur auf eine Firma eingeschraenkt.
 */
export function useIstUebernommen(companyId: string | undefined): boolean | undefined {
  const q = useQuery({
    queryKey: ["inMeinenFirmen", companyId],
    queryFn: () =>
      gatewayFetch<{ count: number }>(
        `/v1/companies/matrix?pageSize=1&companyId=${encodeURIComponent(companyId!)}`,
      ),
    enabled: Boolean(companyId),
    staleTime: 30_000,
  });
  // undefined, solange unbekannt: Lieber gar nichts behaupten als das
  // Falsche. Der Knopf zeigt dann seine neutrale Beschriftung.
  return q.data ? q.data.count > 0 : undefined;
}

export function FirmaUebernehmen({ name, ort, uebernommen, onFertig, companyId }: UebernehmenProps) {
  const qc = useQueryClient();
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
      // Die Firma steht ab jetzt in "Meine Firmen" — die Antwort von vorhin
      // ist damit veraltet, und ohne dieses Verwerfen bliebe der Knopf bis
      // zum naechsten Laden bei "Uebernehmen und verarbeiten".
      if (companyId) void qc.invalidateQueries({ queryKey: ["inMeinenFirmen", companyId] });
      // Relevanz: Uebernehmen wiegt schwerer als ein erneuter Anstoss —
      // beim ersten Mal entscheidet sich der Nutzer fuer diese Firma,
      // danach pflegt er sie nur.
      if (companyId) {
        void window.api.relevanz.erfasse(
          uebernommen ? "firma.import" : "firma.uebernommen",
          companyId,
        );
      }
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
          className={uebernommen === true ? "btn" : "primary"}
          disabled={laeuft || uebernommen === undefined}
          onClick={() => void anstossen()}
          title={
            uebernommen === true
              ? "Alle Daten dieser Firma erneut holen und bewerten"
              : "Die Firma in den eigenen Bestand holen und alle Daten erheben"
          }
        >
          {/* Solange unbekannt, wartet der Knopf. Das dauert einen Wimpern-
              schlag und ist ehrlicher, als kurz die falsche Beschriftung zu
              zeigen und sie dann zu tauschen. */}
          {laeuft
            ? "Wird angestoßen …"
            : uebernommen === undefined
              ? "Wird geprüft …"
              : uebernommen
                ? "Neu verarbeiten"
                : "Übernehmen und verarbeiten"}
        </button>
        {uebernommen === true && (
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

// Einstellungen: Relevanz (docs/PLAN_RELEVANZ.md, Abschnitt 7 und 9).
//
// Drei Dinge gehoeren hierher, und alle drei aus demselben Grund: Wer nicht
// nachlesen kann, was ueber ihn erfasst wird, muss es hinnehmen.
//
//   1. der Schalter — sofern die Organisation ihn nicht verbindlich gesetzt hat,
//   2. die Einsicht in die Rohsignale,
//   3. das Loeschen, einzeln oder ganz.
//
// Hat die Organisation die Funktion abgeschaltet, erscheint dieser Abschnitt
// gar nicht (AutomatisierungenTab prueft das) — keine ausgegraute Karte.

import { useCallback, useEffect, useState } from "react";
import type { RelevanzStatus } from "../../../../shared/types";

interface Rohsignal {
  zielArt: string;
  zielId: string;
  art: string;
  punkte: number;
  zeitpunkt: string;
}

/** Klartext je Signalart. Punkte zeigen wir bewusst nicht: Sie erklaeren
 *  nichts und laden dazu ein, sie auszurechnen statt zu arbeiten. */
const TEXTE: Record<string, string> = {
  "firma.ansicht": "Firma angesehen",
  "firma.verweildauer": "länger in der Firmenansicht",
  "firma.chatlink": "Firmenlink im Chat geöffnet",
  "firma.chat": "im Chat behandelt",
  "firma.uebernommen": "in Meine Firmen übernommen",
  "firma.import": "Import gestartet",
  "firma.workflow": "in einem Workflow verwendet",
  "firma.watchlist": "auf die Watchlist gesetzt",
  "firma.crm": "mit dem CRM verknüpft",
  "firma.alarm.geoeffnet": "Meldung geöffnet",
  "firma.alarm.weggewischt": "Meldung wiederholt weggewischt",
  "person.profil": "Profil geöffnet",
  "person.hinweis": "DSGVO-Hinweis kopiert",
  "person.crm": "ins CRM übernommen",
  "person.mail": "Mailentwurf begonnen",
  "person.gesucht": "über die Kontaktsuche gefunden",
  "person.chat": "im Chat behandelt",
  "person.watchlist": "auf die Personen-Watchlist gesetzt",
};

export function RelevanzSection() {
  const [status, setStatus] = useState<RelevanzStatus | null>(null);
  const [signale, setSignale] = useState<Rohsignal[] | null>(null);
  const [offen, setOffen] = useState(false);
  const [meldung, setMeldung] = useState<string | null>(null);

  const ladeStatus = useCallback(() => {
    void window.api.relevanz.status().then(setStatus);
  }, []);
  useEffect(ladeStatus, [ladeStatus]);

  useEffect(() => {
    if (!offen) return;
    void window.api.relevanz.rohsignale().then(setSignale);
  }, [offen]);

  if (!status) return null;

  const umschalten = (an: boolean) => {
    void window.api.relevanz.setzeAn(an).then((s) => {
      setStatus(s);
      setMeldung(
        an
          ? "Erfassung eingeschaltet."
          : "Erfassung ausgeschaltet. Bereits Gesammeltes bleibt, bis du es löschst.",
      );
    });
  };

  const allesLoeschen = () => {
    void window.api.relevanz.vergessen().then((ok) => {
      setMeldung(ok ? "Alle Signale gelöscht." : "Löschen fehlgeschlagen.");
      setSignale(ok ? [] : signale);
    });
  };

  return (
    <section className="provider-section alerts-prefs" id="relevanz-section">
      <h3>Relevanz</h3>
      <p className="muted">
        AVA merkt sich, mit welchen Firmen und Personen du arbeitest — welche du
        ansiehst, im Chat behandelst, übernimmst oder ins CRM holst. Daraus
        entsteht je Eintrag eine Nähe von 1 bis 10. Sie steuert, was AVA im
        Hintergrund genauer beobachtet und welche Meldungen dich sofort
        erreichen statt in der Tageszusammenfassung zu landen.
      </p>
      <p className="muted small">
        Die Signale liegen in deinem AVA-Konto, getrennt von allen anderen.
        Niemand sonst kann sie sehen, auch nicht die Verwaltung deiner
        Organisation. Es gibt keine Auswertung über Mitglieder hinweg. Was
        älter als 400 Tage ist, wird gelöscht. Warnungen zum Firmenstatus —
        Insolvenz, Löschung — erreichen dich immer, unabhängig von der Nähe.
      </p>

      {status.selbstbestimmt ? (
        <div className="alerts-prefs__row">
          <label className="alerts-prefs__check">
            <input
              type="checkbox"
              checked={status.an}
              onChange={(e) => umschalten(e.target.checked)}
            />
            <span>Relevanz erfassen</span>
          </label>
        </div>
      ) : (
        <p className="muted small">
          Deine Organisation hat diese Einstellung verbindlich gesetzt: Die
          Erfassung ist {status.an ? "eingeschaltet" : "ausgeschaltet"}.
        </p>
      )}

      {meldung && <p className="muted small">{meldung}</p>}

      <div className="alerts-prefs__row" style={{ gap: "0.6rem" }}>
        <button type="button" className="btn" onClick={() => setOffen((o) => !o)}>
          {offen ? "Erfasste Signale ausblenden" : "Erfasste Signale ansehen"}
        </button>
        <button type="button" className="btn" onClick={allesLoeschen}>
          Alles löschen
        </button>
      </div>

      {offen && (
        <div className="relevanz-signale">
          {signale === null && <p className="muted small">Wird geladen …</p>}
          {signale?.length === 0 && (
            <p className="muted small">Bisher wurde nichts erfasst.</p>
          )}
          {signale && signale.length > 0 && (
            <table className="relevanz-signale__tabelle">
              <thead>
                <tr>
                  <th>Wann</th>
                  <th>Was</th>
                  <th>Wozu</th>
                </tr>
              </thead>
              <tbody>
                {signale.slice(0, 200).map((s, i) => (
                  <tr key={`${s.zielId}-${s.zeitpunkt}-${i}`}>
                    <td className="muted small">
                      {new Date(s.zeitpunkt).toLocaleString("de-DE", {
                        dateStyle: "short",
                        timeStyle: "short",
                      })}
                    </td>
                    <td>{TEXTE[s.art] ?? s.art}</td>
                    <td className="muted small">
                      {s.zielArt === "person" ? "Person" : "Firma"} {s.zielId}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
          {signale && signale.length > 200 && (
            <p className="muted small">
              Die 200 jüngsten von {signale.length} Einträgen.
            </p>
          )}
        </div>
      )}
    </section>
  );
}

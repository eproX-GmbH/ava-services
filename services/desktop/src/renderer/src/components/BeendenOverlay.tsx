import { useEffect, useState } from "react";

/**
 * Beenden-Anzeige: Main schickt `app:wird-beendet`, bevor Producer, Stores
 * und Kanaele herunterfahren. Das Overlay deckt die App ab, damit das
 * Fenster in den Sekunden bis zum Ende nicht wie eingefroren wirkt.
 */
export function BeendenOverlay() {
  const [aktiv, setAktiv] = useState(false);
  const [neustart, setNeustart] = useState(false);
  useEffect(
    () =>
      window.api.onWirdBeendet?.((info) => {
        setNeustart(info.neustart);
        setAktiv(true);
      }),
    [],
  );
  if (!aktiv) return null;
  return (
    <div className="beenden-overlay" role="status" aria-live="polite" aria-label={neustart ? "AVA wird neu gestartet" : "AVA wird beendet"}>
      <div className="beenden-overlay__karte">
        <div className="beenden-overlay__kreis" aria-hidden="true" />
        <p className="beenden-overlay__text">{neustart ? "Wird neu gestartet …" : "Wird beendet …"}</p>
        <p className="beenden-overlay__hinweis muted small">Laufende Vorgänge werden sauber abgeschlossen.</p>
      </div>
    </div>
  );
}

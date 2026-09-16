import { useEffect, useState } from "react";

/**
 * Beenden-Anzeige: Main schickt `app:wird-beendet`, bevor Producer, Stores
 * und Kanaele herunterfahren. Das Overlay deckt die App ab, damit das
 * Fenster in den Sekunden bis zum Ende nicht wie eingefroren wirkt.
 */
export function BeendenOverlay() {
  const [aktiv, setAktiv] = useState(false);
  useEffect(() => window.api.onWirdBeendet?.(() => setAktiv(true)), []);
  if (!aktiv) return null;
  return (
    <div className="beenden-overlay" role="status" aria-live="polite" aria-label="AVA wird beendet">
      <div className="beenden-overlay__karte">
        <div className="beenden-overlay__kreis" aria-hidden="true" />
        <p className="beenden-overlay__text">Wird beendet …</p>
        <p className="beenden-overlay__hinweis muted small">Laufende Vorgänge werden sauber abgeschlossen.</p>
      </div>
    </div>
  );
}

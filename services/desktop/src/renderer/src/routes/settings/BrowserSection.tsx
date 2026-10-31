// Eigener Browser für die Hintergrundverarbeitung (Chrome for Testing).
import { useEffect, useState } from "react";
import type { BrowserStand } from "../../../../shared/types";

export function BrowserSection() {
  const [stand, setStand] = useState<BrowserStand | null>(null);
  useEffect(() => {
    void window.api.browser.stand().then(setStand).catch(() => undefined);
    return window.api.browser.onStand(setStand);
  }, []);
  if (!stand || stand.zustand === "aus") return null;
  return (
    <div className="ek__teil alerts-prefs" id="browser-section">
      <h4>Browser im Hintergrund</h4>
      <p className="muted">
        Für Handelsregister, Websites und Publikationen steuert AVA einen eigenen Browser (Chrome for Testing, rund 160 MB, wird einmal
        geladen). Dein eigener Chrome bleibt unberührt: nie gestartet, nie beendet, keine gemeinsamen Anmeldungen.
      </p>
      <div className="alerts-prefs__row">
        <span className={`status-dot ${stand.zustand === "bereit" ? "ok" : "muted"}`} />
        <span className="small">
          {stand.zustand === "bereit" && `Eigener Browser bereit (Fassung ${stand.version}).`}
          {stand.zustand === "laedt" && `Wird geladen … ${stand.fortschritt} %`}
          {stand.zustand === "fehlt" && "Noch nicht geladen. AVA nutzt so lange den Browser, der auf diesem Rechner installiert ist."}
          {stand.zustand === "fehler" &&
            `Konnte nicht geladen werden: ${stand.meldung}. AVA nutzt so lange den Browser, der auf diesem Rechner installiert ist.`}
        </span>
      </div>
    </div>
  );
}

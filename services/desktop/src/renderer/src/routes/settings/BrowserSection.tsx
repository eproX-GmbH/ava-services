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
    <section className="provider-section alerts-prefs" id="browser-section">
      <h3>Browser der Hintergrundverarbeitung</h3>
      <p className="muted">
        Für Handelsregister, Webseiten und Publikationen steuert AVA einen Browser im Hintergrund. Dafür bringt AVA eine eigene Fassung mit
        (Chrome for Testing von Google, rund 160 MB, wird einmal geladen). Dein eigener Chrome bleibt davon vollständig unberührt: Er wird nie
        gestartet, nie beendet und teilt weder Profil noch Anmeldungen mit AVA.
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
    </section>
  );
}

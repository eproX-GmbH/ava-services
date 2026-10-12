// Einstellungen: E-Mail-Ableitung. Seit 2026-10-12 ohne Hintergrund-Job; die
// Verifizierung laeuft als Pipeline-Stufe „E-Mail“ je Firma (Status-Matrix).
import { useEffect, useState } from "react";
import type { EmailMusterConfig } from "../../../../shared/email-muster-types";

export function EmailMusterSection() {
  const [s, setS] = useState<EmailMusterConfig | null>(null);
  const reload = () => void window.api.emailMuster.status().then(setS);
  useEffect(() => {
    reload();
    const off = window.api.emailMuster.onChanged(() => reload());
    return () => off();
  }, []);
  if (!s) {
    return (
      <section className="provider-section" id="email-muster-section">
        <h3>E-Mail-Ableitung</h3>
        <p className="muted">Lädt…</p>
      </section>
    );
  }
  return (
    <section className="provider-section alerts-prefs" id="email-muster-section">
      <h3>E-Mail-Ableitung</h3>
      <p className="muted">
        Direkt nach dem Kontaktlauf einer Firma leitet AVA aus bekannten persönlichen Adressen das Adressmuster ab und bildet Adressen für alle Kontakte ohne E-Mail.
        Firmenadressen mit Namen (etwa pdettlev@…) werden der passenden Person zugeordnet und zählen als Beleg. Jede gebildete Adresse wird einzeln per Mail-Server-Anfrage
        auf Existenz geprüft, ohne eine E-Mail zu senden: „abgeleitet · verifiziert“. Nimmt ein Mailserver jede Adresse an (Catch-all), heißt sie „abgeleitet · unbestätigt“.
        Ist die Prüfung in diesem Netz nicht möglich oder bleibt sie ohne Antwort, wird die Adresse trotzdem gespeichert, als „abgeleitet · unverifiziert“ mit Verweis auf die Baseline-Adresse.
        Eine eingehende Antwort bestätigt sie, eine Unzustellbarkeitsmeldung entfernt sie wieder. Das Ergebnis je Firma steht in der Status-Matrix (Spalte „E-Mail“);
        dort lässt sich die Stufe jederzeit neu starten.
      </p>
      <div className="alerts-prefs__row">
        <label className="alerts-prefs__check">
          <input type="checkbox" checked={s.enabled} onChange={(e) => void window.api.emailMuster.setConfig({ enabled: e.target.checked }).then(() => reload())} />
          <span>E-Mail-Ableitung aktiv</span>
        </label>
        <label className="alerts-prefs__check">
          <input type="checkbox" disabled={!s.enabled} checked={s.zuordnungAktiv !== false} onChange={(e) => void window.api.emailMuster.setConfig({ zuordnungAktiv: e.target.checked }).then(() => reload())} />
          <span>Firmenadressen Personen zuordnen (mit KI-Urteil)</span>
        </label>
        <label className="alerts-prefs__check">
          <input type="checkbox" disabled={!s.enabled} checked={s.ungeprueftAnzeigen !== false} onChange={(e) => void window.api.emailMuster.setConfig({ ungeprueftAnzeigen: e.target.checked }).then(() => reload())} />
          <span>Unverifizierte Ableitungen anzeigen</span>
        </label>
      </div>
    </section>
  );
}

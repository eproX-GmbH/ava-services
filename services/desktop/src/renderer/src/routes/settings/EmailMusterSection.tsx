// Einstellungen: E-Mail-Ableitung. Seit 2026-10-12 ohne Hintergrund-Job; die
// Verifizierung laeuft als Pipeline-Stufe „E-Mail“ je Firma (Status-Matrix).
import { useEffect, useState } from "react";
import { PRUEFUNGEN_JE_STUNDE, type EmailMusterConfig } from "../../../../shared/email-muster-types";

export function EmailMusterSection() {
  const [s, setS] = useState<EmailMusterConfig | null>(null);
  const [rate, setRate] = useState<string>("");
  const reload = () => void window.api.emailMuster.status().then((c) => {
    setS(c);
    setRate(String(c?.pruefungenJeStunde ?? PRUEFUNGEN_JE_STUNDE.standard));
  });
  const rateSpeichern = () => {
    const n = Number(rate);
    if (!Number.isFinite(n) || n === (s?.pruefungenJeStunde ?? PRUEFUNGEN_JE_STUNDE.standard)) return;
    void window.api.emailMuster.setConfig({ pruefungenJeStunde: n }).then(() => reload());
  };
  useEffect(() => {
    reload();
    const off = window.api.emailMuster.onChanged(() => reload());
    return () => off();
  }, []);
  if (!s) {
    return (
      <section className="provider-section" id="email-muster-section">
        <h3>E-Mail-Adressen</h3>
      <p className="muted">
        Fehlt einem Kontakt die Mailadresse, leitet AVA sie aus dem Muster der Firma ab, etwa vorname.nachname@firma.de, und fragt beim Mail-Server nach, ob es sie gibt, ohne eine Mail zu senden. Bestätigte Adressen heißen „verifiziert“, unsichere „unbestätigt“.
      </p>
      </section>
    );
  }
  return (
    <section className="provider-section alerts-prefs" id="email-muster-section">
      <h3>E-Mail-Adressen</h3>
      <p className="muted">
        Direkt nach dem Kontaktlauf einer Firma leitet AVA aus bekannten persönlichen Adressen das Adressmuster ab und bildet Adressen für alle Kontakte ohne E-Mail.
        Firmenadressen mit Namen (etwa pdettlev@…) werden der passenden Person zugeordnet und zählen als Beleg. Jede gebildete Adresse wird einzeln per Mail-Server-Anfrage
        auf Existenz geprüft, ohne eine E-Mail zu senden: „abgeleitet · verifiziert“. Nimmt ein Mailserver jede Adresse an (Catch-all), heißt sie „abgeleitet · unbestätigt“.
        Ist die Prüfung in diesem Netz nicht möglich oder bleibt sie ohne Antwort, wird die Adresse trotzdem gespeichert, als „abgeleitet · unverifiziert“ mit Verweis auf die Baseline-Adresse.
        Eine eingehende Antwort bestätigt sie, eine Unzustellbarkeitsmeldung entfernt sie wieder. Das Ergebnis je Firma steht in der Status-Matrix (Spalte „E-Mail“);
        dort lässt sich die Stufe jederzeit neu starten.
      </p>
      <div className="alerts-prefs__row alerts-prefs__row--spalte">
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
      <div className="alerts-prefs__row">
        <label className="alerts-prefs__check" title="Wie oft AVA je Stunde beim Mail-Server einer Firma nachfragt, gleichmäßig verteilt (bei 300 alle 12 Sekunden einmal). Höher ist schneller, belastet aber fremde Mail-Server stärker.">
          <span>Verifizierungsrate</span>
          <input
            type="number"
            min={PRUEFUNGEN_JE_STUNDE.min}
            max={PRUEFUNGEN_JE_STUNDE.max}
            step={10}
            value={rate}
            disabled={!s.enabled}
            style={{ width: 90, marginLeft: 8 }}
            onChange={(e) => setRate(e.target.value)}
            onBlur={rateSpeichern}
            onKeyDown={(e) => {
              if (e.key === "Enter") rateSpeichern();
            }}
          />
          <span className="muted small" style={{ marginLeft: 6 }}>Anfragen je Stunde, gleichmäßig verteilt (Standard {PRUEFUNGEN_JE_STUNDE.standard})</span>
        </label>
      </div>
    </section>
  );
}

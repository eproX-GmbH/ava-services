// v0.1.650 (docs/PLAN_CHAT_VORSCHLAEGE.md, V5) — Einstellungen: Vorschlaege im Chat.
import { useEffect, useState } from "react";

export function VorschlaegeSection() {
  const [s, setS] = useState<{ startseite: boolean; gespraech: boolean; orgErlaubt: boolean } | null>(null);
  useEffect(() => {
    void window.api.suggestions.getSettings().then(setS);
  }, []);
  if (!s) return null;
  const setze = (patch: { startseite?: boolean; gespraech?: boolean }) => void window.api.suggestions.setSettings(patch).then(setS);
  return (
    <section className="provider-section alerts-prefs" id="vorschlaege-section">
      <h3>Vorschläge im Chat</h3>
      <p className="muted">
        AVA schlägt dir passende nächste Schritte vor: auf der leeren Chat-Seite und unter der Willkommensnachricht, sowie nach einer Antwort, wenn sich
        aus dem Gespräch ein Schritt anbietet. Die Vorschläge entstehen mit dem Hintergrund-Modell aus dem, was du bereits eingerichtet hast; Erledigtes wird
        nicht vorgeschlagen.
      </p>
      {!s.orgErlaubt && <p className="muted small">Deine Organisation hat Vorschläge abgeschaltet. Es erscheint nur eine feste Liste ohne KI-Aufruf.</p>}
      <div className="alerts-prefs__row">
        <label className="alerts-prefs__check">
          <input type="checkbox" checked={s.startseite} disabled={!s.orgErlaubt} onChange={(e) => setze({ startseite: e.target.checked })} />
          <span>Auf der Startseite</span>
        </label>
      </div>
      <div className="alerts-prefs__row">
        <label className="alerts-prefs__check">
          <input type="checkbox" checked={s.gespraech} disabled={!s.orgErlaubt} onChange={(e) => setze({ gespraech: e.target.checked })} />
          <span>Im Gespräch nach einer Antwort</span>
        </label>
      </div>
    </section>
  );
}

// Sprachmodus — Einstellung (docs/PLAN_SPRACHMODUS.md, S0). Stimme ist fest
// "marin" (Entscheidung 2026-09-24: AVA hat immer dieselbe Stimme).

import { useEffect, useState } from "react";
import { Link } from "react-router-dom";
import type { SpracheStand } from "../../../../shared/types";
import { useFeature } from "../../store/policy";

export function SprachmodusSection() {
  const erlaubt = useFeature("sprachmodus");
  const [stand, setStand] = useState<SpracheStand | null>(null);
  useEffect(() => {
    void window.api.sprache.stand().then(setStand);
    return window.api.sprache.onStandChanged(setStand);
  }, []);
  if (!erlaubt || !stand) return null;
  const e = stand.einstellungen;
  const setzen = (teil: Partial<typeof e>) => void window.api.sprache.setzen(teil).then(setStand);
  return (
    <section className="provider-section alerts-prefs" id="sprachmodus-section">
      <h3>Mit AVA sprechen</h3>
      <p className="muted">
        Sprich mit AVA statt zu tippen. Sie hört zu, antwortet mit ihrer Stimme und kann dabei alles, was sie im Chat kann. Gesprächsminuten kosten mehr als Chat, grob 0,20 bis 0,40 Euro je Minute; nach einer Weile Stille geht AVA in den Ruhezustand.
      </p>
      {!stand.verfuegbar ? (
        stand.hinweis ? (
          <p className="muted">{stand.hinweis}</p>
        ) : (
          <p className="muted">Dafür fehlt ein OpenAI-Schlüssel: <Link to="/settings#provider-section">in der Modell-Konfiguration hinterlegen</Link>.</p>
        )
      ) : (
        <>
          <label className="alerts-prefs__row">
            <input type="checkbox" checked={e.aktiv} onChange={(ev) => setzen({ aktiv: ev.target.checked })} />
            <span>Sprachmodus aktivieren <span className="muted small">(läuft {stand.quelle === "organisation" ? "über den Schlüssel der Organisation" : "über deinen OpenAI-Schlüssel"})</span></span>
          </label>
          {e.aktiv && (
            <>
              <label className="alerts-prefs__row">
                <input type="checkbox" checked={e.wachwort} onChange={(ev) => setzen({ wachwort: ev.target.checked })} disabled={!stand.whisperBereit} />
                <span>Aktivierungswort „Hey AVA“ im Ruhezustand{!stand.whisperBereit && <span className="muted small"> (braucht das lokale Sprachmodell, siehe unten)</span>}</span>
              </label>
              <label className="alerts-prefs__row">
                <input type="checkbox" checked={e.signalton} onChange={(ev) => setzen({ signalton: ev.target.checked })} />
                <span>Signalton beim Aktivieren</span>
              </label>
              <p className="muted small">Stimme: Marin. Ruhezustand nach {e.ruheSekunden} Sekunden Stille.</p>
            </>
          )}
        </>
      )}
    </section>
  );
}

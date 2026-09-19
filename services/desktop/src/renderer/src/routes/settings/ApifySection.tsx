// Apify-Zugang in den Einstellungen (2026-09-19).
//
// Den eigenen Token gab es bisher nur im LinkedIn-Bereich unter
// "Personen-Watchlist" — dort war er historisch zuerst gebraucht worden.
// Gesucht wurde er in den Einstellungen, und dort fehlte er: Der Betreiber
// hatte in seiner Organisation eigene Token erlaubt und fand trotzdem keine
// Stelle, um einen zu hinterlegen. Beides zeigt auf dieselbe Sache, der
// Token liegt nur einmal.
import { useCallback, useEffect, useState } from "react";

type Zustand = {
  hasKey?: boolean;
  apifyQuelle?: "eigen" | "organisation" | null;
  apifyVerfuegbar?: boolean;
  eigenerTokenErlaubt?: boolean;
};

export function ApifySection() {
  const [s, setS] = useState<Zustand | null>(null);
  const [eingabe, setEingabe] = useState("");
  const [busy, setBusy] = useState(false);
  const [meldung, setMeldung] = useState<string | null>(null);
  const [fehler, setFehler] = useState<string | null>(null);

  const laden = useCallback(async () => {
    const r = await window.api.linkedin.watchlist.getState();
    setS(r as Zustand);
  }, []);

  useEffect(() => {
    void laden();
  }, [laden]);

  const fuehreAus = async (fn: () => Promise<string | { error: string }>) => {
    setBusy(true);
    setMeldung(null);
    setFehler(null);
    try {
      const r = await fn();
      if (typeof r === "string") setMeldung(r);
      else setFehler(r.error);
    } catch (e) {
      setFehler(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
      await laden();
    }
  };

  if (!s) return null;

  const ueberOrg = s.apifyQuelle === "organisation";
  const eigenerErlaubt = s.eigenerTokenErlaubt !== false;
  const hatEigenen = s.hasKey === true;

  return (
    <section className="provider-section alerts-prefs" id="apify-section">
      <h3>Apify</h3>
      <p className="muted">
        Apify liefert die Mitarbeitersuche über LinkedIn-Firmenprofile. Ohne
        Zugang sucht AVA Ansprechpartner nur über die Websuche — die findet
        weniger und liefert oft ältere Angaben.
      </p>

      {s.apifyVerfuegbar ? (
        <p className="muted small">
          {ueberOrg
            ? "Zugang über den Token deiner Organisation."
            : "Zugang über deinen eigenen Token."}
        </p>
      ) : (
        <p className="muted small">
          Kein Zugang hinterlegt — weder bei dir noch in deiner Organisation.
        </p>
      )}

      {!eigenerErlaubt ? (
        <p className="muted small">
          Deine Organisation gibt den eigenen Token vor. Ein eigener lässt sich
          deshalb nicht hinterlegen.
        </p>
      ) : hatEigenen ? (
        <div className="telegram-row">
          <span className="pill pill--connected">Eigener Token hinterlegt</span>
          <button
            type="button"
            className="btn"
            disabled={busy}
            onClick={() =>
              void fuehreAus(async () => {
                const r = await window.api.linkedin.watchlist.verifyKey();
                return r.ok
                  ? `✓ ${r.detail ?? "Zugang gültig"}`
                  : { error: r.detail ?? "Zugang ungültig" };
              })
            }
          >
            Zugang testen
          </button>
          <button
            type="button"
            className="btn"
            disabled={busy}
            onClick={() =>
              void fuehreAus(async () => {
                const r = await window.api.linkedin.watchlist.clearKey();
                return r.ok
                  ? "Token entfernt."
                  : { error: "Token konnte nicht entfernt werden." };
              })
            }
          >
            Entfernen
          </button>
        </div>
      ) : (
        <div className="telegram-row">
          <input
            type="password"
            className="telegram-input"
            placeholder={
              ueberOrg
                ? "Optional: eigener Apify-Token statt des Organisations-Tokens"
                : "Apify-API-Token (apify.com → Settings → Integrations)"
            }
            value={eingabe}
            disabled={busy}
            onChange={(e) => setEingabe(e.target.value)}
          />
          <button
            type="button"
            className="btn"
            disabled={busy || eingabe.trim().length < 10}
            onClick={() =>
              void fuehreAus(async () => {
                const r = await window.api.linkedin.watchlist.setKey(eingabe);
                if (r.ok) setEingabe("");
                return r.ok
                  ? "Token gespeichert."
                  : { error: r.error ?? "Token konnte nicht gespeichert werden." };
              })
            }
          >
            Speichern
          </button>
        </div>
      )}

      {ueberOrg && eigenerErlaubt && !hatEigenen && (
        <p className="muted small">
          Hinterlegst du einen eigenen Token, hat er Vorrang; der Token der
          Organisation bleibt der Rückfall.
        </p>
      )}

      {meldung && <p className="muted small">{meldung}</p>}
      {fehler && <p className="error small">{fehler}</p>}
    </section>
  );
}

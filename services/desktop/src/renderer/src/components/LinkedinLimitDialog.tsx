// docs/PLAN_PRICING_TIERS.md P6 — Beim ersten Einschalten einer LinkedIn-Beobachtung
// (beobachtete Posts, beobachtete Personen) muss ein Monatslimit stehen, weil die
// Beobachtung nach Verbrauch berechnet wird. `linkedinLimitSicherstellen()` prueft den
// Stand im Gateway und oeffnet bei Bedarf diesen Dialog mit Preisen und Limit-Eingabe.
// Ohne Sitz-Modell (Route 404) oder mit gesetztem Limit loest es sofort mit true auf.
import { useEffect, useState } from "react";
import { gatewayFetch, GatewayError } from "../api/gateway";

interface Stand { limitCents: number | null; enterprise: boolean; imVertrag: boolean; preise?: Array<{ schluessel: string; einheit: string; centsJe1000: number }> }
type Anfrage = { stand: Stand; antwort: (ok: boolean) => void };
let hostSetzer: ((a: Anfrage | null) => void) | null = null;
const eur = (c: number) => (c / 100).toLocaleString("de-DE", { style: "currency", currency: "EUR" });

export async function linkedinLimitSicherstellen(): Promise<boolean> {
  let stand: Stand;
  try {
    stand = await gatewayFetch<Stand>("/v1/usage/linkedin");
  } catch (e) {
    if (e instanceof GatewayError && (e.status === 404 || e.status === 403)) return true; // Schalter aus oder keine Rechte: alter Weg
    return true;
  }
  if (stand.enterprise || stand.limitCents != null) return true;
  if (!hostSetzer) return true;
  const setzer = hostSetzer;
  return new Promise((resolve) => setzer({ stand, antwort: resolve }));
}

export function LinkedinLimitDialogHost() {
  const [anfrage, setAnfrage] = useState<Anfrage | null>(null);
  const [wert, setWert] = useState("20");
  const [laeuft, setLaeuft] = useState(false);
  const [fehler, setFehler] = useState<string | null>(null);
  useEffect(() => {
    hostSetzer = setAnfrage;
    return () => { if (hostSetzer === setAnfrage) hostSetzer = null; };
  }, []);
  if (!anfrage) return null;
  const schliessen = (ok: boolean) => { anfrage.antwort(ok); setAnfrage(null); setFehler(null); };
  const speichern = async () => {
    const n = Number(wert.replace(",", "."));
    if (!Number.isFinite(n) || n <= 0) { setFehler("Bitte einen Betrag in Euro eingeben."); return; }
    setLaeuft(true);
    try {
      await gatewayFetch("/v1/usage/linkedin-limit", { method: "PUT", body: { limitCents: Math.round(n * 100) } });
      schliessen(true);
    } catch (e) {
      setFehler(e instanceof Error ? e.message : String(e));
    } finally {
      setLaeuft(false);
    }
  };
  return (
    <div className="ek-dialog__hintergrund" role="presentation" onClick={() => schliessen(false)}>
      <div className="ek-dialog" role="dialog" aria-modal="true" aria-labelledby="ll-titel" onClick={(e) => e.stopPropagation()}>
        <h4 id="ll-titel">Monatslimit für die LinkedIn-Beobachtung</h4>
        <div className="ek-dialog__text">
          <p>Beobachtete Posts und Personen werden nach Verbrauch berechnet und kommen mit der nächsten Rechnung eurer Organisation. Lege fest, wie viel das im Monat höchstens kosten darf.</p>
          {anfrage.stand.preise && anfrage.stand.preise.length > 0 && (
            <ul className="muted small">
              {anfrage.stand.preise.map((p) => <li key={p.schluessel}>{eur(p.centsJe1000)} je 1.000 {p.einheit}</li>)}
            </ul>
          )}
          <div className="u-row">
            <label className="muted small" htmlFor="ll-limit">Monatslimit</label>
            <input id="ll-limit" type="text" inputMode="decimal" value={wert} onChange={(e) => setWert(e.target.value)} style={{ width: "7rem" }} autoFocus />
            <span className="muted small">€</span>
          </div>
          {fehler && <p className="error">{fehler}</p>}
        </div>
        <div className="ek-dialog__aktionen">
          <button type="button" className="btn" onClick={() => schliessen(false)} disabled={laeuft}>Abbrechen</button>
          <button type="button" className="btn btn--primaer" onClick={() => void speichern()} disabled={laeuft}>{laeuft ? "Bitte warten …" : "Limit setzen und einschalten"}</button>
        </div>
      </div>
    </div>
  );
}

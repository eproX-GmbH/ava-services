// docs/PLAN_PRICING_TIERS.md P6 — Aufnahme-Dialog, wenn das Kontingent nicht reicht
// (402 kontingent_erschoepft / firmen_limit aus dem Gateway). Drei Wege: Plan
// ändern (nur wer darf), nur die passenden Firmen aufnehmen (wenn das Gateway
// Firmen-IDs kennt), abbrechen. Hört auf das Fenster-Ereignis aus api/gateway.ts;
// einmal in der AppShell einhängen.
import { useEffect, useState } from "react";
import { useNavigate } from "react-router-dom";
import { useQueryClient } from "@tanstack/react-query";
import { gatewayFetch, type KontingentErschoepftDetail } from "../api/gateway";

const eur = (c: number) => (c / 100).toLocaleString("de-DE", { style: "currency", currency: "EUR" });
const PLAN_NAME: Record<string, string> = { pro: "Pro", max: "Max", ultra: "Ultra", free: "Free", enterprise: "Enterprise" };

export function KontingentDialogHost() {
  const [detail, setDetail] = useState<KontingentErschoepftDetail | null>(null);
  const [laeuft, setLaeuft] = useState(false);
  const [fehler, setFehler] = useState<string | null>(null);
  const navigate = useNavigate();
  const qc = useQueryClient();
  useEffect(() => {
    const h = (e: Event) => { setFehler(null); setDetail((e as CustomEvent<KontingentErschoepftDetail>).detail); };
    window.addEventListener("ava:kontingent-erschoepft", h);
    return () => window.removeEventListener("ava:kontingent-erschoepft", h);
  }, []);
  if (!detail) return null;
  const schliessen = () => setDetail(null);
  const nurPassende = async () => {
    setLaeuft(true);
    setFehler(null);
    try {
      await gatewayFetch<{ transactionId: string }>("/v1/imports/by-ids", { method: "POST", body: { companyIds: detail.passenNoch, transactionName: `Aufnahme (${detail.passenNoch.length} Firmen, Kontingent)` } });
      void qc.invalidateQueries({ queryKey: ["usage"] });
      schliessen();
    } catch (e) {
      setFehler(e instanceof Error ? e.message : String(e));
    } finally {
      setLaeuft(false);
    }
  };
  const firmenLimit = detail.error === "firmen_limit";
  return (
    <div className="ek-dialog__hintergrund" role="presentation" onClick={schliessen}>
      <div className="ek-dialog" role="dialog" aria-modal="true" aria-labelledby="kontingent-titel" onClick={(e) => e.stopPropagation()}>
        <h4 id="kontingent-titel">{firmenLimit ? "Firmen-Limit erreicht" : "Dein Kontingent reicht nicht"}</h4>
        <p>{detail.meldung}</p>
        {!firmenLimit && detail.kontingentCents != null && (
          <p className="muted small">
            Plan {PLAN_NAME[detail.plan] ?? detail.plan}: {eur(detail.verbrauchtCents)} von {eur(detail.kontingentCents)} genutzt, benötigt {eur(detail.benoetigtCents)}.
          </p>
        )}
        <div className="kontingent-dialog__optionen">
          {!firmenLimit && detail.naechsterPlan && detail.kannSelbstWechseln && (
            <button type="button" className="btn btn--primaer" onClick={() => { schliessen(); navigate("/settings#plan-section"); }}>
              Auf {PLAN_NAME[detail.naechsterPlan] ?? detail.naechsterPlan} wechseln und alle aufnehmen
            </button>
          )}
          {!firmenLimit && detail.naechsterPlan && !detail.kannSelbstWechseln && (
            <button type="button" className="btn" onClick={() => { schliessen(); navigate("/settings#plan-section"); }}>
              Owner oder Admin um {PLAN_NAME[detail.naechsterPlan] ?? detail.naechsterPlan} bitten
            </button>
          )}
          {!firmenLimit && detail.paygMoeglich && detail.kannSelbstWechseln && (
            <button type="button" className="btn" onClick={() => { schliessen(); navigate("/settings#plan-section"); }}>
              Für diesen Monat über das Kontingent hinaus freigeben
            </button>
          )}
          {detail.passenNoch.length > 0 && (
            <button type="button" className="btn" disabled={laeuft} onClick={() => void nurPassende()}>
              {laeuft ? "Wird aufgenommen…" : `Nur ${detail.passenNoch.length} passende Firmen aufnehmen`}
            </button>
          )}
          <button type="button" className="btn" onClick={schliessen}>Abbrechen</button>
        </div>
        {fehler && <p className="error">{fehler}</p>}
      </div>
    </div>
  );
}

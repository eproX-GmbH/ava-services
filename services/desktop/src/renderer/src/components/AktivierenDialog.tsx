// docs/PLAN_PRICING_TIERS.md P10 — Blatt, wenn eine Firma aktiviert werden soll,
// aber das Kontingent voll ist. Drei Wege: Plan wechseln (wer darf; Ultra:
// Freigabe über das Kontingent hinaus), ab Monatswechsel aktivieren (mit
// Tauschvorschlag, welche aktiven Firmen dafür ruhen), Admin bitten. Free:
// nur der Weg zu Pro, weil Aktivierungen dort auf Lebenszeit zählen.
import { useState } from "react";
import { useNavigate } from "react-router-dom";
import { useQueryClient } from "@tanstack/react-query";
import type { KontingentErschoepftDetail } from "../api/gateway";
import { firmaAktivieren, monatsersterText, useZustandUebersicht } from "../api/firmen-zustand";

const eur = (c: number) => (c / 100).toLocaleString("de-DE", { style: "currency", currency: "EUR" });
const PLAN_NAME: Record<string, string> = { pro: "Pro", max: "Max", ultra: "Ultra", free: "Free", enterprise: "Enterprise" };

export interface AktivierenAnfrage {
  companyId: string;
  name: string;
  ablehnung: KontingentErschoepftDetail;
}

export function AktivierenDialog({ anfrage, onSchliessen, onFertig }: { anfrage: AktivierenAnfrage; onSchliessen: () => void; onFertig?: (meldung: string) => void }) {
  const navigate = useNavigate();
  const qc = useQueryClient();
  const uebersicht = useZustandUebersicht();
  const [tausch, setTausch] = useState<Set<string>>(new Set());
  const [laeuft, setLaeuft] = useState(false);
  const [fehler, setFehler] = useState<string | null>(null);
  const a = anfrage.ablehnung;
  const istFree = a.plan === "free";
  const naechster = uebersicht.data?.naechsterMonat ?? "";
  const vorschlaege = (uebersicht.data?.tauschvorschlaege ?? []).filter((v) => v.companyId !== anfrage.companyId).slice(0, 6);

  const vormerken = async () => {
    setLaeuft(true);
    setFehler(null);
    try {
      await firmaAktivieren(anfrage.companyId, { ab: "monatswechsel", tausch: [...tausch], quelle: "tausch" });
      void qc.invalidateQueries({ queryKey: ["firmen-zustand"] });
      void qc.invalidateQueries({ queryKey: ["companies-matrix"] });
      onFertig?.(`${anfrage.name} wird ab ${monatsersterText(naechster)} aktiv${tausch.size > 0 ? `, ${tausch.size} ${tausch.size === 1 ? "Firma ruht" : "Firmen ruhen"} dann` : ""}.`);
      onSchliessen();
    } catch (e) {
      setFehler(e instanceof Error ? e.message : String(e));
    } finally {
      setLaeuft(false);
    }
  };

  return (
    <div className="ek-dialog__hintergrund" role="presentation" onClick={onSchliessen}>
      <div className="ek-dialog" role="dialog" aria-modal="true" aria-labelledby="aktivieren-titel" onClick={(e) => e.stopPropagation()}>
        <h4 id="aktivieren-titel">{istFree ? "Deine 25 Aktivierungen sind aufgebraucht" : "Dein Kontingent ist diesen Monat voll"}</h4>
        <p>{a.meldung}</p>
        {!istFree && a.kontingentCents != null && (
          <p className="muted small">
            Plan {PLAN_NAME[a.plan] ?? a.plan}: {eur(a.verbrauchtCents)} von {eur(a.kontingentCents)} genutzt, {anfrage.name} braucht {eur(a.benoetigtCents)}.
          </p>
        )}
        <div className="kontingent-dialog__optionen">
          {a.naechsterPlan && a.kannSelbstWechseln && (
            <button type="button" className="btn btn--primaer" onClick={() => { onSchliessen(); navigate("/settings#plan-section"); }}>
              {istFree ? "Pro ansehen" : `Auf ${PLAN_NAME[a.naechsterPlan] ?? a.naechsterPlan} wechseln und sofort aktivieren`}
            </button>
          )}
          {a.paygMoeglich && a.kannSelbstWechseln && (
            <button type="button" className="btn" onClick={() => { onSchliessen(); navigate("/settings#plan-section"); }}>
              Über das Kontingent hinaus freigeben (nur diesen Monat)
            </button>
          )}
          {a.naechsterPlan && !a.kannSelbstWechseln && (
            <button type="button" className="btn" onClick={() => { onSchliessen(); navigate("/settings#plan-section"); }}>
              Owner oder Admin um {PLAN_NAME[a.naechsterPlan] ?? a.naechsterPlan} bitten
            </button>
          )}
        </div>
        {!istFree && (
          <div className="aktivieren-dialog__tausch">
            <h5>Oder ab {naechster ? monatsersterText(naechster) : "dem nächsten Monat"} aktivieren</h5>
            <p className="muted small">
              Ruhend gesetzte Firmen zählen bis Monatsende weiter; ab dem 1. ist der Platz frei. Wähle aus, was dafür ruhen soll.
              {vorschlaege.length > 0 ? " Vorschlag: lange nicht angefasst, kein Buying Center." : ""}
            </p>
            {vorschlaege.length > 0 && (
              <ul className="aktivieren-dialog__liste">
                {vorschlaege.map((v) => (
                  <li key={v.companyId}>
                    <label>
                      <input
                        type="checkbox"
                        checked={tausch.has(v.companyId)}
                        onChange={(e) => {
                          const n = new Set(tausch);
                          if (e.target.checked) n.add(v.companyId); else n.delete(v.companyId);
                          setTausch(n);
                        }}
                      />{" "}
                      {v.name ?? v.companyId}
                      {v.aktivSeit ? <span className="muted small"> · aktiv seit {new Date(v.aktivSeit).toLocaleDateString("de-DE")}</span> : null}
                    </label>
                  </li>
                ))}
              </ul>
            )}
            <button type="button" className="btn" disabled={laeuft} onClick={() => void vormerken()}>
              Ab {naechster ? monatsersterText(naechster) : "nächstem Monat"} aktivieren{tausch.size > 0 ? ` und ${tausch.size} ruhen lassen` : ""}
            </button>
          </div>
        )}
        {fehler && <p className="error">{fehler}</p>}
        <div className="ek-dialog__aktionen">
          <button type="button" className="btn" onClick={onSchliessen}>Abbrechen</button>
        </div>
      </div>
    </div>
  );
}

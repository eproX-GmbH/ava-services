// Hintergrundaufgaben im Chat (docs/PLAN_HINTERGRUNDAUFGABEN.md, 2026-10-03).
// 2026-10-04 (Nutzerwunsch): Die Karte steht im VERLAUF hinter dem Schritt,
// der die Verarbeitung gestartet hat (ankerToolCallId), und scrollt mit. Sie
// bleibt dort auch nach dem Abschluss stehen wie eine Nachricht.
import { useEffect, useState } from "react";

export interface AufgabeAnzeige {
  id: string;
  conversationId: string;
  transactionId: string;
  titel: string;
  status: "laeuft" | "fertig" | "abgebrochen" | "nicht_verfolgt";
  ankerToolCallId?: string;
  gestartet: number;
  stand: { total: number; fertig: number; abgeschlossen: number; fehlgeschlagen: number; uebersprungen: number; laufend: number; offeneSchritte?: number; letztesLebenszeichen?: string | null } | null;
  fortschrittAm?: number;
  gemeldet: boolean;
  letzterFehler: string | null;
}

type AufgabenApi = {
  liste: (conversationId?: string) => Promise<AufgabeAnzeige[]>;
  abbrechen: (id: string) => Promise<boolean>;
  onAenderung: (cb: (liste: AufgabeAnzeige[]) => void) => () => void;
};

function api(): AufgabenApi | null {
  return (window as unknown as { api?: { aufgaben?: AufgabenApi } }).api?.aufgaben ?? null;
}

function dauer(ms: number): string {
  const min = Math.floor(ms / 60_000);
  if (min < 1) return "gerade gestartet";
  if (min < 60) return `seit ${min} Min.`;
  return `seit ${Math.floor(min / 60)} Std. ${min % 60} Min.`;
}

/** Alle Aufgaben einer Unterhaltung, live aktualisiert. */
export function useAufgaben(conversationId: string): AufgabeAnzeige[] {
  const [liste, setListe] = useState<AufgabeAnzeige[]>([]);
  const [, setTick] = useState(0);
  useEffect(() => {
    const a = api();
    if (!a || !conversationId) {
      setListe([]);
      return;
    }
    let aktiv = true;
    void a.liste(conversationId).then((l) => {
      if (aktiv) setListe(l);
    });
    const ab = a.onAenderung((alle) => {
      setListe(alle.filter((x) => x.conversationId === conversationId));
    });
    // Dauer-Anzeige jede Minute auffrischen.
    const t = setInterval(() => setTick((n) => n + 1), 60_000);
    return () => {
      aktiv = false;
      ab();
      clearInterval(t);
    };
  }, [conversationId]);
  return liste;
}

/** Karten fuer eine Stelle im Verlauf. */
export function AufgabenKarten({ liste }: { liste: AufgabeAnzeige[] }) {
  if (liste.length === 0) return null;
  return (
    <div className="auf-leiste auf-leiste--verlauf" role="status" aria-live="polite">
      {liste.map((a) => {
        const s = a.stand;
        const pct = s && s.total > 0 ? Math.round((s.fertig / s.total) * 100) : 0;
        const laeuft = a.status === "laeuft";
        return (
          <div key={a.id} className={`auf-item auf-item--${a.status}`}>
            <span className="auf-item__punkt" aria-hidden />
            <div className="auf-item__text">
              <div className="auf-item__titel">{a.titel}</div>
              <div className="auf-item__stand">
                {laeuft && !s && "Stand wird geladen …"}
                {laeuft && s && `${s.fertig} von ${s.total} Firmen fertig${s.fehlgeschlagen > 0 ? `, ${s.fehlgeschlagen} mit Fehler` : ""} · ${dauer(Date.now() - a.gestartet)}`}
                {laeuft && s && a.fortschrittAm && Date.now() - a.fortschrittAm > 15 * 60_000 && ` · seit ${Math.floor((Date.now() - a.fortschrittAm) / 60_000)} Min. keine Bewegung`}
                {a.status === "fertig" && s && `Fertig: ${s.fertig} von ${s.total} verarbeitet${s.fehlgeschlagen > 0 ? `, ${s.fehlgeschlagen} mit Fehler` : ""}${a.gemeldet ? "" : " · Ergebnis folgt"}`}
                {a.status === "abgebrochen" && "Abgebrochen: 60 Minuten ohne jeden Fortschritt"}
                {a.status === "nicht_verfolgt" && "Wird nicht mehr verfolgt"}
                {laeuft && a.letzterFehler && " · Stand gerade nicht abrufbar"}
              </div>
              {(laeuft || a.status === "fertig") && (
                <div className="auf-item__balken" aria-hidden>
                  <div style={{ width: `${a.status === "fertig" ? 100 : pct}%` }} />
                </div>
              )}
            </div>
            {laeuft && (
              <button
                type="button"
                className="auf-item__x"
                title="Nicht mehr verfolgen (die Verarbeitung läuft weiter)"
                aria-label="Nicht mehr verfolgen"
                onClick={() => void api()?.abbrechen(a.id)}
              >
                <svg width="12" height="12" viewBox="0 0 12 12" aria-hidden><path d="M3 3l6 6M9 3l-6 6" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" /></svg>
              </button>
            )}
          </div>
        );
      })}
    </div>
  );
}

/** Notiz des Aufgaben-Waechters fuer die Anzeige kuerzen (ohne Auftrag ans Modell). */
export function aufgabenNotiz(content: string): { haengt: boolean; text: string } | null {
  const m = /^\[Hintergrundaufgabe (abgeschlossen|haengt|abgebrochen)\]\s*([\s\S]*)$/.exec(content.trim());
  if (!m) return null;
  const rest = (m[2] ?? "").split(/\s(?:Melde dem Nutzer|Sag dem Nutzer|\[Hinweis:)/)[0] ?? "";
  const ohneTx = rest.replace(/\s*\(Transaktion [^)]+\)/, "").replace(/\s*Fehlerbeispiele:[\s\S]*$/, "");
  return { haengt: m[1] !== "abgeschlossen", text: ohneTx.trim() };
}

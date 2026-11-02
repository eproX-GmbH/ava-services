// docs/PLAN_PRICING_TIERS.md P6 — Meldungen zum Monatskontingent und zum LinkedIn-Limit:
// bei 80 % und 100 % je Monat einmal (Dedupe ueber sourceRef im AlertsStore). Prueft
// nach dem Start und dann alle sechs Stunden; ohne Sitz-Modell (kein `kontingent`
// im Verbrauch) passiert nichts.
import type { AlertsStore } from "../agent/alerts-store";
import type { Alert } from "../../shared/types";

interface Gateway { request<T>(path: string, init?: { signal?: AbortSignal }): Promise<T> }
interface Usage {
  kontingent?: { plan: string; kontingentCents: number | null; verbrauchtCents: number; payg: { freigegeben: boolean; moeglich: boolean } } | null;
  kannSelbstWechseln?: boolean;
}
interface Linkedin { limitCents: number | null; verbrauchtCents: number; enterprise: boolean }
// P10 — Uebersicht aktiv/ruhend fuer die Monatsende-Meldung „Tauschen?“.
interface ZustandUebersicht {
  aktivModell: boolean;
  aktiv: number;
  ruhend: number;
  geplantAktiv: Array<{ companyId: string }>;
  tauschvorschlaege: Array<{ companyId: string; name: string | null; aktivSeit: string | null }>;
  free: { genutzt: number; limit: number } | null;
}
const TAGE_90 = 90 * 86_400_000;

const eur = (c: number) => (c / 100).toLocaleString("de-DE", { style: "currency", currency: "EUR" });

export function startKontingentWaechter(deps: { gateway: Gateway; alerts: AlertsStore; notify: (a: Alert) => void; isSignedIn: () => boolean }): () => void {
  const pruefen = async (): Promise<void> => {
    if (!deps.isSignedIn()) return;
    const monat = new Date().toISOString().slice(0, 7);
    const melden = (input: { sourceRef: string; headline: string; rationale: string; severity: "info" | "warn" }) => {
      const a = deps.alerts.add({ tenantId: null, companyId: "", companyName: "Plan & Abrechnung", kind: "reminder", severity: input.severity, headline: input.headline, rationale: input.rationale, sourceRef: input.sourceRef });
      if (a) { try { deps.notify(a); } catch { /* best-effort */ } }
    };
    try {
      const u = await deps.gateway.request<Usage>("/v1/usage");
      const k = u.kontingent;
      if (k && k.kontingentCents != null && k.kontingentCents > 0 && k.plan !== "free" && k.plan !== "enterprise" && !k.payg.freigegeben) {
        const ratio = k.verbrauchtCents / k.kontingentCents;
        const weg = u.kannSelbstWechseln === false ? "Owner oder Admin kann den Plan in der Konsole ändern." : "Plan ändern in Einstellungen → Plan & Abrechnung.";
        if (ratio >= 1) {
          melden({ sourceRef: `kontingent:100:${monat}`, severity: "warn", headline: "Monatskontingent ausgeschöpft", rationale: `${eur(k.verbrauchtCents)} von ${eur(k.kontingentCents)} genutzt. Neue Firmen kannst du erst wieder aufnehmen, wenn der Plan wechselt${k.payg.moeglich ? ", du über das Kontingent hinaus freigibst" : ""} oder der Monat wechselt. ${weg}` });
        } else if (ratio >= 0.8) {
          melden({ sourceRef: `kontingent:80:${monat}`, severity: "info", headline: "Monatskontingent zu 80 % genutzt", rationale: `${eur(k.verbrauchtCents)} von ${eur(k.kontingentCents)}. Reicht das Kontingent nicht mehr, wartet die nächste Aufnahme. ${weg}` });
        }
      }
    } catch { /* Gateway nicht erreichbar oder Schalter aus */ }
    try {
      const l = await deps.gateway.request<Linkedin>("/v1/usage/linkedin");
      if (!l.enterprise && l.limitCents != null && l.limitCents > 0) {
        const ratio = l.verbrauchtCents / l.limitCents;
        if (ratio >= 1) melden({ sourceRef: `linkedin-limit:100:${monat}`, severity: "warn", headline: "LinkedIn-Beobachtung: Monatslimit erreicht", rationale: `${eur(l.verbrauchtCents)} von ${eur(l.limitCents)}. Beobachtungen pausieren bis zum Monatsanfang oder bis das Limit erhöht wird (Einstellungen → Plan & Abrechnung).` });
        else if (ratio >= 0.8) melden({ sourceRef: `linkedin-limit:80:${monat}`, severity: "info", headline: "LinkedIn-Beobachtung: Monatslimit zu 80 % genutzt", rationale: `${eur(l.verbrauchtCents)} von ${eur(l.limitCents)} in diesem Monat.` });
      }
    } catch { /* 404 ohne Schalter */ }
    // P10 — in den letzten drei Tagen des Monats einmal: lange nicht angefasste aktive Firmen
    // gegen ruhende tauschen? Nur mit vollem Kontingent und wenn ruhende Firmen warten.
    try {
      const jetzt = new Date();
      const tageImMonat = new Date(Date.UTC(jetzt.getUTCFullYear(), jetzt.getUTCMonth() + 1, 0)).getUTCDate();
      if (tageImMonat - jetzt.getUTCDate() <= 2) {
        const u = await deps.gateway.request<Usage>("/v1/usage");
        const k = u.kontingent;
        const voll = !!k && k.kontingentCents != null && k.kontingentCents > 0 && k.plan !== "free" && k.plan !== "enterprise" && k.verbrauchtCents >= k.kontingentCents * 0.95;
        if (voll) {
          const z = await deps.gateway.request<ZustandUebersicht>("/v1/firmen/zustand/uebersicht");
          const alt = z.tauschvorschlaege.filter((v) => v.aktivSeit && jetzt.getTime() - new Date(v.aktivSeit).getTime() > TAGE_90);
          if (z.aktivModell && z.ruhend > 0 && alt.length > 0) {
            const namen = alt.slice(0, 3).map((v) => v.name ?? v.companyId).join(", ");
            melden({
              sourceRef: `zustand-tausch:${monat}`,
              severity: "info",
              headline: `${alt.length} aktive ${alt.length === 1 ? "Firma" : "Firmen"} seit 90 Tagen nicht angefasst, ${z.ruhend} ruhende ${z.ruhend === 1 ? "wartet" : "warten"}`,
              rationale: `Zum Beispiel ${namen}. Lässt du sie ruhen, wird ab dem 1. Platz für ruhende Firmen frei. In Meine Firmen: Mond-Knopf an der Firma, oder sag es mir im Chat.`,
            });
          }
        }
      }
    } catch { /* ohne Schalter 404 */ }
  };
  const erst = setTimeout(() => void pruefen(), 3 * 60_000);
  const timer = setInterval(() => void pruefen(), 6 * 60 * 60_000);
  return () => { clearTimeout(erst); clearInterval(timer); };
}

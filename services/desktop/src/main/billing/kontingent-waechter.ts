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
  };
  const erst = setTimeout(() => void pruefen(), 3 * 60_000);
  const timer = setInterval(() => void pruefen(), 6 * 60 * 60_000);
  return () => { clearTimeout(erst); clearInterval(timer); };
}

// Z5 (docs/PLAN_ABRECHNUNG_ZUGANG.md): Abrechnungsstand im Chat — Plan,
// Kontingent, Zugangsguthaben, Aufnahmen nach Stufe, Preise je Stufe.
// Nur lesend; Plan-Wechsel laufen ueber Einstellungen → Plan & Abrechnung.
import * as yup from "yup";
import { defineTool } from "../define-tool";
import type { GatewayClient } from "../gateway-client";
import type { Tool } from "../types";

interface Usage {
  tier: string;
  used: number;
  limit: number;
  remaining: number;
  periodKey: string;
  periodEnd: string | null;
  status: string;
  parkedCount: number;
  entitlement?: { source?: string; paidBy?: string | null; seats?: { count?: number; tier?: string } | null };
  zugang?: { stufen: { klein: number; mittel: number; gross: number; offen: number }; verbrauchtCents: number; guthabenCents: number; uebrigCents: number; ueberschreitungCents: number };
}

const STUFEN_TEXT = "Stufen je Aufnahme: klein 1,00 € (kein LinkedIn-Firmenprofil), mittel 2,00 € (LinkedIn-Profil, bis 100 Personen), gross 3,50 € (ueber 100 Personen). Die Stufe steht nach dem Lauf fest.";

export function buildAbrechnungTools(deps: { gateway: GatewayClient }): Tool[] {
  const status = defineTool({
    name: "abrechnung_status",
    summary: "Plan, Kontingent, Zugangsguthaben und Aufnahmen dieser Periode nach Stufe (klein/mittel/gross) lesen.",
    category: "abrechnung plan guthaben kontingent preise stufe abo free starter pro",
    description:
      "Liest den Abrechnungsstand des Nutzers: Plan (free/starter/pro/enterprise), Kontingent (verbraucht/Deckel), Zugangsguthaben der Periode " +
      "(verbraucht, uebrig, Ueberschreitung als Pay-as-you-go), Aufnahmen nach Stufe und wer zahlt (eigenes Abo oder Seat der Organisation). " +
      STUFEN_TEXT + " Free: 25 Firmen lebenslang ohne LinkedIn-Kontakte. Nur lesend; Upgrade oder Kuendigung laufen ueber Einstellungen → Plan & Abrechnung.",
    parameters: { type: "object", properties: {} },
    schema: yup.object({}).noUnknown(true),
    preview: (r) => {
      const u = r as { tier?: string; aufnahmen?: number; error?: string };
      return u.error ? `Fehler: ${u.error.slice(0, 60)}` : `${u.tier ?? "?"}: ${u.aufnahmen ?? 0} Aufnahmen in dieser Periode`;
    },
    run: async (_args, c) => {
      const u = await deps.gateway.request<Usage>("/v1/usage", { signal: c.signal });
      const eur = (cents: number) => Math.round(cents) / 100;
      const z = u.zugang;
      const aufnahmen = z ? z.stufen.klein + z.stufen.mittel + z.stufen.gross + z.stufen.offen : u.used;
      return {
        tier: u.tier,
        status: u.status,
        periode: u.periodKey === "lifetime" ? "lebenslang (Free)" : u.periodKey === "unlimited" ? "unbegrenzt" : u.periodKey,
        periodenEnde: u.periodEnd,
        kontingent: u.limit === -1 ? { verbraucht: u.used, deckel: "unbegrenzt" } : { verbraucht: u.used, deckel: u.limit, frei: u.remaining },
        geparkt: u.parkedCount,
        bezahltVon: u.entitlement?.source === "seat" ? `Organisation${u.entitlement.paidBy ? ` (${u.entitlement.paidBy})` : ""}` : u.entitlement?.source === "enterprise" ? "Enterprise-Vertrag" : "eigenes Konto",
        aufnahmen,
        stufen: z?.stufen ?? null,
        guthaben: z
          ? z.guthabenCents === -1
            ? { unbegrenzt: true }
            : { enthaltenEur: eur(z.guthabenCents), verbrauchtEur: eur(z.verbrauchtCents), uebrigEur: eur(z.uebrigCents), ueberschreitungEur: eur(z.ueberschreitungCents) }
          : null,
        preiseJeStufe: { klein: 1.0, mittel: 2.0, gross: 3.5 },
        hinweis:
          u.tier === "free"
            ? "Free: 25 Firmen lebenslang, Kontakte nur von der Website (kein LinkedIn). Mehr Firmen und LinkedIn-Kontakte ab Starter (49 €/Monat mit 40 € Zugangsguthaben)."
            : z && z.ueberschreitungCents > 0
              ? `Ueber dem Guthaben: ${eur(z.ueberschreitungCents).toFixed(2)} € werden mit der naechsten Rechnung berechnet.`
              : "Aufnahmen werden mit ihrem Stufenpreis gegen das monatliche Guthaben gerechnet; darueber hinaus Pay-as-you-go.",
      };
    },
  });
  return [status];
}

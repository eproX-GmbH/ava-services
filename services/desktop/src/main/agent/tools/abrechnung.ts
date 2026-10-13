// Z5/Z7 (docs/PLAN_ABRECHNUNG_ZUGANG.md): Abrechnungsstand im Chat — Plan,
// Aufnahmen nach Stufe, voraussichtliche Kosten, Ausgabenlimit (lesen und
// setzen). Plan-Wechsel laufen ueber Einstellungen → Plan & Abrechnung.
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
  entitlement?: { source?: string; paidBy?: string | null; role?: string | null; seats?: { count?: number; tier?: string } | null };
  zugang?: {
    stufen: { klein: number; mittel: number; gross: number; offen: number };
    verbrauchtCents: number;
    guthabenCents: number;
    uebrigCents: number;
    ueberschreitungCents: number;
    ausgabenLimitCents?: number | null;
    erwartetCents?: number;
  };
}

const STUFEN_TEXT = "Stufen je Aufnahme: klein 1,00 € (kein LinkedIn-Firmenprofil), mittel 2,00 € (LinkedIn-Profil, bis 100 Personen), gross 3,50 € (ueber 100 Personen). Die Stufe steht nach dem Lauf fest.";
const eur = (cents: number) => Math.round(cents) / 100;

export function buildAbrechnungTools(deps: { gateway: GatewayClient }): Tool[] {
  const status = defineTool({
    name: "abrechnung_status",
    summary: "Plan, Aufnahmen dieser Periode nach Stufe (klein/mittel/gross), voraussichtliche Kosten und Ausgabenlimit lesen.",
    category: "abrechnung plan kosten ausgabenlimit kontingent preise stufe abo free pro",
    description:
      "Liest den Abrechnungsstand des Nutzers: Plan (free/pro/enterprise), Aufnahmen der Periode nach Stufe, voraussichtliche Kosten " +
      "(zugeordnete Aufnahmen zum Stufenpreis plus offene), Ausgabenlimit je Monat und wer zahlt (eigenes Abo oder Seat der Organisation). " +
      STUFEN_TEXT + " Pro: 49 € je Nutzer und Monat plus Stufenpreis je aufgenommener Firma, kein fester Deckel (nur eine hohe Notbremse). " +
      "Free: 25 Firmen lebenslang ohne LinkedIn-Kontakte. Nur lesend; Upgrade oder Kuendigung laufen ueber Einstellungen → Plan & Abrechnung.",
    parameters: { type: "object", properties: {} },
    schema: yup.object({}).noUnknown(true),
    preview: (r) => {
      const u = r as { tier?: string; aufnahmen?: number; error?: string };
      return u.error ? `Fehler: ${u.error.slice(0, 60)}` : `${u.tier ?? "?"}: ${u.aufnahmen ?? 0} Aufnahmen in dieser Periode`;
    },
    run: async (_args, c) => {
      const u = await deps.gateway.request<Usage>("/v1/usage", { signal: c.signal });
      const z = u.zugang;
      const aufnahmen = z ? z.stufen.klein + z.stufen.mittel + z.stufen.gross + z.stufen.offen : u.used;
      const limit = z?.ausgabenLimitCents ?? null;
      const erwartet = z ? (z.erwartetCents ?? z.verbrauchtCents) : 0;
      return {
        tier: u.tier,
        status: u.status,
        periode: u.periodKey === "lifetime" ? "lebenslang (Free)" : u.periodKey === "unlimited" ? "unbegrenzt" : u.periodKey,
        periodenEnde: u.periodEnd,
        notbremse: u.limit === -1 ? { verbraucht: u.used, deckel: "unbegrenzt" } : { verbraucht: u.used, deckel: u.limit, frei: u.remaining },
        geparkt: u.parkedCount,
        bezahltVon: u.entitlement?.source === "seat" ? `Organisation${u.entitlement.paidBy ? ` (${u.entitlement.paidBy})` : ""}` : u.entitlement?.source === "enterprise" ? "Enterprise-Vertrag" : "eigenes Konto",
        aufnahmen,
        stufen: z?.stufen ?? null,
        kosten: z && u.tier !== "free"
          ? { zugeordnetEur: eur(z.verbrauchtCents), voraussichtlichEur: eur(erwartet), enthaltenEur: z.guthabenCents > 0 ? eur(Math.min(z.verbrauchtCents, z.guthabenCents)) : 0 }
          : null,
        ausgabenlimit: u.tier === "free" ? null : limit == null ? { gesetzt: false } : { gesetzt: true, limitEur: eur(limit), erreicht: erwartet >= limit },
        preiseJeStufe: { klein: 1.0, mittel: 2.0, gross: 3.5 },
        hinweis:
          u.tier === "free"
            ? "Free: 25 Firmen lebenslang, Kontakte nur von der Website (kein LinkedIn). Mehr Firmen und LinkedIn-Kontakte mit Pro (49 € je Nutzer und Monat plus Stufenpreis je Firma)."
            : limit != null && erwartet >= limit
              ? "Das Ausgabenlimit ist erreicht: neue Firmen warten, bis das Limit erhoeht wird (abrechnung_limit_setzen) oder der Monat wechselt."
              : "Aufnahmen werden zum Stufenpreis mit der naechsten Rechnung berechnet. Ein Ausgabenlimit je Monat laesst sich mit abrechnung_limit_setzen setzen.",
      };
    },
  });

  const limitSetzen = defineTool({
    name: "abrechnung_limit_setzen",
    summary: "Monatliches Ausgabenlimit fuer Aufnahmen setzen oder aufheben (Euro, leer = kein Limit).",
    category: "abrechnung ausgabenlimit limit budget kosten deckel",
    description:
      "Setzt das Ausgabenlimit je Monat fuer Aufnahmen (in Euro) oder hebt es auf (limitEur = null). Ist das Limit erreicht, warten neue Firmen bis zum " +
      "naechsten Monat oder bis das Limit erhoeht wird. Bei Sammelabrechnung darf nur Owner oder Admin der Organisation das Limit setzen. " +
      "Fragt vor dem Setzen nach Bestaetigung. Nicht im Free-Plan.",
    parameters: {
      type: "object",
      properties: { limitEur: { type: ["number", "null"], description: "Limit in Euro je Monat, null = kein Limit" } },
      required: ["limitEur"],
    },
    schema: yup.object({ limitEur: yup.number().min(0).max(1_000_000).nullable().defined() }).noUnknown(true),
    preview: (r) => {
      const u = r as { limitEur?: number | null; abgebrochen?: boolean; error?: string };
      return u.error ? `Fehler: ${u.error.slice(0, 60)}` : u.abgebrochen ? "abgebrochen" : u.limitEur == null ? "Ausgabenlimit aufgehoben" : `Ausgabenlimit ${u.limitEur} €`;
    },
    run: async (args, c) => {
      const u = await deps.gateway.request<Usage>("/v1/usage", { signal: c.signal });
      if (u.tier === "free") return { error: "Im Free-Plan gibt es kein Ausgabenlimit (25 Firmen lebenslang)." };
      if (u.entitlement?.source === "seat" && u.entitlement.role !== "owner" && u.entitlement.role !== "admin") {
        return { error: "Das Ausgabenlimit deiner Organisation setzt nur der Owner oder ein Admin." };
      }
      const alt = u.zugang?.ausgabenLimitCents ?? null;
      const neu = args.limitEur == null ? null : Math.round(args.limitEur * 100);
      const text = neu == null ? "Ausgabenlimit aufheben?" : `Ausgabenlimit auf ${(neu / 100).toFixed(2)} € je Monat setzen?`;
      const value = await c.ui.confirmAction(
        {
          kind: "additive",
          prompt:
            `${text}\n\n` +
            `Bisher: ${alt == null ? "kein Limit" : `${(alt / 100).toFixed(2)} €`}. ` +
            (u.entitlement?.source === "seat" ? "Das Limit gilt fuer die ganze Organisation. " : "") +
            "Ist es erreicht, warten neue Firmen bis zum naechsten Monat oder bis du es erhoehst.",
          confirmValue: "setzen",
          options: [{ value: "setzen", label: neu == null ? "Aufheben" : "Setzen" }, { value: "cancel", label: "Abbrechen" }],
        },
        c.signal,
      );
      if (value !== "setzen") return { abgebrochen: true };
      const r = await deps.gateway.request<{ ausgabenLimitCents: number | null }>("/v1/usage/ausgabenlimit", { method: "PUT", body: { ausgabenLimitCents: neu }, signal: c.signal });
      return { limitEur: r.ausgabenLimitCents == null ? null : eur(r.ausgabenLimitCents), vorherEur: alt == null ? null : eur(alt) };
    },
  });
  return [status, limitSetzen];
}

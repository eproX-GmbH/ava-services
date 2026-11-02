// Manueller Recherche-Lauf je Firma (2026-09-24): Stellenanzeigen oder
// Ausschreibungen/Expansion gezielt anstossen. Seit 2026-11-02 (Vorgabe Joyce)
// nur noch Stufe Standard ueber die Betreiber-Spur: keine Einstellung, kein
// Schluessel des Nutzers, keine Kosten fuer ihn. Deep Research bleibt im
// Producer erhalten, ist im Chat aber nicht mehr waehlbar.

import * as yup from "yup";
import { defineTool } from "../define-tool";
import type { GatewayClient } from "../gateway-client";
import type { Tool } from "../types";

interface Ctx {
  gateway: GatewayClient;
}

const FEATURE_TEXT = { jobs: "Stellenanzeigen", expansion: "Ausschreibungen, Expansion und Beschaffung", themen: "Fokus-Themen" } as const;

export function buildResearchLaufTools(ctx: Ctx): Tool[] {
  const run = defineTool({
    name: "research_run",
    description:
      "Startet fuer EINE Firma gezielt die Suche nach Stellenanzeigen (feature=jobs), nach Ausschreibungen/Expansion/Beschaffung (feature=expansion) oder die Pruefung der Fokus-Themen des Nutzers (feature=themen, laeuft auf dem allgemeinen Modell). " +
      "Stellen und Expansion laufen ueber AVA, ohne Schluessel und ohne Kosten fuer den Nutzer, dauern etwa eine Minute. " +
      "Fragt vorher nach. Ergebnisse erscheinen in der Firmenansicht (Stellenanzeigen bzw. Ereignisse & Signale); mit company_website spaeter nachsehen.",
    parameters: {
      type: "object",
      properties: {
        companyId: { type: "string" },
        name: { type: "string", description: "Firmenname fuer die Rueckfrage" },
        feature: { type: "string", enum: ["jobs", "expansion", "themen"] },
      },
      required: ["companyId", "feature"],
    },
    schema: yup
      .object({
        companyId: yup.string().trim().min(1).required(),
        name: yup.string().trim().max(200).optional(),
        feature: yup.mixed<"jobs" | "expansion" | "themen">().oneOf(["jobs", "expansion", "themen"]).required(),
      })
      .noUnknown(true),
    run: async (args, c) => {
      if (args.feature === "themen") {
        const v = await c.ui.confirmAction(
          { kind: "additive", prompt: `Fokus-Themen für ${args.name ?? args.companyId} prüfen? Läuft auf deinem allgemeinen Modell, etwa eine Minute.`, confirmValue: "start", options: [{ value: "start", label: "Starten" }, { value: "cancel", label: "Abbrechen" }] },
          c.signal,
        );
        if (v !== "start") return { abgebrochen: true };
        return ctx.gateway.request<{ angestossen: boolean; grund?: string; transactionId: string | null }>(
          `/v1/companies/${encodeURIComponent(args.companyId)}/research`,
          { method: "POST", body: { feature: "themen", stufe: "standard" }, signal: c.signal },
        );
      }
      const value = await c.ui.confirmAction(
        {
          kind: "additive",
          prompt: `${FEATURE_TEXT[args.feature]} für ${args.name ?? args.companyId} suchen?\n\nDauert etwa eine Minute; die Ergebnisse erscheinen in der Firmenansicht.`,
          confirmValue: "start",
          options: [
            { value: "start", label: "Starten" },
            { value: "cancel", label: "Abbrechen" },
          ],
        },
        c.signal,
      );
      if (value !== "start") return { abgebrochen: true };
      return ctx.gateway.request<{ angestossen: boolean; grund?: string; transactionId: string | null }>(
        `/v1/companies/${encodeURIComponent(args.companyId)}/research`,
        { method: "POST", body: { feature: args.feature, stufe: "standard" }, signal: c.signal },
      );
    },
    preview: (r) => {
      const x = r as { abgebrochen?: boolean; error?: string; angestossen?: boolean; grund?: string };
      if (x.error) return x.error;
      if (x.abgebrochen) return "abgebrochen";
      return x.angestossen ? "Lauf gestartet" : `nicht gestartet: ${x.grund ?? ""}`;
    },
  });
  return [run];
}

// Manueller Recherche-Lauf je Firma (2026-09-24): Stellenanzeigen oder
// Ausschreibungen/Expansion gezielt anstossen, Standard oder Deep Research,
// unabhaengig von der globalen Stufe in den Einstellungen. Deep Research
// nur mit OpenAI-Schluessel (eigener oder der der Organisation).

import * as yup from "yup";
import { defineTool } from "../define-tool";
import type { GatewayClient } from "../gateway-client";
import type { Tool } from "../types";

interface Ctx {
  gateway: GatewayClient;
  getResearchStand: () => { verfuegbar: boolean; quelle: "eigen" | "organisation" | null };
}

const FEATURE_TEXT = { jobs: "Stellenanzeigen", expansion: "Ausschreibungen, Expansion und Beschaffung" } as const;

export function buildResearchLaufTools(ctx: Ctx): Tool[] {
  const run = defineTool({
    name: "research_run",
    description:
      "Startet fuer EINE Firma gezielt die Suche nach Stellenanzeigen (feature=jobs) oder nach Ausschreibungen/Expansion/Beschaffung (feature=expansion) — " +
      "stufe=standard (guenstig, ca. 0,02–0,15 € je Firma) oder stufe=deep (Deep Research, gruendlicher, ca. 1–5 € je Firma, dauert Minuten). " +
      "Laeuft unabhaengig von der globalen Einstellung, also auch wenn die Funktion dort auf 'Aus' steht. Braucht einen OpenAI-Schluessel (eigener oder der der Organisation). " +
      "Fragt vorher nach. Ergebnisse erscheinen in der Firmenansicht (Stellenanzeigen bzw. Ereignisse & Signale); mit company_website spaeter nachsehen.",
    parameters: {
      type: "object",
      properties: {
        companyId: { type: "string" },
        name: { type: "string", description: "Firmenname fuer die Rueckfrage" },
        feature: { type: "string", enum: ["jobs", "expansion"] },
        stufe: { type: "string", enum: ["standard", "deep"] },
      },
      required: ["companyId", "feature", "stufe"],
    },
    schema: yup
      .object({
        companyId: yup.string().trim().min(1).required(),
        name: yup.string().trim().max(200).optional(),
        feature: yup.mixed<"jobs" | "expansion">().oneOf(["jobs", "expansion"]).required(),
        stufe: yup.mixed<"standard" | "deep">().oneOf(["standard", "deep"]).required(),
      })
      .noUnknown(true),
    run: async (args, c) => {
      const stand = ctx.getResearchStand();
      if (!stand.verfuegbar) {
        return { error: "Kein OpenAI-Schluessel hinterlegt — weder eigener noch einer der Organisation. In den Einstellungen unter Modelle eintragen." };
      }
      const wer = stand.quelle === "organisation" ? "über den OpenAI-Schlüssel deiner Organisation (Verbrauch wird ihr zugerechnet)" : "über deinen eigenen OpenAI-Schlüssel";
      const kosten = args.stufe === "deep" ? "Deep Research: gründlicher, ca. 1–5 € je Firma, dauert mehrere Minuten." : "Standard: ca. 0,02–0,15 € je Firma, dauert etwa eine Minute.";
      const value = await c.ui.confirmAction(
        {
          kind: "additive",
          prompt: `${FEATURE_TEXT[args.feature]} für ${args.name ?? args.companyId} suchen?\n\n${kosten}\nLäuft ${wer}.`,
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
        { method: "POST", body: { feature: args.feature, stufe: args.stufe }, signal: c.signal },
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

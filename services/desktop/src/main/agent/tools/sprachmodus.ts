// Sprachmodus — Einstellung auch im Chat (Regel: jede Einstellung braucht ein
// Werkzeug mit Rueckfrage). Schluessel bleiben ausgenommen.

import * as yup from "yup";
import { defineTool } from "../define-tool";
import type { Tool } from "../types";
import type { SpracheEinstellungen, SpracheStimme } from "../../../shared/types";

interface Ctx {
  get: () => SpracheEinstellungen;
  setzen: (teil: Partial<SpracheEinstellungen>) => SpracheEinstellungen;
  stand: () => { verfuegbar: boolean; quelle: "eigen" | "organisation" | null };
}

export function buildSprachmodusTools(ctx: Ctx): Tool[] {
  const konfigurieren = defineTool({
    name: "sprachmodus_konfigurieren",
    description:
      "Sprachmodus (mit AVA sprechen, OpenAI Realtime) ein- oder ausschalten und einstellen: Stimme (marin, coral, sage, shimmer), Stille bis zum Ruhezustand in Sekunden, Signalton, Aktivierungswort 'Hey AVA'. Ohne Argumente: aktuelle Einstellungen zeigen. Braucht einen OpenAI-Schluessel (eigener oder Organisation). Fragt vor Aenderungen nach.",
    parameters: {
      type: "object",
      properties: {
        aktiv: { type: "boolean" },
        stimme: { type: "string", enum: ["marin", "coral", "sage", "shimmer"] },
        ruheSekunden: { type: "integer", minimum: 5, maximum: 120 },
        signalton: { type: "boolean" },
        wachwort: { type: "boolean" },
      },
    },
    schema: yup.object({
      aktiv: yup.boolean().optional(),
      stimme: yup.mixed<SpracheStimme>().oneOf(["marin", "coral", "sage", "shimmer"]).optional(),
      ruheSekunden: yup.number().integer().min(5).max(120).optional(),
      signalton: yup.boolean().optional(),
      wachwort: yup.boolean().optional(),
    }).noUnknown(true),
    run: async (args, c) => {
      const jetzt = ctx.get();
      const stand = ctx.stand();
      const aenderungen = Object.entries(args).filter(([, v]) => v !== undefined);
      if (aenderungen.length === 0) return { einstellungen: jetzt, ...stand };
      if (args.aktiv === true && !stand.verfuegbar) return { error: "Kein OpenAI-Schluessel hinterlegt — der Sprachmodus braucht einen (eigener oder Organisation)." };
      const value = await c.ui.confirmAction(
        {
          kind: "additive",
          prompt: `Sprachmodus ändern?\n\n${aenderungen.map(([k, v]) => `${k}: ${String(v)}`).join("\n")}${args.aktiv === true ? "\n\nHinweis: Gesprächsminuten kosten mehr als Chat (grob 0,20–0,40 € je Minute)." : ""}`,
          confirmValue: "ja",
          options: [{ value: "ja", label: "Übernehmen" }, { value: "nein", label: "Abbrechen" }],
        },
        c.signal,
      );
      if (value !== "ja") return { abgebrochen: true };
      return { einstellungen: ctx.setzen(args as Partial<SpracheEinstellungen>), ...stand };
    },
    preview: (r) => {
      const x = r as { abgebrochen?: boolean; error?: string; einstellungen?: SpracheEinstellungen };
      if (x.error) return x.error;
      if (x.abgebrochen) return "abgebrochen";
      return x.einstellungen ? `Sprachmodus ${x.einstellungen.aktiv ? "an" : "aus"}, Stimme ${x.einstellungen.stimme}, Ruhe nach ${x.einstellungen.ruheSekunden} s` : "";
    },
  });
  return [konfigurieren];
}

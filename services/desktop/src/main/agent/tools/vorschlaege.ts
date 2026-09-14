// v0.1.646 (docs/PLAN_CHAT_VORSCHLAEGE.md, V1) — Lesendes Chat-Tool: Nutzerstand
// und Faehigkeitsliste, wie sie die Vorschlags-Erzeugung sieht. Dient dem
// Nutzer ("Was habe ich schon eingerichtet?") und der Diagnose.

import * as yup from "yup";
import { defineTool } from "../define-tool";
import type { Tool } from "../types";
import type { NutzerstandService } from "../../suggestions/nutzerstand";
import { nutzerstandText } from "../../suggestions/nutzerstand";
import { verfuegbareFaehigkeiten } from "../../suggestions/faehigkeiten";

export function buildVorschlaegeTools(deps: { get: () => NutzerstandService | null; toolNamen: () => string[] }): Tool[] {
  const status = defineTool({
    name: "vorschlaege_status",
    summary: "Nutzerstand fuer Vorschlaege: was ist verbunden, eingerichtet, erledigt; welche Faehigkeiten stehen zur Verfuegung.",
    category: "vorschlaege nutzerstand naechste schritte einrichtung status onboarding",
    description:
      "Zeigt den Nutzerstand, auf dem die naechsten Schritte im Chat beruhen: Verbindungen (Mail, Telegram, HubSpot, Notion, Obsidian, LinkedIn), " +
      "ICP-Stand, Radar (Automatik, bewertete und heisse Treffer, Top-Treffer), importierte Firmen, Workflows, Skills, Watchlist, E-Mail-Ableitung, " +
      "Modell und Plan, Organisation, gesperrte Module. Dazu die Faehigkeitsgruppen, die mit den geladenen Tools und der Organisations-Policy verfuegbar sind. " +
      "Nur lesend. Nutze es, um Erledigtes nicht erneut vorzuschlagen.",
    parameters: { type: "object", properties: { frisch: { type: "boolean", description: "Cache umgehen" } } },
    schema: yup.object({ frisch: yup.boolean().optional() }).noUnknown(true),
    preview: (r: Record<string, any>) => (r.error ? r.error : `Nutzerstand: ICP ${r.nutzerstand?.icp}, ${r.faehigkeiten?.length ?? 0} Faehigkeitsgruppen`),
    run: async (args) => {
      const svc = deps.get();
      if (!svc) return { error: "Nutzerstand noch nicht initialisiert." };
      const s = await svc.get({ frisch: args.frisch === true });
      const gruppen = verfuegbareFaehigkeiten(deps.toolNamen(), s.gesperrteModule);
      return { nutzerstand: s, text: nutzerstandText(s), faehigkeiten: gruppen.map((g) => ({ id: g.id, text: g.text })) };
    },
  });
  return [status];
}

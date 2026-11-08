// Onboarding O2 (docs/PLAN_ONBOARDING.md): Website fuer die Start-Analyse
// nachreichen (Freemail-Registrierung oder Analyse fehlgeschlagen). Das Ergebnis
// kommt ueber die einmalige Abholung (main/onboarding/start-icp.ts) als neue
// Nachricht, sobald es fertig ist; ein vorhandener ICP wird nie ueberschrieben.

import * as yup from "yup";
import { defineTool } from "../define-tool";
import type { GatewayClient } from "../gateway-client";
import type { Tool } from "../types";

/** Weckt die Abholung (bootstrap setzt das, sobald sie existiert). */
let neuStarten: () => void = () => undefined;
export function setzeStartIcpWecker(fn: () => void): void {
  neuStarten = fn;
}

export function buildStartAnalyseTools(deps: { gateway: GatewayClient; icpGesetzt: () => boolean }): Tool[] {
  const website = defineTool({
    name: "start_analyse_website",
    summary: "Analysiert beim Start die Website der eigenen Firma (mit Referenzkunden) und legt daraus das erste Idealkundenprofil an",
    category: "icp onboarding start website firma referenzen idealkundenprofil",
    description:
      "Nur für den Start: Der Nutzer nennt die Website SEINER Firma (z. B. nach der Begrüßung, wenn er sich mit Gmail o. Ä. registriert hat). " +
      "Die Website wird im Hintergrund gelesen, Referenzkunden werden gesucht, daraus entsteht das erste Idealkundenprofil. Das Ergebnis erscheint in wenigen Minuten als neue Nachricht im Chat. " +
      "Gibt es schon ein Idealkundenprofil, nicht nutzen, sondern icp_assist_from_urls bzw. den ICP-Assistenten.",
    parameters: {
      type: "object",
      properties: { website: { type: "string", description: "Website der eigenen Firma, z. B. eprox.de" } },
      required: ["website"],
    },
    schema: yup.object({ website: yup.string().trim().max(300).matches(/^(https?:\/\/)?[a-z0-9.-]+\.[a-z]{2,}(\/.*)?$/i, "keine gültige Website").required() }),
    run: async (args) => {
      if (deps.icpGesetzt()) return { gestartet: false, hinweis: "Es gibt schon ein Idealkundenprofil. Für eine neue Ableitung icp_assist_from_urls nutzen." };
      try {
        await deps.gateway.request("/v1/onboarding/start/website", { method: "POST", body: { website: args.website } });
      } catch (err) {
        const m = err instanceof Error ? err.message : String(err);
        if (m.includes("gateway 409")) return { gestartet: false, hinweis: "Die Start-Analyse läuft schon oder ist bereits übernommen. Für eine neue Ableitung icp_assist_from_urls nutzen." };
        throw err;
      }
      neuStarten();
      return { gestartet: true, hinweis: "Analyse läuft im Hintergrund (meist unter einer Minute, bei Wiederholungen bis zu 15 Minuten). Das Ergebnis erscheint als neue Nachricht. Sag das dem Nutzer in einem Satz." };
    },
    preview: (r: Record<string, unknown>) => (r.gestartet ? "Website-Analyse gestartet" : String(r.hinweis ?? "nicht gestartet")),
  });
  return [website];
}

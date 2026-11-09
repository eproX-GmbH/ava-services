// Chat-Werkzeug „erlaubnisse“ (docs/PLAN_ERLAUBNISSE.md §2.4, Self-Service-Regel):
// zeigt dauerhafte Erlaubnisse und selbststaendige Workflows und nimmt sie zurueck.
// Erteilen geht bewusst NUR ueber „Immer erlauben“ in einer echten Rueckfrage,
// nie per Werkzeug (sonst koennte sich das Modell selbst Rechte geben).

import * as yup from "yup";
import { defineTool } from "../define-tool";
import type { Tool } from "../types";
import { dauerErlaubnis } from "../dauer-erlaubnis";
import { werkzeugTitel } from "../../../shared/werkzeug-titel";
import type { WorkflowService } from "../../workflows";

export function buildErlaubnisseTools(deps: { getWorkflows: () => WorkflowService | null }): Tool[] {
  const erlaubnisse = defineTool({
    name: "erlaubnisse",
    summary: "Dauerhafte Erlaubnisse („Immer erlauben“) und selbstständige Workflows zeigen oder zurücknehmen.",
    category: "erlaubnisse erlaubnis immer erlauben dauerhaft rueckfrage nachfragen widerrufen zuruecknehmen selbststaendig workflow autonom vollmacht freigabe",
    description:
      "Ohne Argumente: listet, was AVA dauerhaft ohne Rueckfrage darf (vom Nutzer per „Immer erlauben“ gewaehlt, je Werkzeug, mit Datum und Beispiel) und welche Workflows selbststaendig laufen. " +
      "widerrufen: Werkzeugname aus der Liste oder 'alle' → AVA fragt dort wieder nach. workflowVorherFragen: Workflow-ID → der Workflow fragt wieder je Schritt und Lauf. " +
      "Neue Erlaubnisse kann dieses Werkzeug NICHT erteilen; das geht nur ueber „Immer erlauben“ in einer Rueckfrage. Fragt vor dem Zuruecknehmen nach.",
    parameters: {
      type: "object",
      properties: {
        widerrufen: { type: "string", description: "Werkzeugname aus der Liste oder 'alle'" },
        workflowVorherFragen: { type: "string", description: "ID eines selbststaendigen Workflows" },
      },
    },
    schema: yup.object({ widerrufen: yup.string().trim().optional(), workflowVorherFragen: yup.string().trim().optional() }).noUnknown(true),
    preview: (r: Record<string, any>) => (r.error ? r.error : r.zurueckgenommen ? `Zurückgenommen: ${r.zurueckgenommen}` : `${r.erlaubnisse?.length ?? 0} dauerhafte Erlaubnisse`),
    run: async (args, c) => {
      const svc = deps.getWorkflows();
      const liste = () => ({
        erlaubnisse: dauerErlaubnis.liste().map((e) => ({ werkzeug: e.werkzeug, titel: werkzeugTitel(e.werkzeug), seit: e.seit, ...(e.beispiel ? { beispiel: e.beispiel } : {}), loeschend: e.loeschend })),
        selbststaendigeWorkflows: (svc?.list() ?? []).filter((w) => w.autonomous).map((w) => ({ id: w.id, name: w.name })),
        hinweis: "Übersicht und Zurücknehmen auch unter Einstellungen → Konto → Erlaubnisse.",
      });
      if (!args.widerrufen && !args.workflowVorherFragen) return liste();

      let was: string;
      if (args.workflowVorherFragen) {
        const def = svc?.get(args.workflowVorherFragen);
        if (!def) return { error: `Workflow ${args.workflowVorherFragen} nicht gefunden.` };
        was = `Workflow „${def.name}“ fragt wieder vor jedem verändernden Schritt`;
      } else if (args.widerrufen === "alle") {
        was = "Alle dauerhaften Erlaubnisse zurücknehmen";
      } else {
        if (!dauerErlaubnis.hat(args.widerrufen!)) return { error: `„${args.widerrufen}“ ist nicht dauerhaft erlaubt.`, ...liste() };
        was = `Dauerhafte Erlaubnis „${werkzeugTitel(args.widerrufen!)}“ zurücknehmen`;
      }
      const value = await c.ui.confirmAction(
        { kind: "mutating", prompt: `${was}?`, confirmValue: "ja", options: [{ value: "ja", label: "Zurücknehmen" }, { value: "nein", label: "Abbrechen" }] },
        c.signal,
      );
      if (value !== "ja") return { abgebrochen: true };
      if (args.workflowVorherFragen) {
        const def = svc!.get(args.workflowVorherFragen)!;
        svc!.patch(def.id, { settings: { ...def.settings, autonomous: false } });
      } else if (args.widerrufen === "alle") {
        dauerErlaubnis.alleWiderrufen();
      } else {
        dauerErlaubnis.widerrufen(args.widerrufen!);
      }
      return { zurueckgenommen: was, ...liste() };
    },
  });
  return [erlaubnisse];
}

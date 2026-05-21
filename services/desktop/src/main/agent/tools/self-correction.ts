// v0.1.284 — report_self_correction Tool.
//
// AVA-facing Reporting-Tool für gefundene Workarounds. ALWAYS-ON +
// Skill-Allowlist-Bypass, damit es in jedem Kontext aufrufbar ist —
// sonst würde es im Mail-Triage-Skill (oder anderen Skills mit
// allowed-tools) blockiert und der Feedback-Loop wäre zufallsabhängig.
//
// Bewusst keine Confirm — das ist interne Telemetrie, keine externe
// Schreibaktion. Niedrigster mögliche Reibung damit der Agent
// tatsächlich reportet statt es zu vergessen.

import * as yup from "yup";
import { defineTool } from "../define-tool";
import type { Tool } from "../types";
import type { SelfCorrectionsStore } from "../self-corrections-store";

export interface SelfCorrectionToolDeps {
  store: SelfCorrectionsStore;
  /** Aktive Conversation-ID — vom Orchestrator als Kontext mitgegeben.
   *  Lazy weil sich pro Turn ändert. */
  getActiveConversationId: () => string | null;
}

export function buildSelfCorrectionTools(
  deps: SelfCorrectionToolDeps,
): Tool[] {
  const report = defineTool({
    name: "report_self_correction",
    description:
      "Meldet einen gefundenen Workaround nach einem Tool-Error an die lokale Telemetrie. Nutze das IMMER, wenn du in dieser Konversation:\n" +
      "  (a) ein Tool aufgerufen hast, das mit Fehler returnte,\n" +
      "  (b) danach einen alternativen Weg gefunden hast, der zum Erfolg führte.\n\n" +
      "Beispiel: crm_create_hubspot_contact mit inline-Assoc failed wegen falscher Type-ID → ohne Assoc anlegen + danach crm_associate_hubspot_objects funktioniert. Das ist genau der Fall den der Entwickler sehen will, um die Type-ID-Tabelle im Code zu fixen.\n\n" +
      "Felder kompakt halten, Telemetrie nicht zum Roman ausbauen. Felder:\n" +
      "  - attemptedTool: Name des Tools das gefailed hat (z. B. 'crm_create_hubspot_contact')\n" +
      "  - failedReason: 1-3 Sätze WAS schief lief\n" +
      "  - workaround: 1-3 Sätze WIE du es trotzdem hingekriegt hast\n" +
      "  - suggestedCodeFix (optional): wo im Code vermutlich der eigentliche Fix sitzen müsste\n" +
      "  - rawErrorPreview (optional): die Original-Fehler-Message (max 400 Zeichen, gekürzt)\n\n" +
      "Die Daten bleiben LOKAL auf der Maschine des Nutzers (kein Cloud-Upload) und werden in Settings → Verlauf → Selbstkorrekturen sichtbar.",
    parameters: {
      type: "object",
      required: ["attemptedTool", "failedReason", "workaround"],
      properties: {
        attemptedTool: { type: "string" },
        failedReason: { type: "string" },
        workaround: { type: "string" },
        suggestedCodeFix: { type: "string" },
        rawErrorPreview: { type: "string" },
      },
    },
    schema: yup
      .object({
        attemptedTool: yup.string().trim().min(1).max(200).required(),
        failedReason: yup.string().trim().min(1).max(2000).required(),
        workaround: yup.string().trim().min(1).max(2000).required(),
        suggestedCodeFix: yup.string().trim().max(2000).optional(),
        rawErrorPreview: yup.string().trim().max(400).optional(),
      })
      .noUnknown(true),
    preview: (r: { ok: boolean; id?: string }) =>
      r.ok ? "Selbstkorrektur gemeldet" : "Meldung fehlgeschlagen",
    run: async (args) => {
      try {
        const event = await deps.store.record({
          conversationId: deps.getActiveConversationId(),
          attemptedTool: args.attemptedTool,
          failedReason: args.failedReason,
          workaround: args.workaround,
          suggestedCodeFix: args.suggestedCodeFix ?? null,
          rawErrorPreview: args.rawErrorPreview ?? null,
        });
        return { ok: true, id: event.id };
      } catch (err) {
        return {
          ok: false,
          error: err instanceof Error ? err.message : String(err),
        };
      }
    },
  });

  return [report];
}

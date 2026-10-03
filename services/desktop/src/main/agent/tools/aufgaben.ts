// Werkzeuge fuer Hintergrundaufgaben (docs/PLAN_HINTERGRUNDAUFGABEN.md).
// Importe werden automatisch beobachtet; `aufgabe_beobachten` deckt alle
// anderen Vorgaenge mit transactionId ab (z. B. retry_stage, Radar-Uebernahme).
import * as yup from "yup";
import { defineTool } from "../define-tool";
import type { Tool } from "../types";
import { aufgabenInstanz } from "../../aufgaben/aufgaben";

export function buildAufgabenTools(): Tool[] {
  const beobachten = defineTool({
    name: "aufgabe_beobachten",
    category: "aufgaben hintergrund verarbeitung import fortschritt melden",
    description:
      "Laesst AVA eine laufende Verarbeitung (Transaktion) im Hintergrund verfolgen: Die Leiste im Chat zeigt den Fortschritt, und sobald alle Firmen fertig sind, meldet sich AVA in DIESER Unterhaltung von selbst mit dem Ergebnis. " +
      "Importe (import_excel, import_companies, import_companies_from_crm) werden automatisch beobachtet; nutze das Werkzeug fuer andere Vorgaenge mit transactionId oder wenn der Nutzer sagt „sag Bescheid, wenn es fertig ist“.",
    parameters: {
      type: "object",
      required: ["transactionId"],
      properties: {
        transactionId: { type: "string" },
        titel: { type: "string", description: "Kurzer Name fuer die Leiste, z. B. „Import Messekontakte“." },
      },
    },
    schema: yup.object({ transactionId: yup.string().trim().min(1).required(), titel: yup.string().trim().max(120).optional() }).noUnknown(true),
    run: async (args, ctx) => {
      const a = aufgabenInstanz();
      if (!a) return { error: "Aufgaben-Waechter nicht bereit." };
      if (!ctx.conversationId) return { error: "Keine Unterhaltung zugeordnet." };
      const auf = a.registrieren({ conversationId: ctx.conversationId, transactionId: args.transactionId, titel: args.titel ?? "Verarbeitung", quelle: "werkzeug" });
      return { beobachtet: true, id: auf.id, hinweis: "Ich melde mich in diesem Chat, sobald die Verarbeitung abgeschlossen ist. Der Nutzer muss nicht nachfragen." };
    },
    preview: (r) => ((r as { beobachtet?: boolean }).beobachtet ? "wird beobachtet" : String((r as { error?: string }).error ?? "")),
  });

  const liste = defineTool({
    name: "aufgaben_liste",
    category: "aufgaben hintergrund verarbeitung fortschritt",
    description: "Laufende und kuerzlich beendete Hintergrundaufgaben dieser Unterhaltung mit Fortschritt (Firmen gesamt, fertig, fehlgeschlagen, offen).",
    parameters: { type: "object", properties: { alle: { type: "boolean", description: "true = auch aus anderen Unterhaltungen" } } },
    schema: yup.object({ alle: yup.boolean().optional() }).noUnknown(true),
    run: async (args, ctx) => {
      const a = aufgabenInstanz();
      if (!a) return { error: "Aufgaben-Waechter nicht bereit." };
      const items = a.alle(args.alle ? undefined : ctx.conversationId).slice(-20).map((x) => ({
        titel: x.titel,
        transactionId: x.transactionId,
        status: x.status,
        gestartet: new Date(x.gestartet).toISOString(),
        stand: x.stand ? { total: x.stand.total, fertig: x.stand.fertig, fehlgeschlagen: x.stand.fehlgeschlagen, offen: x.stand.laufend } : null,
      }));
      return { items, anzahl: items.length };
    },
    preview: (r) => `${(r as { anzahl?: number }).anzahl ?? 0} Aufgaben`,
  });

  return [beobachten, liste];
}

// docs/PLAN_PROBLEM_MELDEN.md M3 — Chat-Werkzeug: Problem an das AVA-Team melden.
// AVA fasst das Problem aus dem Gespraech zusammen, der Nutzer bestaetigt, der
// Snapshot (Protokolle, Versionen, Zustaende) geht automatisch mit.
import * as yup from "yup";
import { defineTool } from "../define-tool";
import type { Tool } from "../types";
import type { ProblemEingabe, ProblemErgebnis } from "../../../shared/problem";
import { PROBLEM_KATEGORIEN } from "../../../shared/problem";

export function buildProblemTools(deps: { melden: (e: ProblemEingabe) => Promise<ProblemErgebnis> }): Tool[] {
  const ids = PROBLEM_KATEGORIEN.map((k) => k.id);
  const problemMelden = defineTool({
    name: "problem_melden",
    summary: "Ein Problem oder einen Wunsch an das AVA-Team melden (mit Protokollen des Geraets).",
    category: "problem melden fehler support hilfe bug wunsch feedback",
    description:
      "Meldet ein Problem an das AVA-Team. Nutze es, wenn der Nutzer einen Fehler, Absturz, falsche Daten, eine haengende Verarbeitung, ein Anmelde- oder Abrechnungsproblem schildert, das du nicht selbst loesen kannst (z. B. nach retry_stage), oder einen Wunsch aeussert. " +
      "Formuliere titel (kurz) und beschreibung (was getan, was passiert, was erwartet; mit Firmen-IDs/Namen aus dem Gespraech) aus dem Kontext. Fragt den Nutzer vorher um Bestaetigung; Protokolle und Angaben zum Geraet gehen automatisch mit (Schluessel maskiert). " +
      "Nie ungefragt ausloesen. Ergebnis: Kennung der Meldung; Antworten des Teams erscheinen als Meldung in AVA.",
    parameters: {
      type: "object",
      required: ["titel", "beschreibung"],
      properties: {
        kategorie: { type: "string", enum: ids, description: "fehler | daten | verarbeitung | anmeldung | abrechnung | wunsch | sonstiges" },
        titel: { type: "string" },
        beschreibung: { type: "string" },
        companyId: { type: "string", description: "Betroffene Firma, falls es um eine geht" },
        chatAuszug: { type: "boolean", description: "Nur Hinweis fuer die Rueckfrage; die Kennung des Gespraechs geht immer mit" },
      },
    },
    schema: yup.object({
      kategorie: yup.string().oneOf(ids).optional(),
      titel: yup.string().trim().min(3).max(120).required(),
      beschreibung: yup.string().trim().min(10).max(6000).required(),
      companyId: yup.string().trim().max(80).optional(),
      chatAuszug: yup.boolean().optional(),
    }).noUnknown(true),
    preview: (r) => {
      const x = r as { abgebrochen?: boolean; kennung?: string; weg?: string; fehler?: string };
      return x.fehler ? `Fehler: ${x.fehler.slice(0, 60)}` : x.abgebrochen ? "abgebrochen" : x.kennung ? `Meldung ${x.kennung}` : x.weg === "mail" ? "E-Mail vorbereitet" : "gemeldet";
    },
    run: async (args, ctx) => {
      const kategorie = args.kategorie ?? "sonstiges";
      const label = PROBLEM_KATEGORIEN.find((k) => k.id === kategorie)?.label ?? kategorie;
      const value = await ctx.ui.confirmAction(
        {
          kind: "additive",
          prompt: `Problem an das AVA-Team melden?\n\n${label}: ${args.titel}\n\n${args.beschreibung}\n\nMitgeschickt werden Protokolle der App und Angaben zum Geraet (Schluessel und Passwoerter maskiert)${args.chatAuszug !== false ? " sowie die letzten Schritte dieses Gespraechs" : ""}.`,
          confirmValue: "senden",
          options: [{ value: "senden", label: "Melden" }, { value: "cancel", label: "Abbrechen" }],
        },
        ctx.signal,
      );
      if (value !== "senden") return { abgebrochen: true };
      // Der Gespraechsauszug kommt ueber den Dialog in der Oberflaeche; hier reicht die Kennung des Gespraechs.
      const auszug = null;
      try {
        const r = await deps.melden({ kategorie, titel: args.titel, beschreibung: args.beschreibung, quelle: "chat", conversationId: ctx.conversationId ?? null, companyId: args.companyId ?? null, dateien: [], chatAuszug: auszug, bildschirmfoto: false });
        if (r.weg === "gateway") return { kennung: r.kennung, hinweis: `Gemeldet als ${r.kennung}. Das Team antwortet in AVA (Meldungen) und unter „Problem melden“ unten links im Chat.` };
        if (r.weg === "mail") return { weg: "mail", hinweis: r.hinweis };
        return { fehler: r.fehler };
      } catch (err) {
        return { fehler: err instanceof Error ? err.message : String(err) };
      }
    },
  });
  return [problemMelden];
}

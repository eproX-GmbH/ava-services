// v0.1.646 (docs/PLAN_CHAT_VORSCHLAEGE.md, V1) — Lesendes Chat-Tool: Nutzerstand
// und Faehigkeitsliste, wie sie die Vorschlags-Erzeugung sieht. Dient dem
// Nutzer ("Was habe ich schon eingerichtet?") und der Diagnose.

import * as yup from "yup";
import { defineTool } from "../define-tool";
import type { Tool } from "../types";
import type { NutzerstandService } from "../../suggestions/nutzerstand";
import { nutzerstandText } from "../../suggestions/nutzerstand";
import { verfuegbareFaehigkeiten } from "../../suggestions/faehigkeiten";
import type { VorschlaegeSettingsStore } from "../../suggestions/settings";

export function buildVorschlaegeTools(deps: { get: () => NutzerstandService | null; toolNamen: () => string[]; settings: () => VorschlaegeSettingsStore | null }): Tool[] {
  const status = defineTool({
    name: "vorschlaege_status",
    summary: "Nutzerstand fuer Vorschlaege: was ist verbunden, eingerichtet, erledigt; welche Faehigkeiten stehen zur Verfuegung.",
    category: "vorschlaege nutzerstand naechste schritte einrichtung status onboarding verbindungen verbunden dienste mcp crm",
    description:
      "Zeigt den Nutzerstand, auf dem die naechsten Schritte im Chat beruhen: Verbindungen (Mail, Telegram, HubSpot, Notion, Obsidian, LinkedIn), " +
      "weitere verbundene CRM (crm, z. B. Close) und selbst angebundene Dienste (dienste, MCP/A2A wie CompLeadly). " +
      "Auf 'womit/mit wem bist du verbunden' ALLE drei Teile nennen, nicht nur die Standard-Verbindungen. " +
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
  // v0.1.650 (V5) — Self-Service-Regel: jede Einstellung hat ein Tool mit Bestaetigung.
  const config = defineTool({
    name: "vorschlaege_config",
    summary: "Vorschläge im Chat und Anzeige der Arbeitsschritte/des Verbrauchs ein-/ausschalten (mit Bestätigung).",
    category: "vorschlaege einstellung startseite gespraech naechste schritte chips anzeige arbeitsschritte verbrauch denkt nach",
    description:
      "Liest oder aendert, ob AVA naechste Schritte vorschlaegt: startseite = Chips auf der leeren Chat-Seite und unter der Willkommensnachricht, " +
      "gespraech = Chips nach einer Antwort, wenn sich ein naechster Schritt anbietet. Ohne Argumente: aktuelle Werte. Schaltet die Organisation " +
      "Vorschlaege ab, gilt das vorrangig. arbeitsschritte = einzelne Arbeitsschritte und Verbrauch je Antwort im Chat zeigen (Standard aus: nur 'Denkt nach').",
    parameters: { type: "object", properties: { startseite: { type: "boolean" }, gespraech: { type: "boolean" }, arbeitsschritte: { type: "boolean" } } },
    schema: yup.object({ startseite: yup.boolean().optional(), gespraech: yup.boolean().optional(), arbeitsschritte: yup.boolean().optional() }).noUnknown(true),
    preview: (r: Record<string, any>) => (r.error ? r.error : r.geaendert ? "Vorschlaege-Einstellung geaendert" : "Vorschlaege-Einstellung gelesen"),
    run: async (args, c) => {
      const store = deps.settings();
      if (!store) return { error: "Einstellungen noch nicht initialisiert." };
      if (args.startseite === undefined && args.gespraech === undefined && args.arbeitsschritte === undefined) return { geaendert: false, ...store.get() };
      const teile: string[] = [];
      if (args.startseite !== undefined) teile.push(`Startseite → ${args.startseite ? "an" : "aus"}`);
      if (args.gespraech !== undefined) teile.push(`Gespräch → ${args.gespraech ? "an" : "aus"}`);
      if (args.arbeitsschritte !== undefined) teile.push(`Arbeitsschritte anzeigen → ${args.arbeitsschritte ? "an" : "aus"}`);
      const value = await c.ui.confirmAction(
        { kind: "additive", prompt: `Chat-Einstellung ändern: ${teile.join(", ")}?`, confirmValue: "ja", options: [{ value: "ja", label: "Ändern" }, { value: "nein", label: "Abbrechen" }] },
        c.signal,
      );
      if (value !== "ja") return { geaendert: false, abgebrochen: true };
      const next = store.set({
        ...(args.startseite !== undefined ? { startseite: args.startseite } : {}),
        ...(args.gespraech !== undefined ? { gespraech: args.gespraech } : {}),
        ...(args.arbeitsschritte !== undefined ? { arbeitsschritte: args.arbeitsschritte } : {}),
      });
      return { geaendert: true, ...next };
    },
  });
  return [status, config];
}

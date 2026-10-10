// Instanzen (docs/PLAN_AVA_CLOUD.md §13.1): Welche AVAs des Nutzers laufen
// (Desktop-App, Server), was sie gerade tun (Telegram-Bot, Radar, Modell), und
// welche die MCP-Aufrufe aus Claude/ChatGPT beantwortet. Dazu die Einstellung
// dieser Instanz (Name, MCP an/aus) mit Bestätigung (Self-Service-Regel).

import * as yup from "yup";
import { defineTool } from "../define-tool";
import type { Tool } from "../types";
import type { InstanzStore } from "../../../core/relais/instanz";
import type { RelaisInstanz } from "../../../core/relais/kopf-relais";

export interface InstanzenToolDeps {
  instanz: InstanzStore;
  liste: () => RelaisInstanz[];
  relaisVerbunden: () => boolean;
  zustandMelden: () => void;
}

export function buildInstanzenTools(deps: InstanzenToolDeps): Tool[] {
  const liste = defineTool({
    name: "ava_instanzen",
    summary: "Welche AVAs des Nutzers laufen (Desktop, Server), mit Telegram-Bot, Radar und MCP-Ziel.",
    category: "instanzen server desktop telegram radar mcp betrieb",
    description:
      "Zeigt alle AVAs dieses Kontos (Desktop-App, Server), ob sie gerade verbunden sind, Version, welcher Telegram-Bot an welcher Instanz haengt " +
      "(je Bot nur eine Instanz), ob dort das Firmen-Radar laeuft und was es zuletzt getan hat, welches Modell aktiv ist, ob ein Idealkundenprofil " +
      "vorhanden ist und welche Instanz die MCP-Aufrufe aus Claude/ChatGPT beantwortet. Markiert, welche Instanz diese hier ist. Nur lesend.",
    parameters: { type: "object", properties: {} },
    schema: yup.object({}).noUnknown(true),
    preview: (r: Record<string, any>) => (r.error ? r.error : `${(r.instanzen ?? []).length} Instanz(en)`),
    run: async () => {
      const eigen = deps.instanz.get();
      const l = deps.liste();
      const bots = new Map<string, string[]>();
      for (const i of l) {
        const botId = (i.zustand?.telegram as { botId?: string } | undefined)?.botId;
        if (botId) bots.set(botId, [...(bots.get(botId) ?? []), i.name]);
      }
      const doppelt = [...bots.entries()].filter(([, n]) => n.length > 1).map(([botId, namen]) => ({ botId, instanzen: namen }));
      return {
        dieseInstanz: { id: eigen.id, name: eigen.name, art: eigen.art, mcp: eigen.mcp },
        relaisVerbunden: deps.relaisVerbunden(),
        instanzen: l.map((i) => ({ ...i, istDiese: i.id === eigen.id })),
        ...(doppelt.length
          ? { warnung: "Derselbe Telegram-Bot haengt an mehreren Instanzen; Telegram laesst je Bot nur einen Abholer zu. Fuer jede Instanz einen eigenen Bot anlegen.", doppelteBots: doppelt }
          : {}),
        ...(l.length === 0 ? { hinweis: "Keine Liste: Diese Instanz ist gerade nicht mit dem Gateway verbunden (nicht angemeldet oder offline)." } : {}),
      };
    },
  });

  const einstellen = defineTool({
    name: "ava_instanz_einstellen",
    summary: "Name dieser AVA-Instanz aendern oder MCP-Aufrufe hier an-/abschalten (mit Bestaetigung).",
    category: "instanzen einstellung mcp name server desktop",
    description:
      "Aendert die Einstellungen DIESER Instanz: name = Anzeigename in der Instanzenliste; mcp = ob diese Instanz MCP-Aufrufe aus Claude/ChatGPT " +
      "beantwortet (sonst uebernimmt eine andere verbundene Instanz; Server vor Desktop). Ohne Argumente: aktuelle Werte.",
    parameters: { type: "object", properties: { name: { type: "string" }, mcp: { type: "boolean" } } },
    schema: yup.object({ name: yup.string().trim().max(80).optional(), mcp: yup.boolean().optional() }).noUnknown(true),
    preview: (r: Record<string, any>) => (r.error ? r.error : r.geaendert ? "Instanz-Einstellung geaendert" : "Instanz-Einstellung gelesen"),
    run: async (args, c) => {
      if (args.name === undefined && args.mcp === undefined) return { geaendert: false, ...deps.instanz.get() };
      const teile: string[] = [];
      if (args.name !== undefined) teile.push(`Name → „${args.name}“`);
      if (args.mcp !== undefined) teile.push(`MCP-Aufrufe hier → ${args.mcp ? "an" : "aus"}`);
      const v = await c.ui.confirmAction(
        { kind: "mutating", prompt: `Diese AVA-Instanz aendern: ${teile.join(", ")}?`, confirmValue: "ja", options: [{ value: "ja", label: "Ändern" }, { value: "nein", label: "Abbrechen" }] },
        c.signal,
      );
      if (v !== "ja") return { geaendert: false, abgebrochen: true };
      const neu = deps.instanz.set({ ...(args.name !== undefined ? { name: args.name } : {}), ...(args.mcp !== undefined ? { mcp: args.mcp } : {}) });
      deps.zustandMelden();
      return { geaendert: true, ...neu, hinweis: args.name !== undefined ? "Der neue Name erscheint nach dem naechsten Verbinden in der Liste." : undefined };
    },
  });
  return [liste, einstellen];
}

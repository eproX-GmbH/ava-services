// Phase 3 Firmen-Discovery — ICP-Tools.
//
// icp_get / icp_set: Idealkundenprofil lesen/aktualisieren. Wird u. a.
// benutzt, wenn der Nutzer die ICP-Frage aus der Begruessung
// beantwortet — der Agent haelt die Antwort strukturiert hier fest.

import * as yup from "yup";
import { defineTool } from "../define-tool";
import type { GatewayClient } from "../gateway-client";
import type { LlmProviderManager } from "../providers";
import type { IcpStore } from "../icp-store";
import type { Tool } from "../types";
import { runIcpAnalysis } from "../../discovery/icp-assistant";
import { domainFromUrl } from "../../discovery/scan";
import type { CustomerProfileStore } from "../../discovery/customer-profiles";

export interface IcpToolDeps {
  icp: IcpStore;
  gateway: GatewayClient;
  providers: LlmProviderManager;
  customerStore: CustomerProfileStore;
}

export function buildIcpTools(deps: IcpToolDeps): Tool[] {
  const get = defineTool({
    name: "icp_get",
    summary:
      "Idealkundenprofil (ICP) des Nutzers lesen — Grundlage fuer Firmen-Discovery-Matches.",
    category: "icp idealkunden discovery",
    description:
      "Liest das gespeicherte Idealkundenprofil (ICP): Freitext-Beschreibung, " +
      "Branchen, Heimat-Orte + Radius, Groessen-Praeferenz, Ausschluesse. " +
      "Das ICP bleibt lokal auf der Nutzer-Maschine.",
    parameters: { type: "object", properties: {} },
    schema: yup.object({}),
    preview: () => "ICP gelesen",
    run: async () => {
      const p = deps.icp.get();
      return { ...p, gesetzt: deps.icp.isSet() };
    },
  });

  const set = defineTool({
    name: "icp_set",
    summary:
      "Idealkundenprofil (ICP) speichern/aktualisieren — IMMER aufrufen, wenn der Nutzer beschreibt, welche Firmen seine idealen Kunden sind.",
    category: "icp idealkunden discovery",
    description:
      "Speichert das Idealkundenprofil (Patch — nur uebergebene Felder " +
      "aendern sich). Rufe dieses Tool auf, wenn der Nutzer sein ICP " +
      "beschreibt oder die ICP-Frage aus der Begruessung beantwortet " +
      "(Branche, Groesse, Region). beschreibung = Freitext in den Worten " +
      "des Nutzers; branchen/orte strukturiert dazu. KEINE Vermutungen " +
      "speichern — nur, was der Nutzer gesagt hat.",
    parameters: {
      type: "object",
      properties: {
        beschreibung: { type: "string", description: "Freitext-ICP (max 2000 Zeichen)." },
        angebot: { type: "string", description: "Eigenes Angebot (Produkte/Leistungen)." },
        nutzen: { type: "string", description: "Geloestes Problem / Nutzenversprechen." },
        branchen: { type: "array", items: { type: "string" }, description: "Max 12." },
        orte: { type: "array", items: { type: "string" }, description: "Heimat-Orte fuer den Radar, max 5." },
        radiusKm: { type: "integer", description: "Radar-Umkreis (Default 50, max 200)." },
        groesse: { type: "string", description: "Groessen-Praeferenz, z. B. '10-200 Mitarbeiter'." },
        merkmale: { type: "array", items: { type: "string" }, description: "Weitere Merkmale idealer Kunden, max 10." },
        ausschluesse: { type: "string", description: "Harte Ausschluesse, z. B. 'keine Agenturen'." },
      },
    },
    schema: yup.object({
      beschreibung: yup.string().trim().max(2000).optional(),
      angebot: yup.string().trim().max(600).optional(),
      nutzen: yup.string().trim().max(600).optional(),
      branchen: yup.array().of(yup.string().trim().min(2).max(60).required()).max(12).optional(),
      orte: yup.array().of(yup.string().trim().min(2).max(80).required()).max(5).optional(),
      radiusKm: yup.number().integer().min(1).max(200).optional(),
      groesse: yup.string().trim().max(200).optional(),
      merkmale: yup.array().of(yup.string().trim().min(2).max(120).required()).max(10).optional(),
      ausschluesse: yup.string().trim().max(500).optional(),
    }),
    preview: () => "ICP aktualisiert",
    run: async (args) => {
      const merged = deps.icp.set({ ...args, quelle: "chat" });
      return { gespeichert: true, icp: merged };
    },
  });

  const assist = defineTool({
    name: "icp_assist_from_urls",
    summary:
      "ICP-Entwurf automatisch aus der eigenen Website + Kunden-Websites erstellen (Analyse, KEIN Speichern).",
    category: "icp idealkunden assistent discovery",
    description:
      "Analysiert die eigene Website des Nutzers (Angebot, Nutzen, " +
      "Standort aus dem Impressum) und bis zu 5 Websites seiner besten " +
      "Bestandskunden (Branche, Groesse, Standort) und erstellt daraus " +
      "einen ICP-Entwurf inkl. Radius-Vorschlag aus den realen " +
      "Kunden-Distanzen. Dauert 1-3 Minuten. WICHTIG: Das Ergebnis ist " +
      "NUR ein Entwurf — praesentiere ihn dem Nutzer uebersichtlich und " +
      "speichere erst nach dessen Bestaetigung via icp_set. Kunden-Daten " +
      "bleiben lokal.",
    parameters: {
      type: "object",
      required: ["eigeneUrl"],
      properties: {
        eigeneUrl: { type: "string", description: "Website des Nutzers." },
        kundenUrls: {
          type: "array",
          items: { type: "string" },
          description: "Websites der besten Bestandskunden, max 5.",
        },
      },
    },
    schema: yup.object({
      eigeneUrl: yup.string().trim().min(4).max(300).required(),
      kundenUrls: yup
        .array()
        .of(yup.string().trim().min(4).max(300).required())
        .max(5)
        .optional(),
    }),
    preview: (r) => {
      const res = r as { error?: string; kundenAnalysiert?: number };
      if (res.error) return res.error;
      return `ICP-Entwurf erstellt (${res.kundenAnalysiert ?? 0} Kunden analysiert)`;
    },
    run: async (args) => {
      const eigeneDomain = domainFromUrl(args.eigeneUrl);
      if (!eigeneDomain) {
        return { error: "Die eigene Website-URL ist nicht verwertbar." };
      }
      const kundenDomains = (args.kundenUrls ?? [])
        .map((u) => domainFromUrl(u))
        .filter((d): d is string => d !== null && d !== eigeneDomain);
      const result = await runIcpAnalysis(
        deps.gateway,
        deps.providers,
        { eigeneDomain, kundenDomains },
        () => {
          /* Chat-Pfad: kein Fortschritts-Stream noetig */
        },
        deps.customerStore,
      );
      if ("error" in result) return result;
      return {
        hinweisFuerAgent:
          "ENTWURF — dem Nutzer zusammengefasst zeigen und erst nach Bestaetigung via icp_set speichern (Felder 1:1 uebernehmen).",
        entwurf: result.icp,
        radiusBegruendung: result.radiusBegruendung,
        kundenAnalysiert: result.kunden.length,
        hinweise: result.hinweise,
      };
    },
  });

  return [get, set, assist];
}

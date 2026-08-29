// Phase 3 Firmen-Discovery — ICP-Tools.
//
// icp_get / icp_set: Idealkundenprofil lesen/aktualisieren. Wird u. a.
// benutzt, wenn der Nutzer die ICP-Frage aus der Begruessung
// beantwortet — der Agent haelt die Antwort strukturiert hier fest.

import * as yup from "yup";
import { defineTool } from "../define-tool";
import type { IcpStore } from "../icp-store";
import type { Tool } from "../types";

export interface IcpToolDeps {
  icp: IcpStore;
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

  return [get, set];
}

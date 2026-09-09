// W8 — Vorlagen: fertige Workflows zum Sofort-Anlegen (Onboarding). Sie
// nutzen nur Tools, die es gibt; Schreib-Schritte sind NICHT freigegeben,
// Trigger stehen auf manuell — der Nutzer entscheidet bewusst.

import type { WorkflowDefinition, WorkflowNode, WorkflowConnections, WorkflowTrigger, WorkflowSettings } from "../../shared/workflow-types";
import { DEFAULT_WORKFLOW_SETTINGS } from "../../shared/workflow-types";

export interface WorkflowTemplate {
  id: string;
  name: string;
  description: string;
  /** Braucht diese Tools (sonst nicht anlegbar). */
  tools: string[];
  scope: "company" | "none";
  trigger: WorkflowTrigger;
  nodes: Array<Omit<WorkflowNode, "position" | "id"> & { id?: string }>;
  connections: WorkflowConnections;
  settings?: Partial<WorkflowSettings>;
  /** Vorlage, die zuerst angelegt werden muss (Sub-Workflow). */
  requires?: string;
}

const kette = (names: string[]): WorkflowConnections => {
  const c: WorkflowConnections = {};
  for (let i = 0; i < names.length - 1; i++) c[names[i]!] = { main: [[{ node: names[i + 1]!, index: 0 }]] };
  return c;
};

export const WORKFLOW_TEMPLATES: WorkflowTemplate[] = [
  {
    id: "firmen-kurzprofil-telegram",
    name: "Firmen-Kurzprofil per Telegram",
    description: "Für eine Firma: Kurzübersicht aus dem vollständigen Firmen-Kontext erstellen und per Telegram senden. Eignet sich als Sub-Workflow.",
    tools: ["telegram_send_message"],
    scope: "company",
    trigger: { kind: "manual" },
    nodes: [
      { name: "Start", type: "trigger", parameters: {} },
      {
        name: "Kurzübersicht",
        type: "ai",
        mode: "allItems",
        parameters: {
          prompt:
            "Erstelle eine Kurzübersicht zu {{ $company.name }} für einen Vertriebler auf dem Handy: 3 bis 5 Sätze zu Tätigkeit, Größe, Finanzlage ($umsatz_letztes_jahr ?? \"Umsatz unbekannt\", $kassenbestand ?? \"Kassenbestand unbekannt\"), Auffälligkeiten und ein Gesprächsaufhänger. Ansprechpartner: $ansprechpartner_geschaeftsfuehrung ?? \"keiner bekannt\".",
          outputSchema: { type: "object", required: ["text"], properties: { text: { type: "string" } } },
        },
      },
      { name: "Telegram senden", type: "tool", mode: "allItems", parameters: { tool: "telegram_send_message", args: { text: "📌 {{ $company.name }}\n\n{{ $json.text }}" } } },
    ],
    connections: kette(["Start", "Kurzübersicht", "Telegram senden"]),
  },
  {
    id: "radar-import-bericht",
    name: "Radar-Firmen importieren, danach je Firma Bericht per Telegram",
    description: "Prime-Workflow: Radar-Kandidaten ab Mindest-Score importieren, warten bis alle verarbeitet sind, dann je Firma den Sub-Workflow „Firmen-Kurzprofil per Telegram“ starten.",
    tools: ["discovery_candidates", "discovery_decide", "transaction_entities", "telegram_send_message"],
    scope: "none",
    trigger: { kind: "manual" },
    requires: "firmen-kurzprofil-telegram",
    nodes: [
      { name: "Start", type: "trigger", parameters: {} },
      { name: "Radar-Kandidaten", type: "tool", mode: "allItems", parameters: { tool: "discovery_candidates", args: { limit: 200 } } },
      { name: "Score-Filter", type: "filter", parameters: { condition: "{{ ($json.matchScore ?? 0) >= $vars.mindestScore && !$json.bereitsInAva }}" } },
      {
        name: "Importieren",
        type: "tool",
        mode: "allItems",
        parameters: { tool: "discovery_decide", args: { decisions: "{{ $input.all().map(i => ({ discoveryId: i.json.discoveryId, decision: 'imported' })) }}" } },
      },
      { name: "Auf Verarbeitung warten", type: "wait", parameters: { transactionId: "{{ $json.transactionId }}", maxHours: 6 } },
      { name: "Firmen des Vorgangs", type: "tool", mode: "allItems", parameters: { tool: "transaction_entities", args: { transactionId: "{{ $json.transactionId }}" }, outputPath: "items" } },
      { name: "Nur fertige", type: "filter", parameters: { condition: "{{ $json.state === 'completed' }}" } },
      { name: "Bericht je Firma", type: "subworkflow", mode: "perItem", parameters: { workflowId: "" } },
    ],
    connections: kette(["Start", "Radar-Kandidaten", "Score-Filter", "Importieren", "Auf Verarbeitung warten", "Firmen des Vorgangs", "Nur fertige", "Bericht je Firma"]),
    settings: { maxItemsPerRun: 1000 },
  },
  {
    id: "radar-heiss-kurzprofil",
    name: "Neuer heißer Radar-Treffer: Kurzprofil per Telegram",
    description: "Ereignis-Workflow: Sobald der Radar einen neuen heißen Kandidaten meldet, kommt sofort ein Kurzprofil aus dem Mini-Profil per Telegram.",
    tools: ["telegram_send_message"],
    scope: "company",
    trigger: { kind: "event", event: "radar.newHot" },
    nodes: [
      { name: "Start", type: "trigger", parameters: {} },
      {
        name: "Kurzprofil",
        type: "ai",
        mode: "allItems",
        parameters: {
          prompt: "Fasse den Radar-Kandidaten {{ $company.name }} in 3 Sätzen zusammen (Tätigkeit, warum er zum ICP passt, Score {{ $json.score }}) und nenne einen Gesprächsaufhänger.",
          outputSchema: { type: "object", required: ["text"], properties: { text: { type: "string" } } },
        },
      },
      { name: "Telegram senden", type: "tool", mode: "allItems", parameters: { tool: "telegram_send_message", args: { text: "🔥 Neuer Radar-Treffer: {{ $company.name }}\n\n{{ $json.text }}\n\nEntscheiden unter Firmen → Radar." } } },
    ],
    connections: kette(["Start", "Kurzprofil", "Telegram senden"]),
  },
  {
    id: "crm-notiz-nach-import",
    name: "Nach Import: Zusammenfassung als HubSpot-Notiz",
    description: "Ereignis-Workflow: Ist eine Firma fertig verarbeitet, wird eine Kurzfassung des Profils als Notiz an die verknüpfte HubSpot-Company geschrieben (Schreib-Schritt, Freigabe nötig).",
    tools: ["crm_search_hubspot_companies", "crm_create_hubspot_note"],
    scope: "company",
    trigger: { kind: "event", event: "import.finished" },
    nodes: [
      { name: "Start", type: "trigger", parameters: {} },
      { name: "HubSpot-Company suchen", type: "tool", mode: "allItems", parameters: { tool: "crm_search_hubspot_companies", args: { query: "{{ $company.name }}", limit: 3 }, outputPath: "items" } },
      { name: "Nur eindeutige Treffer", type: "filter", parameters: { condition: "{{ $input.count === 1 }}" } },
      {
        name: "Zusammenfassung",
        type: "ai",
        mode: "allItems",
        parameters: {
          prompt: "Fasse das AVA-Profil von {{ $company.name }} als CRM-Notiz zusammen (max 8 Zeilen): Tätigkeit, Größe, Finanzen ($umsatz_letztes_jahr ?? \"unbekannt\"), Besonderheiten.",
          outputSchema: { type: "object", required: ["body"], properties: { body: { type: "string" } } },
        },
      },
      {
        name: "Notiz anlegen",
        type: "tool",
        mode: "allItems",
        parameters: { tool: "crm_create_hubspot_note", args: { body: "{{ $json.body }}", associations: [{ objectType: "companies", objectId: "{{ $('HubSpot-Company suchen').item.json.id }}" }] } },
      },
    ],
    connections: kette(["Start", "HubSpot-Company suchen", "Nur eindeutige Treffer", "Zusammenfassung", "Notiz anlegen"]),
  },
];

export function templateToDefinition(t: WorkflowTemplate, subWorkflowId?: string): Pick<WorkflowDefinition, "name" | "description" | "nodes" | "connections" | "trigger" | "variables" | "settings" | "origin"> {
  const nodes: WorkflowNode[] = t.nodes.map((n, i) => ({
    ...n,
    id: n.id ?? `n${i}`,
    position: [80 + i * 260, 120] as [number, number],
    parameters: n.type === "subworkflow" && subWorkflowId ? { ...n.parameters, workflowId: subWorkflowId } : n.parameters,
  }));
  return {
    name: t.name,
    description: t.description,
    nodes,
    connections: t.connections,
    variables: t.id === "radar-import-bericht" ? { mindestScore: { label: "Mindest-Score", type: "number", value: 80 } } : {},
    settings: { ...DEFAULT_WORKFLOW_SETTINGS, scope: t.scope, ...(t.settings ?? {}) },
    origin: { kind: "assistant" },
    trigger: t.trigger,
  };
}

// W1 — Node-Katalog: aus der ToolRegistry generiert plus Logik-Nodes.
// Bestimmt, welche Tools als Workflow-Node zulaessig sind, ihre
// Wirkungsklasse (Vollmacht), Kostenklasse und wie Ergebnisse zu Items werden.

import type { ToolRegistry } from "../agent/tool-registry";
import type { WorkflowCatalogEntry } from "../../shared/workflow-types";

/** Nie als Node: Meta-, Rueckfrage-, Consent- und Schluessel-Tools. */
const NOT_ALLOWED_RE =
  /^(ask_user_|tool_search$|tool_load$|skill_|chat_history_|workflow_|connect_|disconnect_|settings_set_key|.*_key(_|$)|telegram_(connect|disconnect|token|link_chat|set_enabled)|voice_|updater_|producer_|ollama_(pull|delete)|org_(join|leave|create|member_)|profile_reset|report_self_correction$|memory_)/;

const DESTRUCTIVE_RE = /(_delete|_remove|_clear|_reset|_disconnect)/;
const MUTATING_RE = /(_update|_sync|_enrich|_associate|_disassociate|_complete|_link|_archive|_mark|_decide|_set|_pause|_resume|_cancel|_approve|_reject|_pin|_unpin|_rename|_move)/;
const ADDITIVE_RE = /(_create|_send|_reply|_forward|_log|_append|_register|_add|_start|_run|_import|_share|_write|_schedule)/;

const KONTINGENT_RE = /^(discovery_scan|discovery_decide|import_|evaluation_start|radar_run|company_(profile|publications|contacts))/;
const EXTERN_RE = /^(crm_|mail_|notion_|obsidian_|linkedin_|watchlist_|personen_radar|apify)/;
const KI_RE = /^(evaluation_|icp_assist|deep_research|research_)/;

export function toolActionKind(name: string): WorkflowCatalogEntry["actionKind"] {
  if (DESTRUCTIVE_RE.test(name)) return "destructive";
  if (MUTATING_RE.test(name)) return "mutating";
  if (ADDITIVE_RE.test(name)) return "additive";
  return "read";
}

export function toolCostClass(name: string): WorkflowCatalogEntry["costClass"] {
  if (KONTINGENT_RE.test(name)) return "kontingent";
  if (KI_RE.test(name)) return "ki";
  if (EXTERN_RE.test(name)) return "extern";
  return "frei";
}

export function isToolAllowedInWorkflows(name: string): boolean {
  return !NOT_ALLOWED_RE.test(name);
}

/** Bekannte Listen-Schluessel, unter denen Tools ihre Zeilen liefern. */
export const OUTPUT_LIST_KEYS = ["items", "rows", "candidates", "companies", "contacts", "results", "records", "entries", "matches", "ergebnisse", "kandidaten", "firmen", "personen", "messages", "alerts", "deals", "owners", "associations", "jeTag", "hits"];

export const LOGIC_NODES: WorkflowCatalogEntry[] = [
  { type: "trigger", label: "Start", category: "Ablauf", summary: "Ausloeser des Workflows (manuell, Zeitplan, Ereignis, Chat).", parameters: { type: "object", properties: {} }, write: false, actionKind: "read", costClass: "frei" },
  { type: "filter", label: "Filter", category: "Ablauf", summary: "Behaelt nur Items, fuer die die Bedingung gilt.", parameters: { type: "object", required: ["condition"], properties: { condition: { type: "string", description: "Expression, z. B. {{ $json.matchScore >= 80 }}" } } }, write: false, actionKind: "read", costClass: "frei" },
  { type: "if", label: "Wenn / sonst", category: "Ablauf", summary: "Verzweigt je Item: Ausgang 0 = wahr, Ausgang 1 = falsch.", parameters: { type: "object", required: ["condition"], properties: { condition: { type: "string" } } }, write: false, actionKind: "read", costClass: "frei" },
  { type: "switch", label: "Verzweigung", category: "Ablauf", summary: "Verzweigt nach Wert: cases[i].match → Ausgang i; sonst letzter Ausgang.", parameters: { type: "object", required: ["value", "cases"], properties: { value: { type: "string", description: "Expression" }, cases: { type: "array", items: { type: "object", properties: { label: { type: "string" }, match: { type: "string" } } } } } }, write: false, actionKind: "read", costClass: "frei" },
  { type: "transform", label: "Felder setzen", category: "Ablauf", summary: "Neue Felder je Item setzen (Expressions), optional nur diese behalten.", parameters: { type: "object", required: ["fields"], properties: { fields: { type: "object", additionalProperties: { type: "string" } }, keepOnly: { type: "boolean" } } }, write: false, actionKind: "read", costClass: "frei" },
  { type: "loop", label: "Schleife (Batches)", category: "Ablauf", summary: "Teilt Items in Batches; Ausgang 0 = loop (je Batch), Ausgang 1 = done (alle Ergebnisse).", parameters: { type: "object", properties: { batchSize: { type: "integer", minimum: 1, default: 10 } } }, write: false, actionKind: "read", costClass: "frei" },
  { type: "merge", label: "Zusammenfuehren", category: "Ablauf", summary: "Wartet auf alle Eingaenge; append oder Verbinden nach Schluessel.", parameters: { type: "object", properties: { mode: { type: "string", enum: ["append", "byKey"], default: "append" }, key: { type: "string" } } }, write: false, actionKind: "read", costClass: "frei" },
  { type: "ai", label: "KI-Schritt", category: "KI", summary: "Hintergrund-Modell mit festem Prompt und Pflicht-Ausgabeschema (JSON) je Item.", parameters: { type: "object", required: ["prompt", "outputSchema"], properties: { system: { type: "string" }, prompt: { type: "string", description: "Mit Expressions" }, outputSchema: { type: "object", description: "JSON-Schema der Antwort" } } }, write: false, actionKind: "read", costClass: "ki" },
  { type: "wait", label: "Warten", category: "Ablauf", summary: "Wartet eine Zeitspanne (max 7 Tage) ODER bis das Firmenprofil aller Firmen eines Vorgangs (Import) verarbeitet ist (Watcher). Ausgabe: ein Item je Firma mit companyId, state (completed/failed), fehlgeschlageneStufen, transactionId.", parameters: { type: "object", properties: { minutes: { type: "number", minimum: 1, maximum: 10080 }, transactionId: { type: "string", description: "Vorgangs-ID, z. B. {{ $json.transactionId }} aus discovery_decide/import — wartet bis das Firmenprofil aller Firmen im Endzustand ist; danach ein Item je Firma" }, maxHours: { type: "number", default: 6 } } }, write: false, actionKind: "read", costClass: "frei" },
  { type: "human", label: "Freigabe (Mensch)", category: "Ablauf", summary: "Haelt den Lauf an, bis der Nutzer die Items freigibt oder ablehnt (Liste „Offene Freigaben“).", parameters: { type: "object", required: ["prompt"], properties: { prompt: { type: "string", description: "Was wird freigegeben? Mit Expressions, z. B. {{ $input.count }} Mails senden" }, previewFields: { type: "array", items: { type: "string" } } } }, write: false, actionKind: "read", costClass: "frei" },
  { type: "stop", label: "Abbrechen mit Fehler", category: "Ablauf", summary: "Bricht den Lauf mit einer Meldung ab.", parameters: { type: "object", properties: { message: { type: "string" } } }, write: false, actionKind: "read", costClass: "frei" },
  { type: "subworkflow", label: "Sub-Workflow", category: "Ablauf", summary: "Fuehrt einen anderen Workflow mit den Items aus.", parameters: { type: "object", required: ["workflowId"], properties: { workflowId: { type: "string" } } }, write: false, actionKind: "read", costClass: "frei" },
  { type: "note", label: "Notiz", category: "Ablauf", summary: "Sticky Note, ohne Funktion.", parameters: { type: "object", properties: { text: { type: "string" } } }, write: false, actionKind: "read", costClass: "frei" },
];

export function buildCatalog(registry: ToolRegistry): WorkflowCatalogEntry[] {
  const tools: WorkflowCatalogEntry[] = registry
    .list()
    .filter((t) => isToolAllowedInWorkflows(t.name))
    .map((t) => {
      const kind = toolActionKind(t.name);
      return {
        type: `tool:${t.name}`,
        label: t.name.replace(/_/g, " "),
        category: t.category ?? "Tools",
        summary: t.summary ?? t.description.split(/(?<=\.)\s/)[0]!.slice(0, 200),
        parameters: t.parameters,
        write: kind !== "read",
        actionKind: kind,
        costClass: toolCostClass(t.name),
      };
    })
    .sort((a, b) => a.category.localeCompare(b.category) || a.type.localeCompare(b.type));
  return [...LOGIC_NODES, ...tools];
}

/** Kompakte Katalog-Beschreibung fuer den Agenten (workflow_draft). */
export function catalogForAgent(entries: WorkflowCatalogEntry[]): string {
  const lines: string[] = [];
  for (const e of entries) {
    const props = (e.parameters as { properties?: Record<string, { type?: string; description?: string }>; required?: string[] }).properties ?? {};
    const req = new Set((e.parameters as { required?: string[] }).required ?? []);
    const params = Object.entries(props)
      .slice(0, 12)
      .map(([k, v]) => `${k}${req.has(k) ? "*" : ""}:${v.type ?? "any"}`)
      .join(", ");
    lines.push(`${e.type} [${e.category}${e.write ? `, ${e.actionKind}` : ""}] — ${e.summary} (${params || "keine Parameter"})`);
  }
  return lines.join("\n");
}

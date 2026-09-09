// W2 — Trace → Workflow: Tool-Aufrufe einer Konversation zu einem
// Workflow-Entwurf kompilieren (docs/PLAN_WORKFLOWS.md §6 A).
//
// Ohne LLM, konservativ:
//   1. Meta-/Rueckfrage-/Skill-Tools raus.
//   2. Fehlversuche mit spaeterem erfolgreichem Aufruf desselben Tools
//      werden auf den Erfolg reduziert.
//   3. Wiederholte gleichartige Aufrufe (gleiches Tool, gleiche Arg-Form,
//      andere Werte) werden zu EINEM Node im Modus perItem gefaltet; die
//      variierenden Argumente werden zu Expressions auf den Vorgaenger.
//   4. Argumentwerte, die woertlich in einem frueheren Ergebnis vorkommen
//      (IDs, Domains, E-Mail-Adressen), werden zu Expressions
//      `{{ $('<Node>').item.json.<feld> }}`; unsichere Zuordnungen bekommen
//      einen Hinweis „pruefen“ statt einer falschen Expression.
//   5. ask_user_choice-Antworten werden zu Variablen ($vars).

import type { AgentMessage } from "../../shared/types";
import type { WorkflowConnections, WorkflowNode, WorkflowVariable } from "../../shared/workflow-types";
import { isToolAllowedInWorkflows } from "./catalog";

export interface CompiledDraft {
  name: string;
  description: string;
  nodes: Array<Omit<WorkflowNode, "position"> & { position: [number, number] }>;
  connections: WorkflowConnections;
  variables: Record<string, WorkflowVariable>;
  hinweise: string[];
}

interface Step {
  messageId: string;
  callId: string;
  tool: string;
  args: Record<string, unknown>;
  ok: boolean;
  result: unknown;
}

const IGNORED_RE = /^(tool_search|tool_load|skill_|ask_user_|chat_history_|report_self_correction|workflow_|memory_)/;

export function compileConversation(
  messages: AgentMessage[],
  opts: { sinceMessageId?: string; name?: string; toolAllowed: (name: string) => boolean },
): CompiledDraft {
  const hinweise: string[] = [];
  // 1. Schritte einsammeln (assistant toolCalls + tool-Ergebnisse).
  const startIdx = opts.sinceMessageId ? Math.max(0, messages.findIndex((m) => m.id === opts.sinceMessageId)) : 0;
  const results = new Map<string, { ok: boolean; result: unknown }>();
  for (const m of messages.slice(startIdx)) {
    if (m.role === "tool" && m.toolCallId) {
      let parsed: unknown = m.content;
      try {
        parsed = JSON.parse(m.content);
      } catch {
        /* Text */
      }
      const ok = !(parsed && typeof parsed === "object" && ("error" in (parsed as object) || (parsed as { ok?: boolean }).ok === false));
      results.set(m.toolCallId, { ok, result: parsed });
    }
  }
  const steps: Step[] = [];
  const answers: Array<{ prompt: string; value: string }> = [];
  for (const m of messages.slice(startIdx)) {
    if (m.role !== "assistant") continue;
    for (const tc of m.toolCalls ?? []) {
      if (/^ask_user_(choice|text)$/.test(tc.name)) {
        const r = results.get(tc.id);
        const args = (tc.args ?? {}) as { prompt?: string };
        const val = r && typeof r.result === "object" && r.result ? String((r.result as { value?: unknown; answer?: unknown }).value ?? (r.result as { answer?: unknown }).answer ?? "") : "";
        if (val) answers.push({ prompt: args.prompt ?? tc.name, value: val });
        continue;
      }
      if (IGNORED_RE.test(tc.name)) continue;
      if (!isToolAllowedInWorkflows(tc.name)) {
        hinweise.push(`Tool ${tc.name} ist in Workflows nicht erlaubt und wurde ausgelassen.`);
        continue;
      }
      if (!opts.toolAllowed(tc.name)) {
        hinweise.push(`Tool ${tc.name} ist derzeit nicht verfuegbar (Policy) — Node wurde trotzdem aufgenommen.`);
      }
      const r = results.get(tc.id) ?? { ok: false, result: null };
      steps.push({ messageId: m.id, callId: tc.id, tool: tc.name, args: (tc.args ?? {}) as Record<string, unknown>, ok: r.ok, result: r.result });
    }
  }

  // 2. Fehlversuche reduzieren: gescheiterter Aufruf, dem ein erfolgreicher
  //    desselben Tools folgt → weg.
  const reduced: Step[] = [];
  for (let i = 0; i < steps.length; i++) {
    const s = steps[i]!;
    if (!s.ok && steps.slice(i + 1).some((t) => t.tool === s.tool && t.ok)) continue;
    reduced.push(s);
  }

  // 3. Falten: aufeinanderfolgende Aufrufe desselben Tools mit gleicher Arg-Form.
  const groups: Step[][] = [];
  for (const s of reduced) {
    const last = groups.at(-1);
    if (last && last[0]!.tool === s.tool && sameShape(last[0]!.args, s.args)) last.push(s);
    else groups.push([s]);
  }

  // 4. Nodes bauen + Datenfluss rekonstruieren.
  const nodes: CompiledDraft["nodes"] = [];
  const connections: WorkflowConnections = {};
  const usedNames = new Set<string>();
  const uniqueName = (base: string): string => {
    let n = base, i = 2;
    while (usedNames.has(n)) n = `${base} ${i++}`;
    usedNames.add(n);
    return n;
  };
  const startName = uniqueName("Start");
  nodes.push({ id: "n0", name: startName, type: "trigger", position: [80, 120], parameters: {} });
  // Ergebnis-Felder frueherer Nodes: Wert → { node, feld }
  const valueIndex = new Map<string, { node: string; feld: string }>();
  let prev = startName;
  groups.forEach((group, gi) => {
    const first = group[0]!;
    const name = uniqueName(labelFor(first.tool));
    const id = `n${gi + 1}`;
    const perItem = group.length > 1;
    // Argumente: bei Faltung die variierenden Felder → Expression auf Vorgaenger;
    // sonst woertliche Treffer im Value-Index → Expression.
    const args: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(first.args)) {
      const variiert = perItem && group.some((s) => JSON.stringify(s.args[k]) !== JSON.stringify(v));
      if (variiert) {
        // Aus welchem Vorgaenger-Feld stammen die Werte?
        const quelle = group.map((s) => valueIndex.get(scalarKey(s.args[k]))).filter(Boolean) as Array<{ node: string; feld: string }>;
        const feld = quelle.length > 0 ? quelle[0]! : null;
        if (feld && quelle.every((q) => q.node === feld.node && q.feld === feld.feld)) {
          args[k] = `{{ $('${feld.node}').item.json.${feld.feld} }}`;
        } else {
          args[k] = `{{ $json.${k} }}`;
          hinweise.push(`„${name}“: Argument ${k} variiert je Aufruf; Herkunft nicht eindeutig — pruefen (angenommen: Feld ${k} des Eingabe-Items).`);
        }
        continue;
      }
      const hit = valueIndex.get(scalarKey(v));
      if (hit && ((typeof v === "string" && v.length >= 3) || typeof v === "number")) {
        args[k] = `{{ $('${hit.node}').item.json.${hit.feld} }}`;
      } else {
        args[k] = v;
      }
    }
    nodes.push({
      id,
      name,
      type: "tool",
      position: [80 + (gi + 1) * 260, 120],
      parameters: { tool: first.tool, args },
      ...(perItem ? { mode: "perItem" as const } : { mode: "allItems" as const }),
    });
    connections[prev] = { main: [[{ node: name, index: 0 }]] };
    prev = name;
    // Value-Index aus den Ergebnissen fuellen (flach, erste Ebene + Listen-Elemente).
    for (const s of group) indexResult(s.result, name, valueIndex);
    if (group.length > 1) hinweise.push(`${group.length} Aufrufe von ${first.tool} zu einem Schritt „${name}“ (je Item) zusammengefasst.`);
  });

  // 5. Variablen aus Rueckfragen.
  const variables: Record<string, WorkflowVariable> = {};
  answers.forEach((a, i) => {
    const key = `antwort${i + 1}`;
    variables[key] = { label: a.prompt.slice(0, 80), type: "string", value: a.value, description: "Aus einer Rueckfrage im Chat uebernommen" };
  });
  if (answers.length > 0) hinweise.push(`${answers.length} Rueckfrage-Antworten als Variablen uebernommen ($vars.antwortN) — bei Bedarf in Node-Argumente einsetzen.`);

  return {
    name: opts.name ?? `Workflow ${new Date().toLocaleDateString("de-DE")}`,
    description: `Aus einer Konversation uebernommen: ${groups.map((g) => g[0]!.tool).join(" → ")}`,
    nodes,
    connections,
    variables,
    hinweise,
  };
}

function labelFor(tool: string): string {
  return tool.replace(/^(crm|mail|company|discovery|notion|obsidian|linkedin|icp|evaluation)_/, (m) => `${m.slice(0, -1)}: `).replace(/_/g, " ");
}

function sameShape(a: Record<string, unknown>, b: Record<string, unknown>): boolean {
  const ka = Object.keys(a).sort().join(","), kb = Object.keys(b).sort().join(",");
  return ka === kb;
}

function scalarKey(v: unknown): string {
  return typeof v === "string" || typeof v === "number" ? String(v).trim().toLowerCase() : "";
}

function indexResult(result: unknown, node: string, index: Map<string, { node: string; feld: string }>): void {
  const addObj = (obj: Record<string, unknown>): void => {
    for (const [k, v] of Object.entries(obj)) {
      if ((typeof v === "string" && v.length >= 3) || typeof v === "number") {
        const key = scalarKey(v);
        if (key && !index.has(key)) index.set(key, { node, feld: k });
      }
    }
  };
  if (!result || typeof result !== "object") return;
  if (Array.isArray(result)) {
    for (const r of result.slice(0, 200)) if (r && typeof r === "object") addObj(r as Record<string, unknown>);
    return;
  }
  const obj = result as Record<string, unknown>;
  addObj(obj);
  for (const v of Object.values(obj)) {
    if (Array.isArray(v)) for (const r of v.slice(0, 200)) if (r && typeof r === "object") addObj(r as Record<string, unknown>);
  }
}

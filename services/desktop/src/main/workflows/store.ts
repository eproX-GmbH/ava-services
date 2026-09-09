// W1 — Ablage: Definitionen, Laeufe, Freigaben, Idempotenz-Zustand.
// Lokal je Nutzer unter <userData>/workflows/ (Entscheidung 2026-09-09:
// Workflows liegen auf dem Geraet; Teilen mit der Organisation kommt in W7).

import { app } from "electron";
import { existsSync, mkdirSync, readdirSync, readFileSync, unlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import * as yup from "yup";
import type {
  WorkflowApproval,
  WorkflowDefinition,
  WorkflowExecution,
  WorkflowNode,
} from "../../shared/workflow-types";
import { DEFAULT_WORKFLOW_SETTINGS } from "../../shared/workflow-types";
import { referencedNodeNames } from "./expressions";

const NODE_TYPES = ["trigger", "tool", "filter", "transform", "if", "switch", "loop", "merge", "ai", "wait", "human", "stop", "subworkflow", "note"] as const;

const nodeSchema = yup.object({
  id: yup.string().trim().min(1).required(),
  name: yup.string().trim().min(1).max(80).required(),
  type: yup.string().oneOf([...NODE_TYPES]).required(),
  position: yup.array().of(yup.number().required()).length(2).required(),
  parameters: yup.object().default({}),
  mode: yup.string().oneOf(["perItem", "allItems"]).optional(),
  disabled: yup.boolean().optional(),
  onError: yup.string().oneOf(["stop", "continue", "errorOutput"]).optional(),
  retryOnFail: yup.boolean().optional(),
  maxTries: yup.number().integer().min(1).max(5).optional(),
  waitBetweenTriesSec: yup.number().min(0).max(600).optional(),
  confirmed: yup.boolean().optional(),
  notes: yup.string().max(2000).optional(),
});

const triggerSchema = yup.object({
  kind: yup.string().oneOf(["manual", "schedule", "event", "chat"]).required(),
  intervalMinutes: yup.number().integer().min(15).max(60 * 24 * 30).optional(),
  at: yup.string().matches(/^\d{2}:\d{2}$/).optional(),
  weekdays: yup.array().of(yup.number().integer().min(0).max(6).required()).optional(),
  event: yup.string().oneOf(["radar.newHot", "mail.inbound", "alert.created", "import.finished"]).optional(),
  filter: yup.object().optional(),
});

const definitionSchema = yup.object({
  id: yup.string().trim().min(1).required(),
  name: yup.string().trim().min(1).max(120).required(),
  description: yup.string().max(2000).default(""),
  version: yup.number().integer().min(1).required(),
  nodes: yup.array().of(nodeSchema).min(1).max(200).required(),
  connections: yup.object().default({}),
  variables: yup.object().default({}),
  trigger: triggerSchema.required(),
  settings: yup.object({
    executionOrder: yup.string().oneOf(["v1"]).default("v1"),
    timeoutMinutes: yup.number().integer().min(1).max(24 * 60).default(60),
    maxItemsPerRun: yup.number().integer().min(1).max(5000).default(500),
    autonomy: yup.string().oneOf(["inherit", "none", "additive", "mutating"]).default("inherit"),
    maxMailsPerDay: yup.number().integer().min(0).max(1000).default(20),
    notifyOnFinish: yup.boolean().default(true),
    errorWorkflowId: yup.string().optional(),
  }).default(DEFAULT_WORKFLOW_SETTINGS),
  origin: yup.object({
    kind: yup.string().oneOf(["chat", "assistant", "manual", "import", "org"]).required(),
    conversationId: yup.string().optional(),
  }).required(),
  enabled: yup.boolean().default(true),
  createdAt: yup.string().required(),
  updatedAt: yup.string().required(),
  createdBy: yup.string().oneOf(["user", "agent"]).required(),
  pinData: yup.object().optional(),
  sharedFrom: yup.object().nullable().optional(),
});

export interface ValidationProblem {
  node?: string;
  message: string;
}

/** Strukturpruefung ueber das Schema hinaus: Namen, Kanten, Trigger, Zyklen. */
export function validateDefinition(def: WorkflowDefinition, toolExists: (name: string) => boolean): ValidationProblem[] {
  const problems: ValidationProblem[] = [];
  const names = new Map<string, WorkflowNode>();
  for (const n of def.nodes) {
    if (names.has(n.name)) problems.push({ node: n.name, message: `Node-Name doppelt: „${n.name}“` });
    names.set(n.name, n);
  }
  const triggers = def.nodes.filter((n) => n.type === "trigger");
  if (triggers.length !== 1) problems.push({ message: `Genau ein Start-Node (trigger) noetig, gefunden: ${triggers.length}` });
  for (const n of def.nodes) {
    if (n.type === "tool") {
      const tool = typeof n.parameters.tool === "string" ? n.parameters.tool : "";
      if (!tool) problems.push({ node: n.name, message: "Tool-Node ohne `parameters.tool`" });
      else if (!toolExists(tool)) problems.push({ node: n.name, message: `Tool nicht verfuegbar oder nicht fuer Workflows freigegeben: ${tool}` });
    }
    if ((n.type === "filter" || n.type === "if") && typeof n.parameters.condition !== "string") {
      problems.push({ node: n.name, message: "Bedingung fehlt (`parameters.condition` als Expression)" });
    }
    if (n.type === "ai" && typeof n.parameters.prompt !== "string") {
      problems.push({ node: n.name, message: "KI-Node ohne `parameters.prompt`" });
    }
    if (n.type === "subworkflow" && typeof n.parameters.workflowId !== "string") {
      problems.push({ node: n.name, message: "Sub-Workflow ohne `parameters.workflowId`" });
    }
    for (const ref of referencedNodeNames(n.parameters)) {
      if (!names.has(ref)) problems.push({ node: n.name, message: `Expression verweist auf unbekannten Node „${ref}“` });
    }
  }
  for (const [from, conn] of Object.entries(def.connections)) {
    if (!names.has(from)) {
      problems.push({ message: `Kante von unbekanntem Node „${from}“` });
      continue;
    }
    (conn?.main ?? []).forEach((targets, outIdx) => {
      for (const t of targets ?? []) {
        if (!names.has(t.node)) problems.push({ node: from, message: `Kante (Ausgang ${outIdx}) zu unbekanntem Node „${t.node}“` });
      }
    });
  }
  // Zyklen (nur ueber Loop-Nodes erlaubt: Kante zurueck ZU einem loop-Node ist ok).
  const adj = new Map<string, string[]>();
  for (const [from, conn] of Object.entries(def.connections)) {
    adj.set(from, (conn?.main ?? []).flat().map((t) => t.node));
  }
  const state = new Map<string, 0 | 1 | 2>();
  const visit = (n: string, path: string[]): void => {
    const st = state.get(n) ?? 0;
    if (st === 1) {
      const target = names.get(n);
      if (target?.type !== "loop") problems.push({ node: n, message: `Zyklus ohne Loop-Node: ${[...path, n].join(" → ")}` });
      return;
    }
    if (st === 2) return;
    state.set(n, 1);
    for (const next of adj.get(n) ?? []) visit(next, [...path, n]);
    state.set(n, 2);
  };
  for (const n of names.keys()) visit(n, []);
  return problems;
}

export class WorkflowStore {
  readonly dir: string;
  private cache: Map<string, WorkflowDefinition> | null = null;

  constructor(dir?: string) {
    this.dir = dir ?? join(app.getPath("userData"), "workflows");
  }

  private ensureDirs(): void {
    mkdirSync(join(this.dir, "executions"), { recursive: true });
    mkdirSync(join(this.dir, "approvals"), { recursive: true });
    mkdirSync(join(this.dir, "state"), { recursive: true });
  }

  // ---- Definitionen ----------------------------------------------------------

  private load(): Map<string, WorkflowDefinition> {
    if (this.cache) return this.cache;
    this.ensureDirs();
    const map = new Map<string, WorkflowDefinition>();
    for (const f of readdirSync(this.dir).filter((f) => f.endsWith(".json"))) {
      try {
        const raw = JSON.parse(readFileSync(join(this.dir, f), "utf8"));
        const def = definitionSchema.validateSync(raw, { stripUnknown: false }) as unknown as WorkflowDefinition;
        map.set(def.id, def);
      } catch (err) {
        console.warn(`[workflows] ${f} unlesbar:`, err instanceof Error ? err.message : String(err));
      }
    }
    this.cache = map;
    return map;
  }

  list(): WorkflowDefinition[] {
    return [...this.load().values()].sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
  }

  get(id: string): WorkflowDefinition | null {
    return this.load().get(id) ?? null;
  }

  findByName(name: string): WorkflowDefinition | null {
    const n = name.trim().toLowerCase();
    return this.list().find((w) => w.name.trim().toLowerCase() === n) ?? null;
  }

  /** Neu anlegen oder ueberschreiben (Version +1). Wirft bei Schema-Fehlern. */
  save(input: Partial<WorkflowDefinition> & Pick<WorkflowDefinition, "name" | "nodes" | "connections" | "trigger">, opts: { createdBy: "user" | "agent" }): WorkflowDefinition {
    const map = this.load();
    const existing = input.id ? map.get(input.id) : null;
    const now = new Date().toISOString();
    const merged: WorkflowDefinition = {
      id: existing?.id ?? input.id ?? `wf_${randomUUID().slice(0, 12)}`,
      name: input.name,
      description: input.description ?? existing?.description ?? "",
      version: (existing?.version ?? 0) + 1,
      nodes: input.nodes,
      connections: input.connections,
      variables: input.variables ?? existing?.variables ?? {},
      trigger: input.trigger,
      settings: { ...DEFAULT_WORKFLOW_SETTINGS, ...(existing?.settings ?? {}), ...(input.settings ?? {}) },
      origin: input.origin ?? existing?.origin ?? { kind: "manual" },
      enabled: input.enabled ?? existing?.enabled ?? true,
      createdAt: existing?.createdAt ?? now,
      updatedAt: now,
      createdBy: existing?.createdBy ?? opts.createdBy,
      ...(input.pinData !== undefined ? { pinData: input.pinData } : existing?.pinData ? { pinData: existing.pinData } : {}),
      sharedFrom: input.sharedFrom ?? existing?.sharedFrom ?? null,
    };
    const def = definitionSchema.validateSync(merged, { stripUnknown: false }) as unknown as WorkflowDefinition;
    writeFileSync(join(this.dir, `${def.id}.json`), JSON.stringify(def, null, 2), "utf8");
    map.set(def.id, def);
    return def;
  }

  patch(id: string, patch: Partial<WorkflowDefinition>): WorkflowDefinition | null {
    const cur = this.get(id);
    if (!cur) return null;
    return this.save({ ...cur, ...patch, id }, { createdBy: cur.createdBy });
  }

  delete(id: string): boolean {
    const map = this.load();
    if (!map.has(id)) return false;
    try {
      unlinkSync(join(this.dir, `${id}.json`));
    } catch {
      /* weg ist weg */
    }
    map.delete(id);
    return true;
  }

  // ---- Laeufe -----------------------------------------------------------------

  private execDir(workflowId: string): string {
    const d = join(this.dir, "executions", workflowId);
    mkdirSync(d, { recursive: true });
    return d;
  }

  saveExecution(ex: WorkflowExecution): void {
    writeFileSync(join(this.execDir(ex.workflowId), `${ex.id}.json`), JSON.stringify(ex), "utf8");
  }

  listExecutions(workflowId: string, limit = 50): WorkflowExecution[] {
    const d = this.execDir(workflowId);
    return readdirSync(d)
      .filter((f) => f.endsWith(".json"))
      .map((f) => {
        try {
          return JSON.parse(readFileSync(join(d, f), "utf8")) as WorkflowExecution;
        } catch {
          return null;
        }
      })
      .filter((e): e is WorkflowExecution => e !== null)
      .sort((a, b) => b.startedAt.localeCompare(a.startedAt))
      .slice(0, limit);
  }

  getExecution(workflowId: string, executionId: string): WorkflowExecution | null {
    const p = join(this.execDir(workflowId), `${executionId}.json`);
    if (!existsSync(p)) return null;
    try {
      return JSON.parse(readFileSync(p, "utf8")) as WorkflowExecution;
    } catch {
      return null;
    }
  }

  /** Aufbewahrung: 200 Laeufe je Workflow, aeltere loeschen. */
  pruneExecutions(workflowId: string, keep = 200): void {
    const all = this.listExecutions(workflowId, 10_000);
    for (const ex of all.slice(keep)) {
      try {
        unlinkSync(join(this.execDir(workflowId), `${ex.id}.json`));
      } catch {
        /* egal */
      }
    }
  }

  deleteExecutions(workflowId: string): void {
    const d = this.execDir(workflowId);
    for (const f of readdirSync(d)) {
      try {
        unlinkSync(join(d, f));
      } catch {
        /* egal */
      }
    }
  }

  // ---- Freigaben (Human-in-the-Loop) ------------------------------------------

  private approvalsPath(): string {
    this.ensureDirs();
    return join(this.dir, "approvals", "open.json");
  }

  listApprovals(): WorkflowApproval[] {
    const p = this.approvalsPath();
    if (!existsSync(p)) return [];
    try {
      return JSON.parse(readFileSync(p, "utf8")) as WorkflowApproval[];
    } catch {
      return [];
    }
  }

  saveApprovals(list: WorkflowApproval[]): void {
    writeFileSync(this.approvalsPath(), JSON.stringify(list.slice(-500)), "utf8");
  }

  // ---- Idempotenz-Zustand ---------------------------------------------------

  private statePath(workflowId: string): string {
    this.ensureDirs();
    return join(this.dir, "state", `${workflowId}.json`);
  }

  getState(workflowId: string): { processedKeys: Record<string, string[]>; mailsToday: { day: string; count: number } } {
    const p = this.statePath(workflowId);
    if (!existsSync(p)) return { processedKeys: {}, mailsToday: { day: "", count: 0 } };
    try {
      const raw = JSON.parse(readFileSync(p, "utf8"));
      return {
        processedKeys: raw.processedKeys ?? {},
        mailsToday: raw.mailsToday ?? { day: "", count: 0 },
      };
    } catch {
      return { processedKeys: {}, mailsToday: { day: "", count: 0 } };
    }
  }

  saveState(workflowId: string, state: { processedKeys: Record<string, string[]>; mailsToday: { day: string; count: number } }): void {
    // Schluessel je Node auf 5000 begrenzen.
    for (const k of Object.keys(state.processedKeys)) {
      const arr = state.processedKeys[k]!;
      if (arr.length > 5000) state.processedKeys[k] = arr.slice(-5000);
    }
    writeFileSync(this.statePath(workflowId), JSON.stringify(state), "utf8");
  }

  deleteState(workflowId: string): void {
    try {
      unlinkSync(this.statePath(workflowId));
    } catch {
      /* egal */
    }
  }
}

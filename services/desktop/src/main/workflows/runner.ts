// W1 — Workflow-Engine: fuehrt eine Definition deterministisch aus.
//
// Reihenfolge nach n8n v1: ein Node laeuft, sobald alle seine Vorgaenger
// fertig sind; unter mehreren bereiten Nodes gewinnt der obere, dann der
// linke (Position). Items fliessen als `{ json, pairedItem }`; ein Node
// laeuft je Item (perItem) oder einmal fuer alle (allItems).
//
// Schreib-Nodes laufen unbeaufsichtigt nur, wenn die Vollmacht die Klasse
// deckt oder der Node freigegeben ist (`confirmed`); sonst haelt der Lauf
// an und legt eine Freigabe an (Human-in-the-Loop). `mail_send` braucht
// IMMER Freigabe oder `confirmed` und unterliegt dem Tages-Deckel.

import { randomUUID } from "node:crypto";
import type { ToolRegistry } from "../agent/tool-registry";
import type { ToolContext } from "../agent/types";
import { UiBridge, autonomyCovers, type ActionKind, type RemoteAskHandler } from "../agent/ui-bridge";
import type { AgentChoiceOption, AutonomyLevel } from "../../shared/types";
import type { LlmProviderManager } from "../agent/providers";
import { buildMessages, parseJsonObject, streamToText } from "../link-monitor/llm";
import type {
  WorkflowApproval,
  WorkflowDefinition,
  WorkflowExecution,
  WorkflowItem,
  WorkflowNode,
  WorkflowNodeRun,
  WorkflowProgressFrame,
} from "../../shared/workflow-types";
import type { WorkflowStore } from "./store";
import { isToolAllowedInWorkflows, toolActionKind } from "./catalog";
import { resultToItems } from "./runner-items";
import { buildCompanyContext, type CompanyContext, type CompanyScope } from "./context";
import { applyPlaceholders, findPlaceholders, resolvePlaceholdersWithLlm } from "./placeholders";
import { evaluate, resolveValue, type ExpressionContext } from "./expressions";

const MAX_STORED_ITEMS = 200;
const MAX_STORED_ITEM_BYTES = 64 * 1024;
const MAX_SUBWORKFLOW_DEPTH = 3;
const APPROVAL_TIMEOUT_MS = 48 * 3600_000;
const ITEM_KEY_CANDIDATES = ["discoveryId", "messageId", "id", "companyId", "contactId", "dealId", "email", "domain", "url", "profileUrl"];

export interface RunnerDeps {
  registry: ToolRegistry;
  store: WorkflowStore;
  providers: LlmProviderManager;
  getAutonomyLevel: () => AutonomyLevel;
  emit: (frame: WorkflowProgressFrame) => void;
  audit: (entry: { action: string; severity: "info" | "warning" | "error"; summary: string; metadata: Record<string, unknown> }) => void;
  /** Sub-Workflows: Definition nachladen. */
  getDefinition: (id: string) => WorkflowDefinition | null;
  /** Meldung an den Nutzer (Notification / Meldungen). */
  notify: (title: string, body: string) => void;
}

export interface RunOptions {
  trigger: WorkflowExecution["trigger"];
  dryRun?: boolean;
  inputItems?: WorkflowItem[];
  signal?: AbortSignal;
  depth?: number;
  /** Firma des Laufs (Pflicht bei settings.scope === "company"). */
  company?: CompanyScope;
}

interface PendingApproval {
  approval: WorkflowApproval;
  resolve: (r: { approved: boolean; note?: string }) => void;
}

export class WorkflowRunner {
  private readonly running = new Map<string, { abort: AbortController; execution: WorkflowExecution }>();
  private readonly pendingApprovals = new Map<string, PendingApproval>();

  constructor(private readonly deps: RunnerDeps) {}

  isRunning(workflowId: string): boolean {
    for (const r of this.running.values()) if (r.execution.workflowId === workflowId) return true;
    return false;
  }

  runningExecutions(): WorkflowExecution[] {
    return [...this.running.values()].map((r) => r.execution);
  }

  cancel(executionId: string): boolean {
    const r = this.running.get(executionId);
    if (!r) return false;
    r.abort.abort();
    return true;
  }

  /** Freigabe entscheiden (Liste „Offene Freigaben“, Chat, Telegram). */
  resolveApproval(approvalId: string, approved: boolean, note?: string): boolean {
    const p = this.pendingApprovals.get(approvalId);
    const list = this.deps.store.listApprovals();
    const idx = list.findIndex((a) => a.id === approvalId);
    if (idx >= 0) {
      list[idx] = { ...list[idx]!, status: approved ? "approved" : "rejected", decidedAt: new Date().toISOString(), ...(note ? { note } : {}) };
      this.deps.store.saveApprovals(list);
      this.deps.emit({ kind: "approvals-changed" });
    }
    if (!p) return idx >= 0;
    this.pendingApprovals.delete(approvalId);
    p.resolve({ approved, ...(note ? { note } : {}) });
    return true;
  }

  async run(def: WorkflowDefinition, opts: RunOptions): Promise<WorkflowExecution> {
    const depth = opts.depth ?? 0;
    if (depth > MAX_SUBWORKFLOW_DEPTH) throw new Error("Sub-Workflow-Tiefe ueberschritten.");
    const scopePflicht = (def.settings.scope ?? "company") === "company";
    if (scopePflicht && !opts.company?.companyId && !opts.company?.discoveryId) {
      throw new Error(`Workflow „${def.name}“ braucht eine Firma (jeder Lauf bezieht sich auf genau eine Firma).`);
    }
    // Je Firma ein Lauf; parallel fuer verschiedene Firmen erlaubt (max 3).
    const laufend = this.runningExecutions().filter((e) => e.workflowId === def.id);
    if (laufend.some((e) => !opts.company || (e.scope?.companyId === opts.company.companyId && e.scope?.discoveryId === opts.company.discoveryId))) {
      throw new Error(`Workflow „${def.name}“ laeuft fuer diese Firma bereits.`);
    }
    if (laufend.length >= 3) throw new Error(`Workflow „${def.name}“: bereits 3 Laeufe aktiv — bitte warten.`);
    const abort = new AbortController();
    if (opts.signal) opts.signal.addEventListener("abort", () => abort.abort(), { once: true });
    const timeout = setTimeout(() => abort.abort(), def.settings.timeoutMinutes * 60_000);

    const execution: WorkflowExecution = {
      id: `ex_${randomUUID().slice(0, 12)}`,
      workflowId: def.id,
      workflowName: def.name,
      workflowVersion: def.version,
      trigger: opts.trigger,
      dryRun: opts.dryRun === true,
      ...(opts.company ? { scope: opts.company } : {}),
      status: "running",
      startedAt: new Date().toISOString(),
      nodeRuns: {},
    };
    this.running.set(execution.id, { abort, execution });
    this.deps.store.saveExecution(execution);
    this.deps.emit({ kind: "execution-started", execution });
    this.deps.audit({
      action: "workflow.run.start",
      severity: "info",
      summary: `Workflow „${def.name}“ gestartet (${opts.trigger}${execution.dryRun ? ", Trockenlauf" : ""})`,
      metadata: { workflowId: def.id, executionId: execution.id, version: def.version },
    });

    const state = this.deps.store.getState(def.id);
    const ctx: RunContext = {
      def,
      execution,
      signal: abort.signal,
      nodeOutputs: new Map(),
      pairedFrom: new Map(),
      state,
      depth,
      mailsSent: 0,
      itemsProduced: 0,
      company: null,
      placeholderCache: new Map(),
    };
    try {
      const trigger = def.nodes.find((n) => n.type === "trigger");
      if (!trigger) throw new Error("Kein Start-Node.");
      // Firmen-Kontext vollstaendig laden (Stammdaten, Profil, Finanzen, Kontakte, CRM, Radar).
      if (opts.company?.companyId || opts.company?.discoveryId) {
        ctx.company = await buildCompanyContext(this.deps.registry, opts.company, this.toolContext(ctx, trigger, "none", "read", []));
        execution.scope = ctx.company.scope;
        execution.contextQuellen = ctx.company.quellen;
        this.deps.store.saveExecution(execution);
      }
      const start =
        opts.inputItems && opts.inputItems.length > 0
          ? opts.inputItems
          : [{ json: ctx.company ? { ...ctx.company.scope, ...(ctx.company.json.name ? { name: ctx.company.json.name } : {}) } : {} }];
      await this.runGraph(ctx, new Set(def.nodes.map((n) => n.name)), [{ node: trigger.name, index: 0, items: start }], null);
      if (execution.status === "running") execution.status = "success";
    } catch (err) {
      if (abort.signal.aborted && execution.status === "running") {
        execution.status = "cancelled";
        execution.error = "Abgebrochen (Nutzer, Zeitlimit oder App beendet).";
      } else if (execution.status === "running") {
        execution.status = "error";
        execution.error = err instanceof Error ? err.message : String(err);
      }
    } finally {
      clearTimeout(timeout);
      this.running.delete(execution.id);
      execution.finishedAt = new Date().toISOString();
      execution.summary = this.summarize(ctx);
      this.deps.store.saveState(def.id, state);
      this.deps.store.saveExecution(execution);
      this.deps.store.pruneExecutions(def.id);
      this.deps.emit({ kind: "execution-finished", execution });
      this.deps.audit({
        action: `workflow.run.${execution.status}`,
        severity: execution.status === "error" ? "error" : execution.status === "cancelled" ? "warning" : "info",
        summary: `Workflow „${def.name}“: ${execution.status} — ${execution.summary}`,
        metadata: { workflowId: def.id, executionId: execution.id, error: execution.error ?? null },
      });
      if (def.settings.notifyOnFinish && depth === 0 && opts.trigger !== "test") {
        this.deps.notify(`Workflow „${def.name}“ ${statusText(execution.status)}`, execution.summary ?? "");
      }
    }
    return execution;
  }

  // ---- Graph-Ausfuehrung ----------------------------------------------------

  /**
   * Fuehrt den Teilgraphen `allowed` ab den Einstiegs-Zielen aus. Items,
   * die an `collectAt` (Loop-Node) zurueckfliessen, werden gesammelt und
   * zurueckgegeben statt den Node erneut zu starten.
   */
  private async runGraph(
    ctx: RunContext,
    allowed: Set<string>,
    entries: Array<{ node: string; index: number; items: WorkflowItem[] }>,
    collectAt: string | null,
  ): Promise<WorkflowItem[]> {
    const { def } = ctx;
    const byName = new Map(def.nodes.map((n) => [n.name, n]));
    const collected: WorkflowItem[] = [];
    // Eingaenge je Node: index → Items
    const inbox = new Map<string, Map<number, WorkflowItem[]>>();
    // Wie viele Vorgaenger-Kanten muss ein Node abwarten (nur innerhalb `allowed`)?
    const pendingPreds = new Map<string, number>();
    for (const [from, conn] of Object.entries(def.connections)) {
      if (!allowed.has(from) || from === collectAt) continue;
      for (const targets of conn.main ?? []) {
        for (const t of targets ?? []) {
          if (!allowed.has(t.node) || t.node === collectAt) continue;
          pendingPreds.set(t.node, (pendingPreds.get(t.node) ?? 0) + 1);
        }
      }
    }
    const deliver = (node: string, index: number, items: WorkflowItem[]): void => {
      if (node === collectAt) {
        collected.push(...items);
        return;
      }
      if (!inbox.has(node)) inbox.set(node, new Map());
      const m = inbox.get(node)!;
      m.set(index, [...(m.get(index) ?? []), ...items]);
      pendingPreds.set(node, (pendingPreds.get(node) ?? 1) - 1);
    };
    for (const e of entries) {
      if (!inbox.has(e.node)) inbox.set(e.node, new Map());
      inbox.get(e.node)!.set(e.index, e.items);
      pendingPreds.set(e.node, 0);
    }
    const done = new Set<string>();
    for (;;) {
      if (ctx.signal.aborted) throw new Error("aborted");
      const ready = [...inbox.keys()].filter((n) => !done.has(n) && (pendingPreds.get(n) ?? 0) <= 0);
      if (ready.length === 0) break;
      ready.sort((a, b) => {
        const pa = byName.get(a)!.position, pb = byName.get(b)!.position;
        return pa[1] - pb[1] || pa[0] - pb[0];
      });
      const name = ready[0]!;
      done.add(name);
      const node = byName.get(name)!;
      const inputs = inbox.get(name)!;
      const inputItems = [...inputs.keys()].sort((a, b) => a - b).flatMap((i) => inputs.get(i) ?? []);
      const outputs = await this.runNode(ctx, node, inputItems, inputs, allowed);
      // Deaktivierte/uebersprungene Nodes reichen Items durch (Ausgang 0).
      outputs.forEach((items, outIdx) => {
        const targets = def.connections[name]?.main?.[outIdx] ?? [];
        for (const t of targets) deliver(t.node, t.index, items);
      });
      // Nodes ohne Eingabe-Items, deren Vorgaenger fertig sind, muessen
      // trotzdem „laufen“ (leer), damit nachfolgende Merges nicht haengen.
      for (const [from, conn] of Object.entries(def.connections)) {
        if (from !== name) continue;
        for (const targets of conn.main ?? []) {
          for (const t of targets ?? []) {
            if (t.node !== collectAt && allowed.has(t.node) && !inbox.has(t.node)) {
              inbox.set(t.node, new Map());
              pendingPreds.set(t.node, (pendingPreds.get(t.node) ?? 1) - 1);
            }
          }
        }
      }
    }
    return collected;
  }

  private async runNode(
    ctx: RunContext,
    node: WorkflowNode,
    inputItems: WorkflowItem[],
    inputsByIndex: Map<number, WorkflowItem[]>,
    allowed: Set<string>,
  ): Promise<WorkflowItem[][]> {
    const { execution } = ctx;
    const run: WorkflowNodeRun = { startedAt: new Date().toISOString(), status: "running", inputItems: inputItems.length, outputItems: [] };
    (execution.nodeRuns[node.name] ??= []).push(run);
    this.deps.emit({ kind: "node-started", executionId: execution.id, workflowId: ctx.def.id, node: node.name });
    let outputs: WorkflowItem[][] = [[]];
    try {
      if (node.disabled || node.type === "note") {
        outputs = [inputItems];
        run.status = "skipped";
      } else {
        outputs = await this.withRetry(node, () => this.executeNode(ctx, node, inputItems, inputsByIndex, allowed));
        run.status = "success";
      }
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      run.error = msg;
      run.status = "error";
      const onError = node.onError ?? "stop";
      if (ctx.signal.aborted || msg === "aborted") throw err;
      if (onError === "continue") outputs = [inputItems];
      else if (onError === "errorOutput") outputs = [[], inputItems.map((it) => ({ json: { ...it.json, error: msg }, pairedItem: it.pairedItem }))];
      else {
        run.finishedAt = new Date().toISOString();
        this.deps.emit({ kind: "node-finished", executionId: execution.id, workflowId: ctx.def.id, node: node.name, run });
        throw new Error(`Node „${node.name}“: ${msg}`);
      }
    }
    ctx.nodeOutputs.set(node.name, outputs);
    run.outputItems = outputs.map((o) => o.length);
    run.output = outputs.map((o) => truncateItems(o));
    run.finishedAt = new Date().toISOString();
    ctx.itemsProduced += outputs.reduce((s, o) => s + o.length, 0);
    if (ctx.itemsProduced > ctx.def.settings.maxItemsPerRun) {
      throw new Error(`Item-Grenze je Lauf ueberschritten (${ctx.def.settings.maxItemsPerRun}).`);
    }
    this.deps.store.saveExecution(execution);
    this.deps.emit({ kind: "node-finished", executionId: execution.id, workflowId: ctx.def.id, node: node.name, run });
    return outputs;
  }

  private async withRetry(node: WorkflowNode, fn: () => Promise<WorkflowItem[][]>): Promise<WorkflowItem[][]> {
    const tries = node.retryOnFail ? Math.max(1, node.maxTries ?? 3) : 1;
    let lastErr: unknown;
    for (let i = 0; i < tries; i++) {
      try {
        return await fn();
      } catch (err) {
        lastErr = err;
        if (err instanceof Error && (err.message === "aborted" || err.message.startsWith("Freigabe abgelehnt"))) throw err;
        if (i < tries - 1) await sleep((node.waitBetweenTriesSec ?? 5) * 1000);
      }
    }
    throw lastErr;
  }

  private exprContext(ctx: RunContext, node: WorkflowNode, items: WorkflowItem[], itemIndex: number): ExpressionContext {
    const item = items[itemIndex] ?? { json: {} };
    return {
      json: item.json,
      itemIndex,
      inputItems: items,
      nodeOutput: (name) => ctx.nodeOutputs.get(name)?.[0],
      pairedIndex: (name) => this.pairedIndexFor(ctx, node.name, name, item),
      vars: Object.fromEntries(Object.entries(ctx.def.variables).map(([k, v]) => [k, v.value])),
      run: { index: 0, executionId: ctx.execution.id, workflowName: ctx.def.name, dryRun: ctx.execution.dryRun },
      ...(ctx.company ? { company: ctx.company.json, contextText: ctx.company.text } : {}),
    };
  }

  /**
   * Semantische Platzhalter ($kassenbestand ?? "…") eines Nodes aus dem
   * Firmen-Kontext befuellen. Ein Modell-Aufruf je Node und Lauf (Cache je
   * Platzhalter-Name ueber alle Nodes des Laufs).
   */
  private async fillPlaceholders(ctx: RunContext, node: WorkflowNode, value: unknown): Promise<unknown> {
    const refs = findPlaceholders(value);
    if (refs.length === 0) return value;
    const run = ctx.execution.nodeRuns[node.name]?.at(-1);
    const hinweise: string[] = [];
    const offen = refs.filter((r) => !ctx.placeholderCache.has(r.name));
    if (offen.length > 0) {
      if (!ctx.company) {
        for (const r of offen) ctx.placeholderCache.set(r.name, null);
        hinweise.push("Platzhalter ohne Firmen-Kontext (Lauf ohne Firma) — nur Fallbacks moeglich.");
      } else {
        const werte = await resolvePlaceholdersWithLlm(this.deps.providers, ctx.company.text, offen, ctx.signal);
        for (const r of offen) ctx.placeholderCache.set(r.name, werte[r.name] ?? null);
      }
    }
    const values: Record<string, unknown> = {};
    for (const r of refs) values[r.name] = ctx.placeholderCache.get(r.name) ?? null;
    const out = applyPlaceholders(value, values, hinweise);
    if (run) {
      run.platzhalter = { ...(run.platzhalter ?? {}), ...values };
      if (hinweise.length > 0) run.hinweise = [...(run.hinweise ?? []), ...hinweise];
    }
    return out;
  }

  /** Paired-Item-Kette: Item → Vorgaenger-Item → … bis zum gesuchten Node. */
  private pairedIndexFor(ctx: RunContext, fromNode: string, targetNode: string, item: WorkflowItem): number | undefined {
    let node = fromNode;
    let idx = item.pairedItem?.item;
    for (let hops = 0; hops < 50; hops++) {
      const pred = ctx.pairedFrom.get(node);
      if (!pred) return undefined;
      if (pred === targetNode) return idx;
      const predItems = ctx.nodeOutputs.get(pred)?.[0];
      const predItem = idx !== undefined ? predItems?.[idx] : undefined;
      idx = predItem?.pairedItem?.item;
      node = pred;
      if (idx === undefined) return undefined;
    }
    return undefined;
  }

  private async executeNode(
    ctx: RunContext,
    node: WorkflowNode,
    items: WorkflowItem[],
    inputsByIndex: Map<number, WorkflowItem[]>,
    allowed: Set<string>,
  ): Promise<WorkflowItem[][]> {
    // Paired-Item-Herkunft: der erste Vorgaenger auf Ausgang 0.
    for (const [from, conn] of Object.entries(ctx.def.connections)) {
      if ((conn.main ?? []).some((targets) => (targets ?? []).some((t) => t.node === node.name))) {
        if (!ctx.pairedFrom.has(node.name)) ctx.pairedFrom.set(node.name, from);
      }
    }
    // Semantische Platzhalter in den Parametern dieses Nodes befuellen (je Lauf/Firma).
    node = { ...node, parameters: (await this.fillPlaceholders(ctx, node, node.parameters)) as Record<string, unknown> };
    switch (node.type) {
      case "trigger":
        return [items];
      case "filter": {
        const cond = String(node.parameters.condition ?? "true");
        const out = items.filter((_, i) => Boolean(this.evalCondition(cond, this.exprContext(ctx, node, items, i))));
        return [out.map((it, i) => ({ ...it, pairedItem: { item: items.indexOf(it) } })).map((it) => it)];
      }
      case "if": {
        const cond = String(node.parameters.condition ?? "true");
        const yes: WorkflowItem[] = [], no: WorkflowItem[] = [];
        items.forEach((it, i) => (this.evalCondition(cond, this.exprContext(ctx, node, items, i)) ? yes : no).push({ json: it.json, pairedItem: { item: i } }));
        return [yes, no];
      }
      case "switch": {
        const cases = (node.parameters.cases as Array<{ match: string }> | undefined) ?? [];
        const outs: WorkflowItem[][] = cases.map(() => []);
        outs.push([]);
        items.forEach((it, i) => {
          const v = String(resolveValue(String(node.parameters.value ?? ""), this.exprContext(ctx, node, items, i)) ?? "");
          const idx = cases.findIndex((c) => String(c.match) === v);
          outs[idx >= 0 ? idx : cases.length]!.push({ json: it.json, pairedItem: { item: i } });
        });
        return outs;
      }
      case "transform": {
        const fields = (node.parameters.fields as Record<string, unknown> | undefined) ?? {};
        const keepOnly = node.parameters.keepOnly === true;
        return [
          items.map((it, i) => {
            const ectx = this.exprContext(ctx, node, items, i);
            const neu: Record<string, unknown> = {};
            for (const [k, v] of Object.entries(fields)) neu[k] = resolveValue(v, ectx);
            return { json: keepOnly ? neu : { ...it.json, ...neu }, pairedItem: { item: i } };
          }),
        ];
      }
      case "loop":
        return this.executeLoop(ctx, node, items, allowed);
      case "merge":
        return [this.executeMerge(node, inputsByIndex)];
      case "wait": {
        const minutes = Math.min(10080, Math.max(0, Number(node.parameters.minutes ?? 0)));
        if (minutes > 0) await sleep(minutes * 60_000, ctx.signal);
        return [items];
      }
      case "stop": {
        const msg = String(resolveValue(String(node.parameters.message ?? "Abgebrochen."), this.exprContext(ctx, node, items, 0)));
        throw new Error(msg);
      }
      case "human":
        return [await this.executeHuman(ctx, node, items)];
      case "ai":
        return [await this.executeAi(ctx, node, items)];
      case "subworkflow": {
        const sub = this.deps.getDefinition(String(node.parameters.workflowId));
        if (!sub) throw new Error("Sub-Workflow nicht gefunden.");
        const ex = await this.run(sub, { trigger: ctx.execution.trigger, dryRun: ctx.execution.dryRun, inputItems: items, signal: ctx.signal, depth: ctx.depth + 1 });
        if (ex.status !== "success") throw new Error(`Sub-Workflow „${sub.name}“: ${ex.status}${ex.error ? ` — ${ex.error}` : ""}`);
        const last = Object.values(ex.nodeRuns).at(-1)?.at(-1)?.output?.[0] ?? [];
        return [last];
      }
      case "tool":
        return [await this.executeTool(ctx, node, items)];
      default:
        throw new Error(`Node-Typ nicht unterstuetzt: ${node.type}`);
    }
  }

  private evalCondition(cond: string, ectx: ExpressionContext): unknown {
    const m = /^\s*\{\{([\s\S]*)\}\}\s*$/.exec(cond);
    return evaluate(m ? m[1]! : cond, ectx);
  }

  private executeMerge(node: WorkflowNode, inputs: Map<number, WorkflowItem[]>): WorkflowItem[] {
    const mode = node.parameters.mode === "byKey" ? "byKey" : "append";
    const idx = [...inputs.keys()].sort((a, b) => a - b);
    if (mode === "append") return idx.flatMap((i) => inputs.get(i) ?? []);
    const key = String(node.parameters.key ?? "id");
    const a = inputs.get(idx[0] ?? 0) ?? [];
    const b = idx.slice(1).flatMap((i) => inputs.get(i) ?? []);
    const byKey = new Map(b.map((it) => [String(it.json[key] ?? ""), it.json]));
    return a.map((it, i) => ({ json: { ...it.json, ...(byKey.get(String(it.json[key] ?? "")) ?? {}) }, pairedItem: { item: i } }));
  }

  private async executeLoop(ctx: RunContext, node: WorkflowNode, items: WorkflowItem[], allowed: Set<string>): Promise<WorkflowItem[][]> {
    const size = Math.max(1, Number(node.parameters.batchSize ?? 10));
    // Schleifenkoerper: von Ausgang 0 erreichbar, bis zurueck zum Loop-Node.
    const body = new Set<string>();
    const stack = (ctx.def.connections[node.name]?.main?.[0] ?? []).map((t) => t.node);
    while (stack.length > 0) {
      const n = stack.pop()!;
      if (n === node.name || body.has(n) || !allowed.has(n)) continue;
      body.add(n);
      for (const targets of ctx.def.connections[n]?.main ?? []) for (const t of targets ?? []) stack.push(t.node);
    }
    const doneItems: WorkflowItem[] = [];
    for (let i = 0; i < items.length; i += size) {
      if (ctx.signal.aborted) throw new Error("aborted");
      const batch = items.slice(i, i + size).map((it, j) => ({ json: it.json, pairedItem: { item: i + j } }));
      const entries = (ctx.def.connections[node.name]?.main?.[0] ?? []).map((t) => ({ node: t.node, index: t.index, items: batch }));
      if (entries.length === 0) {
        doneItems.push(...batch);
        continue;
      }
      const returned = await this.runGraph(ctx, body, entries, node.name);
      doneItems.push(...(returned.length > 0 ? returned : batch));
    }
    // Ausgang 0 (loop) wurde intern bedient; nach aussen nur „done“.
    return [[], doneItems];
  }

  private async executeHuman(ctx: RunContext, node: WorkflowNode, items: WorkflowItem[]): Promise<WorkflowItem[]> {
    if (items.length === 0) return items;
    if (ctx.execution.dryRun) return items;
    const prompt = String(resolveValue(String(node.parameters.prompt ?? "Freigabe noetig"), this.exprContext(ctx, node, items, 0)));
    const r = await this.requestApproval(ctx, node.name, prompt, items, (node.parameters.previewFields as string[] | undefined) ?? []);
    if (!r.approved) throw new Error(`Freigabe abgelehnt${r.note ? `: ${r.note}` : ""}`);
    return items;
  }

  private async requestApproval(ctx: RunContext, nodeName: string, prompt: string, items: WorkflowItem[], previewFields: string[]): Promise<{ approved: boolean; note?: string }> {
    const approval: WorkflowApproval = {
      id: `ap_${randomUUID().slice(0, 10)}`,
      executionId: ctx.execution.id,
      workflowId: ctx.def.id,
      workflowName: ctx.def.name,
      nodeName,
      prompt,
      items: truncateItems(items.map((it) => ({ json: previewFields.length > 0 ? pick(it.json, previewFields) : it.json })), 50),
      createdAt: new Date().toISOString(),
      status: "open",
    };
    const list = this.deps.store.listApprovals();
    list.push(approval);
    this.deps.store.saveApprovals(list);
    ctx.execution.status = "paused";
    ctx.execution.pausedAt = { node: nodeName, reason: "confirmation", approvalId: approval.id };
    const run = ctx.execution.nodeRuns[nodeName]?.at(-1);
    if (run) run.status = "paused";
    this.deps.store.saveExecution(ctx.execution);
    this.deps.emit({ kind: "approval-open", approval });
    this.deps.notify(`Workflow „${ctx.def.name}“ wartet auf Freigabe`, prompt);
    this.deps.audit({ action: "workflow.approval.open", severity: "info", summary: `Freigabe offen: ${prompt}`, metadata: { workflowId: ctx.def.id, executionId: ctx.execution.id, approvalId: approval.id, items: items.length } });
    const result = await new Promise<{ approved: boolean; note?: string }>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pendingApprovals.delete(approval.id);
        const l = this.deps.store.listApprovals();
        const i = l.findIndex((a) => a.id === approval.id);
        if (i >= 0) {
          l[i] = { ...l[i]!, status: "expired", decidedAt: new Date().toISOString() };
          this.deps.store.saveApprovals(l);
        }
        reject(new Error("Freigabe abgelehnt: keine Entscheidung innerhalb von 48 Stunden"));
      }, APPROVAL_TIMEOUT_MS);
      const onAbort = (): void => {
        clearTimeout(timer);
        this.pendingApprovals.delete(approval.id);
        reject(new Error("aborted"));
      };
      ctx.signal.addEventListener("abort", onAbort, { once: true });
      this.pendingApprovals.set(approval.id, {
        approval,
        resolve: (r) => {
          clearTimeout(timer);
          ctx.signal.removeEventListener("abort", onAbort);
          resolve(r);
        },
      });
    });
    ctx.execution.status = "running";
    delete ctx.execution.pausedAt;
    this.deps.audit({ action: result.approved ? "workflow.approval.approved" : "workflow.approval.rejected", severity: "info", summary: `Freigabe ${result.approved ? "erteilt" : "abgelehnt"}: ${prompt}`, metadata: { workflowId: ctx.def.id, executionId: ctx.execution.id, approvalId: approval.id } });
    return result;
  }

  private async executeAi(ctx: RunContext, node: WorkflowNode, items: WorkflowItem[]): Promise<WorkflowItem[]> {
    if (!this.deps.providers.getStatus().ready) throw new Error("Kein Hintergrund-Modell bereit (API-Schluessel oder lokales Modell noetig; ein ChatGPT-Abo gilt nicht fuer Workflows).");
    const system =
      String(node.parameters.system ?? "Du bist ein praeziser Assistent fuer B2B-Vertrieb. Antworte NUR mit JSON nach dem vorgegebenen Schema.") +
      (ctx.company ? `\n\nVollstaendiger Kontext der Firma, um die es in diesem Lauf geht (nur daraus schoepfen, nichts erfinden):\n${ctx.company.text.slice(0, 40_000)}` : "");
    const schema = (node.parameters.outputSchema as Record<string, unknown> | undefined) ?? {};
    const required = ((schema as { required?: string[] }).required ?? []) as string[];
    const out: WorkflowItem[] = [];
    const modelOverride = this.deps.providers.getProducerModelOverride();
    for (let i = 0; i < items.length; i++) {
      if (ctx.signal.aborted) throw new Error("aborted");
      const prompt = String(resolveValue(String(node.parameters.prompt ?? ""), this.exprContext(ctx, node, items, i)));
      let parsed: Record<string, unknown> | null = null;
      let lastRaw = "";
      for (let versuch = 0; versuch < 3 && !parsed; versuch++) {
        const reparatur = versuch > 0 ? `\n\nDeine vorige Antwort war kein gueltiges JSON nach Schema (fehlend: ${required.filter((k) => !(parsed ?? {})[k]).join(", ") || "Struktur"}). Antworte NUR mit JSON.` : "";
        const raw = await streamToText(this.deps.providers, buildMessages(`${system}\n\nSchema: ${JSON.stringify(schema)}`, prompt + reparatur, "wf-ai"), { timeoutMs: 120_000, signal: ctx.signal, ...(modelOverride ? { modelOverride } : {}) });
        lastRaw = raw;
        const obj = parseJsonObject(raw);
        if (obj && typeof obj === "object" && required.every((k) => (obj as Record<string, unknown>)[k] !== undefined)) parsed = obj as Record<string, unknown>;
      }
      if (!parsed) throw new Error(`KI-Schritt lieferte kein gueltiges JSON: ${lastRaw.slice(0, 200)}`);
      out.push({ json: { ...items[i]!.json, ...parsed }, pairedItem: { item: i } });
    }
    return out;
  }

  private async executeTool(ctx: RunContext, node: WorkflowNode, items: WorkflowItem[]): Promise<WorkflowItem[]> {
    const toolName = String(node.parameters.tool ?? "");
    if (!isToolAllowedInWorkflows(toolName)) throw new Error(`Tool nicht fuer Workflows freigegeben: ${toolName}`);
    const tool = this.deps.registry.get(toolName);
    if (!tool) throw new Error(`Tool nicht verfuegbar: ${toolName} (abgeschaltet oder unbekannt)`);
    const kind = toolActionKind(toolName);
    const argsTemplate = node.parameters.args ?? {};
    const mode = node.mode ?? "perItem";
    const outputPath = typeof node.parameters.outputPath === "string" ? node.parameters.outputPath : undefined;
    const itemKey = typeof node.parameters.itemKey === "string" ? node.parameters.itemKey : undefined;
    const skipProcessed = node.parameters.skipProcessed !== false && kind !== "read";
    const processed = new Set(ctx.state.processedKeys[node.name] ?? []);

    // Vollmacht fuer Schreib-Nodes.
    const level = this.effectiveLevel(ctx, node, kind);
    const isMail = toolName === "mail_send" || toolName === "mail_reply" || toolName === "mail_forward";

    const runOnce = async (ectx: ExpressionContext, pairedIndex: number, keyValue: string | null): Promise<WorkflowItem[]> => {
      const args = resolveValue(argsTemplate, ectx);
      if (ctx.execution.dryRun && kind !== "read") {
        return [{ json: { dryRun: true, tool: toolName, args: args as Record<string, unknown>, ...(keyValue ? { key: keyValue } : {}) }, pairedItem: { item: pairedIndex } }];
      }
      if (isMail) {
        const today = new Date().toISOString().slice(0, 10);
        if (ctx.state.mailsToday.day !== today) ctx.state.mailsToday = { day: today, count: 0 };
        if (ctx.state.mailsToday.count >= ctx.def.settings.maxMailsPerDay) {
          throw new Error(`Tages-Obergrenze fuer Mails erreicht (${ctx.def.settings.maxMailsPerDay}).`);
        }
      }
      const parsed = tool.parseArgs(args);
      const result = await tool.run(parsed, this.toolContext(ctx, node, level, kind, [ectx.inputItems[ectx.itemIndex] ?? { json: ectx.json }]));
      if (isMail) {
        ctx.state.mailsToday.count++;
        ctx.mailsSent++;
      }
      if (keyValue) processed.add(keyValue);
      return resultToItems(result, outputPath, pairedIndex);
    };

    let out: WorkflowItem[] = [];
    if (mode === "allItems") {
      const ectx = this.exprContext(ctx, node, items, 0);
      out = await runOnce(ectx, 0, null);
    } else {
      let uebersprungen = 0;
      for (let i = 0; i < items.length; i++) {
        if (ctx.signal.aborted) throw new Error("aborted");
        const key = skipProcessed ? itemKeyOf(items[i]!, itemKey) : null;
        if (key && processed.has(key)) {
          uebersprungen++;
          continue;
        }
        out.push(...(await runOnce(this.exprContext(ctx, node, items, i), i, key)));
      }
      if (uebersprungen > 0) {
        const run = ctx.execution.nodeRuns[node.name]?.at(-1);
        if (run) run.error = `${uebersprungen} bereits verarbeitete Items uebersprungen`;
      }
    }
    if (skipProcessed) ctx.state.processedKeys[node.name] = [...processed];
    return out;
  }

  /** Vollmacht-Stufe fuer diesen Node: Workflow-Deckel, Node-Freigabe, mail_send-Regel. */
  private effectiveLevel(ctx: RunContext, node: WorkflowNode, kind: ActionKind | "read"): AutonomyLevel {
    const global = this.deps.getAutonomyLevel();
    const cap = ctx.def.settings.autonomy;
    let level: AutonomyLevel = cap === "inherit" ? global : (["none", "additive", "mutating"].indexOf(cap) <= ["none", "additive", "mutating"].indexOf(global) ? cap : global);
    if (node.confirmed && kind !== "destructive") level = "mutating";
    const tool = String(node.parameters.tool ?? "");
    // Entscheidung 2026-09-09: Mail-Versand nie allein ueber die Vollmacht — Freigabe oder Node-Freigabe Pflicht.
    if ((tool === "mail_send" || tool === "mail_forward") && !node.confirmed) level = "none";
    return level;
  }

  private toolContext(ctx: RunContext, node: WorkflowNode, level: AutonomyLevel, kind: ActionKind | "read", items: WorkflowItem[]): ToolContext {
    const remoteAsk: RemoteAskHandler = {
      askChoice: async (prompt: string, options: AgentChoiceOption[]) => {
        const r = await this.requestApproval(ctx, node.name, prompt, items, []);
        if (!r.approved) throw new Error(`Freigabe abgelehnt${r.note ? `: ${r.note}` : ""}`);
        // Die „Ja“-Option ist per Konvention die erste Nicht-Abbruch-Option.
        const yes = options.find((o) => !/abbrech|verwerf|nein|cancel/i.test(`${o.value} ${o.label}`)) ?? options[0]!;
        return yes.value;
      },
      askText: async () => {
        throw new Error("Rueckfrage (Freitext) im Workflow nicht moeglich — Wert als Parameter festlegen.");
      },
    };
    const ui = new UiBridge(
      {
        emit: () => {},
        pending: new Map(),
        audit: (e) => this.deps.audit({ action: e.action, severity: "info", summary: e.summary, metadata: { ...e.metadata, workflowId: ctx.def.id, executionId: ctx.execution.id } }),
      },
      ctx.execution.id,
      `workflow:${ctx.def.id}`,
      true,
      remoteAsk,
      level,
    );
    void kind;
    return {
      signal: ctx.signal,
      log: (msg) => console.log(`[workflow ${ctx.def.name}/${node.name}] ${msg}`),
      ui,
      autonomousMode: true,
    };
  }

  private summarize(ctx: RunContext): string {
    const runs = Object.entries(ctx.execution.nodeRuns);
    const last = runs.at(-1);
    const parts: string[] = [];
    if (ctx.company?.scope.companyName) parts.push(ctx.company.scope.companyName);
    parts.push(`${runs.length} Schritte`);
    if (last) parts.push(`zuletzt „${last[0]}“ (${last[1].at(-1)?.outputItems.reduce((a, b) => a + b, 0) ?? 0} Items)`);
    if (ctx.mailsSent > 0) parts.push(`${ctx.mailsSent} Mails`);
    if (ctx.execution.error) parts.push(ctx.execution.error);
    return parts.join(" · ");
  }
}

interface RunContext {
  def: WorkflowDefinition;
  execution: WorkflowExecution;
  signal: AbortSignal;
  nodeOutputs: Map<string, WorkflowItem[][]>;
  pairedFrom: Map<string, string>;
  state: { processedKeys: Record<string, string[]>; mailsToday: { day: string; count: number } };
  depth: number;
  mailsSent: number;
  itemsProduced: number;
  company: CompanyContext | null;
  placeholderCache: Map<string, unknown>;
}

function statusText(s: WorkflowExecution["status"]): string {
  return s === "success" ? "abgeschlossen" : s === "error" ? "mit Fehler beendet" : s === "cancelled" ? "abgebrochen" : s;
}

function sleep(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    const t = setTimeout(resolve, ms);
    signal?.addEventListener("abort", () => {
      clearTimeout(t);
      reject(new Error("aborted"));
    }, { once: true });
  });
}

function pick(obj: Record<string, unknown>, fields: string[]): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const f of fields) if (f in obj) out[f] = obj[f];
  return out;
}

function itemKeyOf(item: WorkflowItem, key?: string): string | null {
  const k = key ?? ITEM_KEY_CANDIDATES.find((c) => item.json[c] != null && String(item.json[c]).length > 0);
  if (!k) return null;
  const v = item.json[k];
  return v == null ? null : `${k}:${String(v)}`;
}

function truncateItems(items: WorkflowItem[], max = MAX_STORED_ITEMS): WorkflowItem[] {
  return items.slice(0, max).map((it) => {
    const s = JSON.stringify(it.json);
    if (s.length <= MAX_STORED_ITEM_BYTES) return it;
    return { ...it, json: { _gekuerzt: true, vorschau: s.slice(0, MAX_STORED_ITEM_BYTES) } };
  });
}


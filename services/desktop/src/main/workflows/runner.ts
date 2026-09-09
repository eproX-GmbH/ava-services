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

import { bewertePipeline, fetchPipeline, type VorgangsBefund } from "../transaction-pipeline";
import { STAGE_LABELS, nodeRequirementsMitSub, waitStages, type PipelineStage } from "../../shared/workflow-dependencies";
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
import type { WorkflowStore, WorkflowState } from "./store";
import { isToolAllowedInWorkflows, toolActionKind } from "./catalog";
import { resultToItems } from "./runner-items";
import { buildCompanyContext, type CompanyContext, type CompanyScope } from "./context";
import { applyPlaceholders, findPlaceholders, resolvePlaceholdersWithLlm } from "./placeholders";
import { evaluate, resolveValue, type ExpressionContext } from "./expressions";

const MAX_STORED_ITEMS = 200;
const MAX_STORED_ITEM_BYTES = 64 * 1024;
/** Maximale Wartezeit auf Daten-Abhaengigkeiten je Node (Publikationen dauern lange). */
const DEPENDENCY_WAIT_MS = 6 * 3600_000;
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
  /** Gateway-Lesezugriff (Warten auf Vorgangs-Abschluss). */
  gatewayRequest: <T>(path: string) => Promise<T>;
  /** Meldung an den Nutzer (Meldungen-Panel, OS-Notification, Telegram). */
  notify: (m: { art: "fertig" | "freigabe" | "fehler"; title: string; body: string; workflowId: string; executionId: string; approvalId?: string }) => void;
}

export interface RunOptions {
  trigger: WorkflowExecution["trigger"];
  dryRun?: boolean;
  inputItems?: WorkflowItem[];
  signal?: AbortSignal;
  depth?: number;
  /** Firma des Laufs (Pflicht bei settings.scope === "company"). */
  company?: CompanyScope;
  /** „Bis hierhin ausfuehren“: nach diesem Node stoppen. */
  untilNode?: string;
  /** Intern: unterbrochenen Lauf fortsetzen (siehe resume()). */
  resumeFrom?: { execution: WorkflowExecution; doneOutputs: Map<string, WorkflowItem[][]> };
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

  /**
   * v0.1.607 — Unterbrochenen Lauf (App beendet/aktualisiert) fortsetzen.
   * Nur wenn der unterbrochene Schritt ein Warten-Node ist: Das Warten ist
   * idempotent, die Eingaben liegen als gespeicherte Ausgabe der Vorgaenger
   * vor. Sonst wird der Lauf als abgebrochen markiert (ein Schreib-Schritt
   * koennte doppelt laufen).
   */
  async resume(def: WorkflowDefinition, stored: WorkflowExecution): Promise<WorkflowExecution> {
    const abbrechen = (grund: string): WorkflowExecution => {
      const ex: WorkflowExecution = { ...stored, status: "cancelled", finishedAt: new Date().toISOString(), error: grund };
      for (const runs of Object.values(ex.nodeRuns)) {
        const r = runs.at(-1);
        if (r && r.status === "running") {
          r.status = "error";
          r.error = grund;
          r.finishedAt = ex.finishedAt;
        }
      }
      this.deps.store.saveExecution(ex);
      this.deps.emit({ kind: "execution-finished", execution: ex });
      this.deps.audit({ action: "workflow.run.cancelled", severity: "warning", summary: `Workflow „${def.name}“: ${grund}`, metadata: { workflowId: def.id, executionId: ex.id } });
      return ex;
    };
    if (this.running.has(stored.id)) return stored;
    const offen = Object.entries(stored.nodeRuns).filter(([, runs]) => runs.at(-1)?.status === "running");
    const [nodeName] = offen[0] ?? [];
    const node = nodeName ? def.nodes.find((n) => n.name === nodeName) : undefined;
    if (!node) return abbrechen("Durch Neustart abgebrochen (kein fortsetzbarer Schritt) — bitte erneut starten.");
    if (node.type !== "wait") return abbrechen(`Durch Neustart abgebrochen im Schritt „${node.name}“ — bitte erneut starten (nur ein Warten-Schritt wird automatisch fortgesetzt).`);
    const doneOutputs = new Map<string, WorkflowItem[][]>();
    for (const [name, runs] of Object.entries(stored.nodeRuns)) {
      const r = runs.at(-1);
      if (!r || name === nodeName) continue;
      if ((r.status === "success" || r.status === "skipped") && r.output) doneOutputs.set(name, r.output);
    }
    // Vorgaenger des Warten-Nodes muessen Ausgaben haben, sonst fehlt die Eingabe.
    const vorgaenger = Object.entries(def.connections).filter(([, c]) => (c.main ?? []).flat().some((t) => t.node === nodeName)).map(([from]) => from);
    if (vorgaenger.length > 0 && !vorgaenger.some((v) => doneOutputs.has(v))) {
      return abbrechen(`Durch Neustart abgebrochen: Eingaben fuer „${node.name}“ nicht gespeichert — bitte erneut starten.`);
    }
    const unterbrochen = stored.nodeRuns[node.name]!.at(-1)!;
    unterbrochen.status = "error";
    unterbrochen.error = "Durch Neustart unterbrochen — wird fortgesetzt.";
    unterbrochen.finishedAt = new Date().toISOString();
    return this.run(def, {
      trigger: stored.trigger,
      dryRun: stored.dryRun,
      ...(stored.scope ? { company: stored.scope } : {}),
      resumeFrom: { execution: stored, doneOutputs },
    });
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

    const execution: WorkflowExecution = opts.resumeFrom
      ? { ...opts.resumeFrom.execution, status: "running", finishedAt: undefined, error: undefined }
      : {
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
      action: opts.resumeFrom ? "workflow.run.resume" : "workflow.run.start",
      severity: "info",
      summary: `Workflow „${def.name}“ ${opts.resumeFrom ? "nach Neustart fortgesetzt" : "gestartet"} (${opts.trigger}${execution.dryRun ? ", Trockenlauf" : ""})`,
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
      untilNode: opts.untilNode ?? null,
      gestoppt: false,
      stufenFertig: new Set(),
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
      if (opts.resumeFrom) {
        // Fortsetzung: fertige Nodes gelten als erledigt, ihre gespeicherten
        // Ausgaben werden an die Nachfolger geliefert; der unterbrochene Node
        // (Warten) laeuft neu an.
        for (const [name, outs] of opts.resumeFrom.doneOutputs) ctx.nodeOutputs.set(name, outs);
        await this.runGraph(ctx, new Set(def.nodes.map((n) => n.name)), [], null, opts.resumeFrom.doneOutputs);
      } else {
        const start =
          opts.inputItems && opts.inputItems.length > 0
            ? opts.inputItems
            : [{ json: ctx.company ? { ...ctx.company.scope, ...(ctx.company.json.name ? { name: ctx.company.json.name } : {}) } : {} }];
        await this.runGraph(ctx, new Set(def.nodes.map((n) => n.name)), [{ node: trigger.name, index: 0, items: start }], null);
      }
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
      if (opts.company?.companyId || opts.company?.discoveryId) {
        state.scopeRuns[opts.company.companyId ? `companyId:${opts.company.companyId}` : `discoveryId:${opts.company.discoveryId}`] = execution.startedAt;
      }
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
      // W5 — Fehler-Workflow: bei Fehler den hinterlegten Workflow mit Fehler-Item starten.
      if (execution.status === "error" && def.settings.errorWorkflowId && depth === 0 && opts.trigger !== "test") {
        const errDef = this.deps.getDefinition(def.settings.errorWorkflowId);
        if (errDef && errDef.id !== def.id) {
          void this.run(errDef, {
            trigger: "event",
            inputItems: [{ json: { fehler: execution.error, workflowId: def.id, workflowName: def.name, executionId: execution.id, firma: execution.scope ?? null } }],
            company: opts.company,
            depth: 1,
          }).catch(() => {});
        }
      }
      if (def.settings.notifyOnFinish && depth === 0 && opts.trigger !== "test") {
        this.deps.notify({
          art: execution.status === "error" ? "fehler" : "fertig",
          title: `Workflow „${def.name}“ ${statusText(execution.status)}`,
          body: execution.summary ?? "",
          workflowId: def.id,
          executionId: execution.id,
        });
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
    doneOutputs?: Map<string, WorkflowItem[][]>,
  ): Promise<WorkflowItem[]> {
    const { def } = ctx;
    const byName = new Map(def.nodes.map((n) => [n.name, n]));
    const collected: WorkflowItem[] = [];
    // Eingaenge je Node: index → Items
    const inbox = new Map<string, Map<number, WorkflowItem[]>>();
    // Wie viele Vorgaenger-Kanten muss ein Node abwarten (nur innerhalb `allowed`)?
    const pendingPreds = new Map<string, number>();
    // v0.1.601 — Rueckkanten aus dem Schleifenkoerper zum Loop-Node sind keine
    // Vorgaenger (sonst wartet der Loop-Node ewig auf sich selbst).
    const rueckkanten = new Set<string>();
    for (const n of def.nodes) {
      if (n.type !== "loop" || !allowed.has(n.name)) continue;
      for (const b of this.loopBody(ctx, n.name, allowed)) rueckkanten.add(`${b}→${n.name}`);
    }
    for (const [from, conn] of Object.entries(def.connections)) {
      if (!allowed.has(from) || from === collectAt) continue;
      for (const targets of conn.main ?? []) {
        for (const t of targets ?? []) {
          if (!allowed.has(t.node) || t.node === collectAt) continue;
          if (rueckkanten.has(`${from}→${t.node}`)) continue;
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
    // v0.1.607 — Fortsetzung nach Neustart: bereits fertige Nodes liefern
    // ihre gespeicherten Ausgaben, ohne erneut zu laufen.
    if (doneOutputs) {
      for (const [name, outputs] of doneOutputs) {
        if (!allowed.has(name)) continue;
        done.add(name);
        outputs.forEach((items, outIdx) => {
          for (const t of def.connections[name]?.main?.[outIdx] ?? []) {
            if (rueckkanten.has(`${name}→${t.node}`) || doneOutputs.has(t.node)) continue;
            deliver(t.node, t.index, items);
          }
        });
      }
    }
    for (;;) {
      if (ctx.signal.aborted) throw new Error("aborted");
      const ready = [...inbox.keys()].filter((n) => !done.has(n) && (pendingPreds.get(n) ?? 0) <= 0);
      if (ready.length === 0) break;
      ready.sort((a, b) => {
        const pa = byName.get(a)!.position, pb = byName.get(b)!.position;
        return pa[1] - pb[1] || pa[0] - pb[0];
      });
      if (ctx.gestoppt) break;
      const name = ready[0]!;
      done.add(name);
      const node = byName.get(name)!;
      const inputs = inbox.get(name)!;
      const inputItems = [...inputs.keys()].sort((a, b) => a - b).flatMap((i) => inputs.get(i) ?? []);
      const outputs = await this.runNode(ctx, node, inputItems, inputs, allowed);
      if (ctx.untilNode === name) {
        ctx.gestoppt = true;
        break;
      }
      // Deaktivierte/uebersprungene Nodes reichen Items durch (Ausgang 0).
      outputs.forEach((items, outIdx) => {
        const targets = def.connections[name]?.main?.[outIdx] ?? [];
        for (const t of targets) {
          if (rueckkanten.has(`${name}→${t.node}`)) continue; // Schleife bedient ihren Koerper selbst
          deliver(t.node, t.index, items);
        }
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
      const pin = ctx.execution.trigger === "test" ? ctx.def.pinData?.[node.name] : undefined;
      if (node.disabled || node.type === "note") {
        outputs = [inputItems];
        run.status = "skipped";
      } else if (pin && pin.length > 0) {
        // W6 — Pin-Daten im Testlauf: gespeicherte Ausgabe statt Ausfuehrung.
        outputs = [pin.map((it, i) => ({ json: it.json, pairedItem: { item: i } }))];
        run.status = "success";
        run.hinweise = ["Pin-Daten verwendet (Testlauf)"];
      } else {
        await this.awaitDependencies(ctx, node, run);
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

  /**
   * v0.1.603 — Daten-Abhaengigkeiten: Braucht der Node Daten einer Producer-
   * Stufe (z. B. $kassenbestand → Jahresabschluesse) und steckt die Firma des
   * Laufs noch in einem laufenden Vorgang, wird gewartet, bis diese Stufen im
   * Endzustand sind; danach wird der Firmen-Kontext neu geladen. Ausserhalb
   * eines Vorgangs wird nicht gewartet (fehlende Daten → Fallback).
   */
  private async awaitDependencies(ctx: RunContext, node: WorkflowNode, run: WorkflowNodeRun): Promise<void> {
    const txId = ctx.company?.scope.transactionId;
    const companyId = ctx.company?.scope.companyId;
    if (!txId || !companyId || node.type === "wait") return;
    const reqs = nodeRequirementsMitSub(node, (id) => this.deps.getDefinition(id));
    const offen = reqs.map((r) => r.stage).filter((s) => !ctx.stufenFertig.has(s));
    if (offen.length === 0) return;
    const start = Date.now();
    let gewartet = false;
    for (;;) {
      if (ctx.signal.aborted) throw new Error("aborted");
      let befund: VorgangsBefund;
      try {
        befund = bewertePipeline(await fetchPipeline(this.deps.gatewayRequest, txId), offen as PipelineStage[]);
      } catch {
        return; // Vorgang nicht abrufbar → nicht blockieren, Fallbacks greifen
      }
      const firma = befund.firmen.find((f) => f.companyId === companyId);
      if (!firma) return; // Firma nicht Teil des Vorgangs
      if (firma.stufenFertig) {
        for (const s of offen) ctx.stufenFertig.add(s);
        if (gewartet && ctx.company) {
          // Kontext neu laden: die gewarteten Daten sind jetzt da (oder endgueltig nicht).
          const trigger = ctx.def.nodes.find((n) => n.type === "trigger") ?? node;
          ctx.company = await buildCompanyContext(this.deps.registry, ctx.company.scope, this.toolContext(ctx, trigger, "none", "read", []));
          ctx.placeholderCache.clear();
        }
        const fehl = firma.fehlgeschlageneStufen.filter((s) => offen.includes(s));
        (run.hinweise ??= []).push(`Abhaengigkeiten: ${reqs.map((r) => `${STAGE_LABELS[r.stage]} (${r.grund})`).join(", ")}${gewartet ? " — gewartet" : ""}${fehl.length ? `; fehlgeschlagen: ${fehl.map((s) => STAGE_LABELS[s]).join(", ")} → Fallbacks` : ""}`);
        return;
      }
      if (ctx.execution.dryRun) {
        (run.hinweise ??= []).push(`Trockenlauf: ${firma.offeneStufen.map((s) => STAGE_LABELS[s]).join(", ")} noch in Verarbeitung — echter Lauf wartet darauf.`);
        return;
      }
      if (Date.now() - start > DEPENDENCY_WAIT_MS) throw new Error(`Abhaengigkeit nicht erfuellt: ${firma.offeneStufen.map((s) => STAGE_LABELS[s]).join(", ")} nach ${Math.round(DEPENDENCY_WAIT_MS / 3600_000)} h nicht verarbeitet.`);
      gewartet = true;
      await sleep(60_000, ctx.signal);
    }
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
        // Warten auf Zeit ODER auf den Abschluss eines Vorgangs (Import):
        // "Watcher" — pollt die Firmen des Vorgangs, bis alle im Endzustand sind.
        // v0.1.600 — Parameter des Warten-Nodes sind Expressions
        // ({{ $json.transactionId }}); vorher kam der Text unaufgeloest an.
        const wctx = this.exprContext(ctx, node, items, 0);
        const txRaw = resolveValue(node.parameters.transactionId, wctx);
        const txId = typeof txRaw === "string" && txRaw.trim()
          ? txRaw.trim()
          : items.length > 0 && typeof items[0]!.json.transactionId === "string"
            ? String(items[0]!.json.transactionId)
            : "";
        const txGefordert = typeof node.parameters.transactionId === "string" && node.parameters.transactionId.trim().length > 0;
        if (!txId && txGefordert) {
          const j = items[0]?.json ?? {};
          if (ctx.execution.dryRun) {
            // Im Trockenlauf gibt es keinen echten Import → hier endet der Test sauber.
            const run = ctx.execution.nodeRuns[node.name]?.at(-1);
            if (run) run.error = "Trockenlauf endet hier: Der Vorgang entsteht erst beim echten Import (Schreib-Schritt). Nachfolgende Schritte wurden nicht getestet.";
            ctx.gestoppt = true;
            return [items];
          }
          const details = [
            typeof j.importiert === "number" ? `importiert: ${j.importiert}` : null,
            Array.isArray(j.ohneOrt) && j.ohneOrt.length > 0 ? `ohne Ort (nicht importierbar): ${(j.ohneOrt as unknown[]).slice(0, 5).join(", ")}` : null,
            typeof j.error === "string" ? j.error : null,
          ].filter(Boolean);
          throw new Error(`Warten-Node: kein Vorgang vorhanden — der vorige Schritt hat keinen Import gestartet${details.length ? ` (${details.join(" · ")})` : ""}.`);
        }
        if (txId) {
          if (!/^[A-Za-z0-9_-]{8,64}$/.test(txId)) {
            throw new Error(`Warten-Node: „${txId.slice(0, 80)}“ ist keine Vorgangs-ID. Erwartet wird z. B. {{ $json.transactionId }} aus dem Ergebnis von discovery_decide oder import_*.`);
          }
          const maxMs = Math.min(72, Math.max(0.1, Number(resolveValue(node.parameters.maxHours, wctx) ?? 6))) * 3600_000;
          const start = Date.now();
          // v0.1.602 — Abschluss = Firmenprofil je Firma im Endzustand (Pipeline-
          // Matrix). Ausgabe: EIN Item je Firma (companyId, state = Profil-Zustand,
          // fehlgeschlageneStufen, transactionId) — direkt fuer Filter + Sub-Workflow.
          const w = waitStages(ctx.def, node, (id) => this.deps.getDefinition(id));
          const zuItems = (b: VorgangsBefund, dryRun: boolean): WorkflowItem[] =>
            b.firmen.map((f, i) => ({
              json: {
                companyId: f.companyId,
                state: f.state,
                vollstaendig: f.vollstaendig,
                fehlgeschlageneStufen: f.fehlgeschlageneStufen,
                fehler: f.fehler,
                gewarteteStufen: w.stufen,
                transactionId: txId,
                verarbeitung: { gesamt: b.gesamt, fertig: b.profilFertig, fehler: b.profilFehlgeschlagen, offen: b.profilOffen, teilfehler: b.teilfehler, ...(dryRun ? { dryRun: true } : {}) },
              },
              pairedItem: { item: Math.min(i, Math.max(0, items.length - 1)) },
            }));
          for (;;) {
            if (ctx.signal.aborted) throw new Error("aborted");
            let befund: VorgangsBefund;
            try {
              befund = bewertePipeline(await fetchPipeline(this.deps.gatewayRequest, txId), w.stufen);
            } catch (err) {
              throw new Error(`Vorgang ${txId} nicht abrufbar: ${err instanceof Error ? err.message : String(err)}`);
            }
            const offene = [...new Set(befund.firmen.flatMap((f) => f.offeneStufen))].map((s) => STAGE_LABELS[s]);
            if (befund.abgeschlossen) {
              const run = ctx.execution.nodeRuns[node.name]?.at(-1);
              if (run) (run.hinweise ??= []).push(`Gewartet auf: ${w.stufen.map((s) => STAGE_LABELS[s]).join(", ")}${w.automatisch ? " (automatisch aus den Folge-Schritten)" : ""}`);
              return [zuItems(befund, false)];
            }
            if (Date.now() - start > maxMs) {
              // v0.1.605 — kein Deadlock: Nach maxHours geht es mit den Firmen
              // weiter, deren Stufen im Endzustand sind; offene bleiben
              // state=pending (Filter „Nur fertige“ laesst sie aus).
              const run = ctx.execution.nodeRuns[node.name]?.at(-1);
              if (run) (run.hinweise ??= []).push(`Nach ${Math.round(maxMs / 3600_000)} h nicht vollstaendig: ${befund.profilOffen} von ${befund.gesamt} Firmen offen${offene.length ? ` (${offene.join(", ")})` : ""} — Lauf geht mit den fertigen Firmen weiter.`);
              return [zuItems(befund, false)];
            }
            if (ctx.execution.dryRun) {
              const run = ctx.execution.nodeRuns[node.name]?.at(-1);
              if (run) run.error = `Trockenlauf: Vorgang noch nicht abgeschlossen (${befund.profilFertig}/${befund.gesamt} Profile fertig${offene.length ? `; offen: ${offene.join(", ")}` : ""}) — Items mit aktuellem Stand weitergegeben.`;
              return [befund.firmen.length > 0 ? zuItems(befund, true) : items];
            }
            await sleep(60_000, ctx.signal);
          }
        }
        const minutes = Math.min(10080, Math.max(0, Number(resolveValue(node.parameters.minutes, wctx) ?? 0)));
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
        // Prime/Sub-Muster (Operator 2026-09-09): Der Prime-Workflow ist eine
        // Schleife ueber Firmen (Items mit companyId/discoveryId); je Item
        // startet der Sub-Workflow mit EIGENEM Firmenkontext. allItems =
        // einmal mit allen Items (Firma des uebergeordneten Laufs).
        const sub = this.deps.getDefinition(String(node.parameters.workflowId));
        if (!sub) throw new Error("Sub-Workflow nicht gefunden.");
        const perItem = (node.mode ?? "perItem") === "perItem";
        const gruppen: Array<{ items: WorkflowItem[]; company: CompanyScope | undefined; pairedIndex: number }> = perItem
          ? items.map((it, i) => ({ items: [it], company: scopeAusItem(it, ctx.company?.scope), pairedIndex: i }))
          : [{ items, company: ctx.company?.scope, pairedIndex: 0 }];
        const out: WorkflowItem[] = [];
        const fehler: string[] = [];
        for (const g of gruppen) {
          if (ctx.signal.aborted) throw new Error("aborted");
          try {
            const ex = await this.run(sub, { trigger: ctx.execution.trigger, dryRun: ctx.execution.dryRun, inputItems: g.items, signal: ctx.signal, depth: ctx.depth + 1, company: g.company });
            if (ex.status !== "success") throw new Error(`${ex.status}${ex.error ? ` — ${ex.error}` : ""}`);
            const last = Object.values(ex.nodeRuns).at(-1)?.at(-1)?.output?.[0] ?? [];
            out.push({ json: { subExecutionId: ex.id, status: ex.status, firma: ex.scope ?? null, summary: ex.summary ?? null, ergebnis: last.slice(0, 20).map((i) => i.json) }, pairedItem: { item: g.pairedIndex } });
          } catch (err) {
            const msg = err instanceof Error ? err.message : String(err);
            if (msg === "aborted") throw err;
            fehler.push(`${g.company?.companyName ?? g.company?.companyId ?? g.company?.discoveryId ?? `Item ${g.pairedIndex + 1}`}: ${msg}`);
            out.push({ json: { status: "error", firma: g.company ?? null, error: msg }, pairedItem: { item: g.pairedIndex } });
          }
        }
        if (fehler.length > 0) {
          const run = ctx.execution.nodeRuns[node.name]?.at(-1);
          if (run) run.hinweise = [...(run.hinweise ?? []), ...fehler.slice(0, 20)];
          if (fehler.length === gruppen.length) throw new Error(`Sub-Workflow „${sub.name}“ ist fuer alle ${gruppen.length} Firmen gescheitert: ${fehler[0]}`);
        }
        return [out];
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

  /** Schleifenkoerper: von Ausgang 0 des Loop-Nodes erreichbar, bis zurueck zum Loop-Node. */
  private loopBody(ctx: RunContext, loopName: string, allowed: Set<string>): Set<string> {
    const body = new Set<string>();
    const stack = (ctx.def.connections[loopName]?.main?.[0] ?? []).map((t) => t.node);
    while (stack.length > 0) {
      const n = stack.pop()!;
      if (n === loopName || body.has(n) || !allowed.has(n)) continue;
      body.add(n);
      for (const targets of ctx.def.connections[n]?.main ?? []) for (const t of targets ?? []) stack.push(t.node);
    }
    return body;
  }

  private async executeLoop(ctx: RunContext, node: WorkflowNode, items: WorkflowItem[], allowed: Set<string>): Promise<WorkflowItem[][]> {
    const size = Math.max(1, Number(node.parameters.batchSize ?? 10));
    const body = this.loopBody(ctx, node.name, allowed);
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
    this.deps.notify({
      art: "freigabe",
      title: `Workflow „${ctx.def.name}“ wartet auf Freigabe`,
      body: `${prompt}\nPer Telegram: /ja ${approval.id} oder /nein ${approval.id}`,
      workflowId: ctx.def.id,
      executionId: ctx.execution.id,
      approvalId: approval.id,
    });
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
      if (result && typeof result === "object" && !Array.isArray(result) && typeof (result as { error?: unknown }).error === "string") {
        throw new Error(String((result as { error: string }).error));
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
  state: WorkflowState;
  depth: number;
  mailsSent: number;
  itemsProduced: number;
  company: CompanyContext | null;
  placeholderCache: Map<string, unknown>;
  untilNode: string | null;
  gestoppt: boolean;
  /** Stufen, die fuer die Firma des Laufs bereits im Endzustand sind (Abhaengigkeiten). */
  stufenFertig: Set<PipelineStage>;
}

/** Firmenbezug aus einem Item (companyId/discoveryId/name), sonst der Eltern-Scope. */
function scopeAusItem(it: WorkflowItem, fallback: CompanyScope | undefined): CompanyScope | undefined {
  const j = it.json;
  const companyId = typeof j.companyId === "string" ? j.companyId : typeof j.masterCompanyId === "string" ? j.masterCompanyId : undefined;
  const discoveryId = typeof j.discoveryId === "string" ? j.discoveryId : undefined;
  const companyName = typeof j.name === "string" ? j.name : typeof j.companyName === "string" ? j.companyName : undefined;
  const transactionId = typeof j.transactionId === "string" ? j.transactionId : fallback?.transactionId;
  if (companyId) return { companyId, companyName, ...(transactionId ? { transactionId } : {}) };
  if (discoveryId) return { discoveryId, companyName };
  return fallback;
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


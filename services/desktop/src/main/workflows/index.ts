// W1 — WorkflowService: Fassade fuer Store, Engine, Zeitplan-Trigger,
// Ereignis-Trigger (W4-Haken), Freigaben und Katalog. Eine Instanz je App.

import { fetchAllTransactionEntities } from "../transaction-entities";
import type { ToolRegistry } from "../agent/tool-registry";
import type { LlmProviderManager } from "../agent/providers";
import type { AutonomyLevel } from "../../shared/types";
import {
  DEFAULT_WORKFLOW_SETTINGS,
  WORKFLOW_LIMITS,
  type OrgWorkflowRow,
  type WorkflowApproval,
  type WorkflowCatalogEntry,
  type WorkflowDefinition,
  type WorkflowEventKind,
  type WorkflowExecution,
  type WorkflowItem,
  type WorkflowListEntry,
  type WorkflowProgressFrame,
} from "../../shared/workflow-types";
import { WorkflowStore, validateDefinition, type ValidationProblem } from "./store";
import { WorkflowRunner } from "./runner";
import { buildCatalog, catalogForAgent, isToolAllowedInWorkflows } from "./catalog";
import type { CompanyScope } from "./context";
import { WORKFLOW_TEMPLATES, templateToDefinition } from "./templates";

const TICK_MS = 60_000;
/** Zeit-Trigger ohne Nachholen: nur innerhalb dieses Fensters nach der Uhrzeit. */
const AT_WINDOW_MS = 20 * 60_000;

export interface WorkflowServiceDeps {
  registry: ToolRegistry;
  providers: LlmProviderManager;
  getAutonomyLevel: () => AutonomyLevel;
  getTier: () => string | null;
  isSignedIn: () => boolean;
  emit: (frame: WorkflowProgressFrame) => void;
  audit: (entry: { action: string; severity: "info" | "warning" | "error"; summary: string; metadata: Record<string, unknown> }) => void;
  notify: (m: { art: "fertig" | "freigabe" | "fehler"; title: string; body: string; workflowId: string; executionId: string; approvalId?: string }) => void;
  /** Feature-Vorgabe der Organisation. */
  featureEnabled: () => boolean;
  /** Gateway-Lesezugriff fuer dynamische Firmenquellen (Matrix, Vorgaenge). */
  gatewayRequest: <T>(path: string, opts?: { method?: string; body?: unknown }) => Promise<T>;
  /** Eigene actorId (fuer „von mir geteilt“). */
  getActorId: () => string | null;
}

export class WorkflowService {
  readonly store: WorkflowStore;
  readonly runner: WorkflowRunner;
  private timer: NodeJS.Timeout | null = null;

  constructor(private readonly deps: WorkflowServiceDeps, dir?: string) {
    this.store = new WorkflowStore(dir);
    this.runner = new WorkflowRunner({
      registry: deps.registry,
      store: this.store,
      providers: deps.providers,
      getAutonomyLevel: deps.getAutonomyLevel,
      emit: deps.emit,
      audit: deps.audit,
      getDefinition: (id) => this.store.get(id),
      notify: deps.notify,
      gatewayRequest: (path) => deps.gatewayRequest(path),
    });
  }

  start(): void {
    if (this.timer) return;
    // Beim Start: offene Freigaben aus einem frueheren Prozess verfallen
    // (ihr Lauf lebt nicht mehr).
    const open = this.store.listApprovals();
    let changed = false;
    for (const a of open) {
      if (a.status === "open") {
        a.status = "expired";
        a.decidedAt = new Date().toISOString();
        a.note = "App wurde beendet, bevor entschieden wurde";
        changed = true;
      }
    }
    if (changed) this.store.saveApprovals(open);
    this.timer = setInterval(() => void this.tick(), TICK_MS);
    setTimeout(() => void this.tick(), 30_000);
    // v0.1.607 — Laeufe, die beim Beenden/Update noch liefen, fortsetzen
    // (Warten-Node) oder als abgebrochen markieren.
    setTimeout(() => void this.resumeInterrupted(), 20_000);
  }

  async resumeInterrupted(): Promise<{ fortgesetzt: number; abgebrochen: number }> {
    let fortgesetzt = 0;
    let abgebrochen = 0;
    if (!this.deps.isSignedIn()) return { fortgesetzt, abgebrochen };
    const laufend = new Set(this.runner.runningExecutions().map((e) => e.id));
    for (const w of this.store.list()) {
      for (const ex of this.store.listExecutions(w.id, 20)) {
        if (ex.status !== "running" || laufend.has(ex.id)) continue;
        const def = this.store.get(w.id);
        if (!def) continue;
        const r = await this.runner.resume(def, ex).catch(() => null);
        if (r && r.status !== "cancelled") fortgesetzt++;
        else abgebrochen++;
      }
    }
    if (fortgesetzt + abgebrochen > 0) {
      this.deps.audit({ action: "workflow.resume", severity: "info", summary: `Unterbrochene Workflow-Laeufe: ${fortgesetzt} fortgesetzt, ${abgebrochen} abgebrochen`, metadata: { fortgesetzt, abgebrochen } });
    }
    return { fortgesetzt, abgebrochen };
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
    for (const ex of this.runner.runningExecutions()) this.runner.cancel(ex.id);
  }

  // ---- Katalog ---------------------------------------------------------------

  catalog(): WorkflowCatalogEntry[] {
    return buildCatalog(this.deps.registry);
  }

  catalogText(): string {
    return catalogForAgent(this.catalog());
  }

  toolExists(name: string): boolean {
    return isToolAllowedInWorkflows(name) && this.deps.registry.get(name) !== undefined;
  }

  // ---- Definitionen ----------------------------------------------------------

  list(): WorkflowListEntry[] {
    const approvals = this.store.listApprovals().filter((a) => a.status === "open");
    return this.store.list().map((w) => {
      const last = this.store.listExecutions(w.id, 1)[0];
      return {
        id: w.id,
        name: w.name,
        description: w.description,
        version: w.version,
        enabled: w.enabled,
        trigger: w.trigger,
        nodeCount: w.nodes.filter((n) => n.type !== "note").length,
        lastRun: last ? { id: last.id, status: last.status, startedAt: last.startedAt, summary: last.summary } : null,
        nextRunAt: this.nextRunAt(w, last?.startedAt ?? null),
        openApprovals: approvals.filter((a) => a.workflowId === w.id).length,
        blocked: this.blockedReason(w),
      };
    });
  }

  get(id: string): WorkflowDefinition | null {
    return this.store.get(id);
  }

  resolve(idOrName: string): WorkflowDefinition | null {
    return this.store.get(idOrName) ?? this.store.findByName(idOrName);
  }

  validate(def: WorkflowDefinition): ValidationProblem[] {
    return validateDefinition(def, (n) => this.toolExists(n), (id) => this.store.get(id));
  }

  /** Grund, warum der Workflow gerade nicht laufen kann (Policy, Modell). */
  blockedReason(def: WorkflowDefinition): string | null {
    if (!this.deps.featureEnabled()) return "Workflows sind in deiner Organisation abgeschaltet.";
    for (const n of def.nodes) {
      if (n.type === "tool" && !n.disabled) {
        const t = String(n.parameters.tool ?? "");
        if (!this.toolExists(t)) return `Schritt „${n.name}“: Tool ${t} ist nicht verfuegbar (abgeschaltet oder unbekannt).`;
      }
      if (n.type === "ai" && !n.disabled && !this.deps.providers.getStatus().ready) {
        return `Schritt „${n.name}“: kein Hintergrund-Modell bereit (API-Schluessel oder lokales Modell noetig).`;
      }
    }
    return null;
  }

  save(input: Parameters<WorkflowStore["save"]>[0], opts: { createdBy: "user" | "agent" }): { workflow: WorkflowDefinition; problems: ValidationProblem[] } {
    const isNew = !input.id || !this.store.get(input.id);
    if (isNew) {
      const tier = (this.deps.getTier() ?? "free").toLowerCase();
      const limit = WORKFLOW_LIMITS[tier]?.maxWorkflows ?? null;
      if (limit !== null && this.store.list().length >= limit) {
        throw new Error(`Dein Plan (${tier}) erlaubt ${limit} Workflow${limit === 1 ? "" : "s"}. Mehr im Starter-Plan (Einstellungen → Abo).`);
      }
    }
    const workflow = this.store.save(input, opts);
    const problems = this.validate(workflow);
    this.deps.audit({
      action: isNew ? "workflow.create" : "workflow.update",
      severity: "info",
      summary: `Workflow „${workflow.name}“ ${isNew ? "angelegt" : `aktualisiert (v${workflow.version})`}`,
      metadata: { workflowId: workflow.id, nodes: workflow.nodes.length, trigger: workflow.trigger.kind, createdBy: opts.createdBy, problems: problems.length },
    });
    return { workflow, problems };
  }

  patch(id: string, patch: Partial<WorkflowDefinition>): WorkflowDefinition | null {
    const w = this.store.patch(id, patch);
    if (w) this.deps.audit({ action: "workflow.update", severity: "info", summary: `Workflow „${w.name}“ geaendert (v${w.version})`, metadata: { workflowId: id, felder: Object.keys(patch) } });
    return w;
  }

  delete(id: string): boolean {
    const w = this.store.get(id);
    if (!w) return false;
    for (const ex of this.runner.runningExecutions()) if (ex.workflowId === id) this.runner.cancel(ex.id);
    this.store.delete(id);
    this.store.deleteExecutions(id);
    this.store.deleteState(id);
    this.deps.audit({ action: "workflow.delete", severity: "warning", summary: `Workflow „${w.name}“ geloescht`, metadata: { workflowId: id } });
    return true;
  }

  // ---- Laeufe -----------------------------------------------------------------

  async run(
    id: string,
    opts: { trigger: WorkflowExecution["trigger"]; dryRun?: boolean; inputItems?: WorkflowItem[]; company?: CompanyScope; companyQuery?: string; untilNode?: string },
  ): Promise<WorkflowExecution> {
    const def = this.store.get(id);
    if (!def) throw new Error("Workflow nicht gefunden.");
    const blocked = this.blockedReason(def);
    if (blocked) throw new Error(blocked);
    const problems = this.validate(def);
    if (problems.length > 0) throw new Error(`Workflow unvollstaendig: ${problems.map((p) => (p.node ? `${p.node}: ` : "") + p.message).join("; ")}`);
    let company = opts.company;
    if (!company?.companyId && !company?.discoveryId && opts.companyQuery) {
      const kandidaten = await this.resolveCompany(opts.companyQuery);
      if (kandidaten.length === 0) throw new Error(`Keine Firma zu „${opts.companyQuery}“ gefunden.`);
      if (kandidaten.length > 1 && !kandidaten.some((k) => k.name.toLowerCase() === opts.companyQuery!.trim().toLowerCase())) {
        throw new Error(`Mehrere Firmen passen zu „${opts.companyQuery}“: ${kandidaten.slice(0, 5).map((k) => `${k.name} (${k.companyId})`).join(", ")} — bitte companyId angeben.`);
      }
      const k = kandidaten.find((x) => x.name.toLowerCase() === opts.companyQuery!.trim().toLowerCase()) ?? kandidaten[0]!;
      company = { companyId: k.companyId, companyName: k.name };
    }
    return this.runner.run(def, { trigger: opts.trigger, dryRun: opts.dryRun, inputItems: opts.inputItems, company, untilNode: opts.untilNode });
  }

  // ---- W8 — Vorlagen -------------------------------------------------------------

  templates(): Array<{ id: string; name: string; description: string; scope: "company" | "none"; trigger: string; verfuegbar: boolean; fehlendeTools: string[]; requires?: string }> {
    return WORKFLOW_TEMPLATES.map((t) => {
      const fehlende = t.tools.filter((n) => !this.toolExists(n));
      return { id: t.id, name: t.name, description: t.description, scope: t.scope, trigger: t.trigger.kind, verfuegbar: fehlende.length === 0, fehlendeTools: fehlende, requires: t.requires };
    });
  }

  /** Vorlage anlegen; benoetigte Sub-Vorlage wird mit angelegt (oder wiederverwendet). */
  createFromTemplate(templateId: string): { workflow: WorkflowDefinition; problems: ValidationProblem[]; angelegt: string[] } {
    const t = WORKFLOW_TEMPLATES.find((x) => x.id === templateId);
    if (!t) throw new Error("Vorlage nicht gefunden.");
    const fehlende = t.tools.filter((n) => !this.toolExists(n));
    if (fehlende.length > 0) throw new Error(`Vorlage braucht Tools, die nicht verfuegbar sind: ${fehlende.join(", ")}`);
    const angelegt: string[] = [];
    let subId: string | undefined;
    if (t.requires) {
      const subT = WORKFLOW_TEMPLATES.find((x) => x.id === t.requires);
      if (subT) {
        const vorhanden = this.store.list().find((w) => w.name === subT.name);
        if (vorhanden) subId = vorhanden.id;
        else {
          const r = this.save(templateToDefinition(subT), { createdBy: "user" });
          subId = r.workflow.id;
          angelegt.push(r.workflow.name);
        }
      }
    }
    const r = this.save(templateToDefinition(t, subId), { createdBy: "user" });
    angelegt.push(r.workflow.name);
    return { ...r, angelegt };
  }

  // ---- W7 — Teilen mit der Organisation ----------------------------------------

  /** Kopie der Definition in den Tenant legen (erneut = aktualisieren). */
  async shareToOrg(id: string): Promise<OrgWorkflowRow> {
    const def = this.store.get(id);
    if (!def) throw new Error("Workflow nicht gefunden.");
    // Ohne lokale Bezuege: Pin-Daten, feste Firmenlisten, Sub-Workflow-IDs bleiben, Trigger wird manuell.
    const { pinData: _pin, sharedFrom: _sf, ...rest } = def;
    void _pin;
    void _sf;
    const definition: Record<string, unknown> = {
      ...rest,
      trigger: def.trigger.kind === "schedule" ? { ...def.trigger, companyIds: [] } : def.trigger,
      enabled: true,
    };
    const r = await this.deps.gatewayRequest<{ workflow: OrgWorkflowRow }>("/v1/tenants/me/workflows", {
      method: "POST",
      body: { sourceId: def.id, name: def.name, description: def.description, version: def.version, definition },
    });
    this.deps.audit({ action: "workflow.share", severity: "info", summary: `Workflow „${def.name}“ mit der Organisation geteilt`, metadata: { workflowId: def.id, orgWorkflowId: r.workflow.id } });
    return r.workflow;
  }

  async listOrgWorkflows(): Promise<OrgWorkflowRow[]> {
    const r = await this.deps.gatewayRequest<{ items: OrgWorkflowRow[] }>("/v1/tenants/me/workflows");
    return r.items ?? [];
  }

  async revokeOrgWorkflow(orgId: string): Promise<void> {
    await this.deps.gatewayRequest(`/v1/tenants/me/workflows/${encodeURIComponent(orgId)}`, { method: "DELETE" });
    this.deps.audit({ action: "workflow.share.revoke", severity: "info", summary: `Geteilter Workflow ${orgId} zurueckgezogen`, metadata: { orgWorkflowId: orgId } });
  }

  /** Geteilten Workflow als eigene Kopie uebernehmen (Trigger manuell, Freigaben zurueckgesetzt). */
  async adoptFromOrg(orgId: string): Promise<{ workflow: WorkflowDefinition; problems: ValidationProblem[] }> {
    const r = await this.deps.gatewayRequest<{ workflow: OrgWorkflowRow }>(`/v1/tenants/me/workflows/${encodeURIComponent(orgId)}`);
    const src = r.workflow;
    const d = (src.definition ?? {}) as Partial<WorkflowDefinition>;
    if (!Array.isArray(d.nodes) || !d.connections || !d.trigger) throw new Error("Geteilte Definition ist unvollstaendig.");
    const vorhanden = this.store.list().find((w) => w.sharedFrom?.orgWorkflowId === src.id);
    const nodes = d.nodes.map((n) => ({ ...n, confirmed: false }));
    const saved = this.save(
      {
        ...(vorhanden ? { id: vorhanden.id } : {}),
        name: vorhanden?.name ?? src.name,
        description: src.description,
        nodes,
        connections: d.connections,
        variables: d.variables ?? {},
        trigger: { kind: "manual" },
        settings: { ...DEFAULT_WORKFLOW_SETTINGS, ...(d.settings ?? {}), errorWorkflowId: undefined },
        origin: { kind: "org" },
        enabled: true,
        sharedFrom: { orgWorkflowId: src.id, sharedBy: src.sharedByName ?? src.sharedBy },
      },
      { createdBy: "user" },
    );
    this.deps.audit({ action: "workflow.adopt", severity: "info", summary: `Geteilter Workflow „${src.name}“ uebernommen`, metadata: { orgWorkflowId: src.id, workflowId: saved.workflow.id } });
    return saved;
  }

  isSharedByMe(row: OrgWorkflowRow): boolean {
    return row.sharedBy === this.deps.getActorId();
  }

  /** W6 — grobe Kostenuebersicht je Lauf (Anzahl Schritte je Kostenklasse). */
  estimate(def: WorkflowDefinition): { frei: number; kontingent: number; ki: number; extern: number; platzhalter: number; hinweis: string } {
    const cat = new Map(this.catalog().map((c) => [c.type, c]));
    const out = { frei: 0, kontingent: 0, ki: 0, extern: 0, platzhalter: 0, hinweis: "" };
    for (const n of def.nodes) {
      if (n.disabled || n.type === "note" || n.type === "trigger") continue;
      const entry = n.type === "tool" ? cat.get(`tool:${String(n.parameters.tool)}`) : cat.get(n.type);
      const cls = entry?.costClass ?? "frei";
      out[cls]++;
      if (JSON.stringify(n.parameters).match(/\$[A-Za-zÄÖÜäöüß_][\wÄÖÜäöüß]*(?!\s*\()/)) out.platzhalter++;
    }
    const teile: string[] = [];
    if (out.ki > 0) teile.push(`${out.ki} KI-Schritt${out.ki > 1 ? "e" : ""}`);
    if (out.platzhalter > 0) teile.push(`${out.platzhalter} Schritt${out.platzhalter > 1 ? "e" : ""} mit Platzhaltern (je ein Modell-Aufruf)`);
    if (out.kontingent > 0) teile.push(`${out.kontingent} Kontingent-Schritt${out.kontingent > 1 ? "e" : ""} (Scan/Import/Profil)`);
    if (out.extern > 0) teile.push(`${out.extern} externe${out.extern > 1 ? "" : "r"} Aufruf${out.extern > 1 ? "e" : ""} (CRM/Mail/Apify)`);
    out.hinweis = teile.length > 0 ? `Je Firma: ${teile.join(", ")}. Firmen-Kontext kostet keinen KI-Aufruf.` : "Je Firma: nur lokale/freie Schritte.";
    return out;
  }

  /**
   * Mehrere Firmen „in die Pipeline“: je Firma ein Lauf (Leitgedanke bleibt),
   * bis zu 3 parallel, Ergebnis als Stapel-Zusammenfassung.
   */
  async runBatch(
    id: string,
    firmen: Array<CompanyScope | { companyQuery: string }>,
    opts: { trigger: WorkflowExecution["trigger"]; dryRun?: boolean },
  ): Promise<{ gestartet: number; fertig: Array<{ firma: CompanyScope | null; status: string; summary?: string; error?: string; executionId?: string }> }> {
    const def = this.store.get(id);
    if (!def) throw new Error("Workflow nicht gefunden.");
    const scopes: CompanyScope[] = [];
    const fehler: Array<{ firma: CompanyScope | null; status: string; error: string }> = [];
    for (const f of firmen.slice(0, 200)) {
      if ("companyQuery" in f) {
        const k = await this.resolveCompany(f.companyQuery);
        const exakt = k.find((x) => x.name.toLowerCase() === f.companyQuery.trim().toLowerCase()) ?? (k.length === 1 ? k[0] : undefined);
        if (!exakt) {
          fehler.push({ firma: null, status: "error", error: `Firma nicht eindeutig: „${f.companyQuery}“ (${k.slice(0, 3).map((x) => x.name).join(", ") || "kein Treffer"})` });
          continue;
        }
        scopes.push({ companyId: exakt.companyId, companyName: exakt.name });
      } else scopes.push(f);
    }
    const fertig: Array<{ firma: CompanyScope | null; status: string; summary?: string; error?: string; executionId?: string }> = [...fehler];
    const queue = [...scopes];
    const worker = async (): Promise<void> => {
      for (;;) {
        const company = queue.shift();
        if (!company) return;
        try {
          const ex = await this.run(def.id, { trigger: opts.trigger, dryRun: opts.dryRun, company });
          fertig.push({ firma: ex.scope ?? company, status: ex.status, summary: ex.summary, error: ex.error, executionId: ex.id });
        } catch (err) {
          fertig.push({ firma: company, status: "error", error: err instanceof Error ? err.message : String(err) });
        }
      }
    };
    await Promise.all(Array.from({ length: Math.min(3, queue.length) }, worker));
    this.deps.audit({ action: "workflow.batch", severity: "info", summary: `Workflow „${def.name}“ fuer ${scopes.length} Firmen gestartet (${fertig.filter((f) => f.status === "success").length} erfolgreich)`, metadata: { workflowId: def.id, firmen: scopes.length } });
    return { gestartet: scopes.length, fertig };
  }

  /** Firma per Name suchen (ueber das company_search-Tool). */
  async resolveCompany(query: string): Promise<Array<{ companyId: string; name: string; ort: string | null }>> {
    const tool = this.deps.registry.get("company_search");
    if (!tool) throw new Error("Firmensuche nicht verfuegbar.");
    const ctx = {
      signal: new AbortController().signal,
      log: () => {},
      ui: undefined as unknown as import("../agent/ui-bridge").UiBridge,
      autonomousMode: true,
    };
    const r = (await tool.run(tool.parseArgs({ q: query, limit: 10 }), ctx)) as { matches?: Array<Record<string, unknown>>; items?: Array<Record<string, unknown>>; results?: Array<Record<string, unknown>> } | Array<Record<string, unknown>>;
    const rows = Array.isArray(r) ? r : (r.matches ?? r.items ?? r.results ?? []);
    return rows
      .map((row) => ({
        companyId: String(row.companyId ?? row.id ?? ""),
        name: String(row.name ?? row.legalName ?? ""),
        ort: (row.city as string | undefined) ?? (row.location as string | undefined) ?? (row.ort as string | undefined) ?? null,
      }))
      .filter((x) => x.companyId && x.name);
  }

  cancel(executionId: string): boolean {
    if (this.runner.cancel(executionId)) return true;
    for (const w of this.store.list()) {
      const ex = this.store.getExecution(w.id, executionId);
      if (ex?.status === "waiting") {
        this.runner.cancelWaiting(ex);
        return true;
      }
    }
    return false;
  }

  /** v0.1.610 — wartende Laeufe (passives Warten auf Vorgaenge) weiterfuehren. */
  async continueWaitingAll(): Promise<number> {
    let n = 0;
    for (const w of this.store.list()) {
      for (const ex of this.store.listExecutions(w.id, 30)) {
        if (ex.status !== "waiting") continue;
        const def = this.store.get(w.id);
        if (!def) continue;
        const r = await this.runner.continueWaiting(def, ex).catch((err) => {
          this.deps.audit({ action: "workflow.run.error", severity: "error", summary: `Workflow „${w.name}“: Weiterfuehren fehlgeschlagen: ${err instanceof Error ? err.message : String(err)}`, metadata: { workflowId: w.id, executionId: ex.id } });
          return null;
        });
        if (r) n++;
      }
    }
    return n;
  }

  executions(workflowId: string, limit = 50): WorkflowExecution[] {
    const running = this.runner.runningExecutions().filter((e) => e.workflowId === workflowId);
    const stored = this.store.listExecutions(workflowId, limit).filter((e) => !running.some((r) => r.id === e.id));
    return [...running, ...stored].slice(0, limit);
  }

  execution(workflowId: string, executionId: string): WorkflowExecution | null {
    return this.runner.runningExecutions().find((e) => e.id === executionId) ?? this.store.getExecution(workflowId, executionId);
  }

  // ---- Freigaben -------------------------------------------------------------

  approvals(status: WorkflowApproval["status"] | "all" = "open"): WorkflowApproval[] {
    const all = this.store.listApprovals();
    return (status === "all" ? all : all.filter((a) => a.status === status)).sort((a, b) => b.createdAt.localeCompare(a.createdAt));
  }

  decideApproval(approvalId: string, approved: boolean, note?: string): boolean {
    return this.runner.resolveApproval(approvalId, approved, note);
  }

  // ---- Trigger ---------------------------------------------------------------

  /** W4-Haken: interne Ereignisse starten passende Workflows. */
  async emitEvent(event: WorkflowEventKind, payload: Record<string, unknown>): Promise<void> {
    if (!this.deps.isSignedIn() || !this.deps.featureEnabled()) return;
    for (const w of this.store.list()) {
      if (!w.enabled || w.trigger.kind !== "event" || w.trigger.event !== event) continue;
      if (w.trigger.filter && !matchesFilter(payload, w.trigger.filter)) continue;
      // Ein Lauf je Firma: das Ereignis muss eine Firma tragen (companyId oder discoveryId).
      const company: CompanyScope | undefined =
        typeof payload.companyId === "string" && payload.companyId
          ? { companyId: payload.companyId, companyName: typeof payload.companyName === "string" ? payload.companyName : undefined, ...(typeof payload.transactionId === "string" ? { transactionId: payload.transactionId } : {}) }
          : typeof payload.discoveryId === "string"
            ? { discoveryId: payload.discoveryId, companyName: typeof payload.name === "string" ? payload.name : undefined }
            : undefined;
      if ((w.settings.scope ?? "company") === "company" && !company) {
        this.deps.audit({ action: "workflow.run.skipped", severity: "warning", summary: `Workflow „${w.name}“ (Ereignis ${event}) uebersprungen: Ereignis traegt keine Firma`, metadata: { workflowId: w.id, event } });
        continue;
      }
      void this.run(w.id, { trigger: "event", inputItems: [{ json: payload }], company }).catch((err) =>
        this.deps.audit({ action: "workflow.run.error", severity: "error", summary: `Workflow „${w.name}“ (Ereignis ${event}) nicht gestartet: ${err instanceof Error ? err.message : String(err)}`, metadata: { workflowId: w.id } }),
      );
    }
  }

  /** Firmen fuer einen Zeitplan-Lauf: feste Liste + dynamische Quelle. */
  async resolveCompanySource(w: WorkflowDefinition): Promise<CompanyScope[]> {
    if (w.trigger.kind !== "schedule") return [];
    const out: CompanyScope[] = (w.trigger.companyIds ?? []).map((companyId) => ({ companyId }));
    const src = w.trigger.companySource;
    if (!src || src.kind === "list") return out;
    if (src.kind === "radarHot") {
      const tool = this.deps.registry.get("discovery_candidates");
      if (!tool) throw new Error("discovery_candidates nicht verfuegbar");
      const r = (await tool.run(tool.parseArgs({ limit: 200 }), this.leseKontext())) as { rows?: Array<Record<string, unknown>>; candidates?: Array<Record<string, unknown>> };
      const rows = r.rows ?? r.candidates ?? [];
      const min = src.minScore ?? 70;
      for (const row of rows) {
        const score = typeof row.matchScore === "number" ? row.matchScore : null;
        if (score === null || score < min) continue;
        if (src.nurNeue !== false && row.bereitsInAva === true) continue;
        if (typeof row.discoveryId === "string") out.push({ discoveryId: row.discoveryId, companyName: typeof row.name === "string" ? row.name : undefined });
      }
      return out;
    }
    if (src.kind === "transaction") {
      const r = { items: await fetchAllTransactionEntities(this.deps.gatewayRequest, src.transactionId) };
      for (const e of r.items ?? []) if (e.companyId && (e.state === undefined || e.state === "completed")) out.push({ companyId: e.companyId });
      return out;
    }
    if (src.kind === "allCompanies") {
      const limit = Math.min(src.limit ?? 200, 500);
      let page = 1;
      while (out.length < limit) {
        const r = await this.deps.gatewayRequest<{ companies?: Array<{ companyId: string; name?: string }> }>(`/v1/companies/matrix?pageNumber=${page}&pageSize=100`);
        const rows = r.companies ?? [];
        for (const c of rows) if (out.length < limit) out.push({ companyId: c.companyId, companyName: c.name });
        if (rows.length < 100) break;
        page++;
      }
      return out;
    }
    return out;
  }

  private leseKontext(): import("../agent/types").ToolContext {
    return { signal: new AbortController().signal, log: () => {}, ui: undefined as unknown as import("../agent/ui-bridge").UiBridge, autonomousMode: true };
  }

  private nextRunAt(w: WorkflowDefinition, lastStartedAt: string | null): string | null {
    if (!w.enabled || w.trigger.kind !== "schedule") return null;
    const t = w.trigger;
    if (t.intervalMinutes) {
      const base = lastStartedAt ? Date.parse(lastStartedAt) : Date.now();
      return new Date(Math.max(Date.now(), base + t.intervalMinutes * 60_000)).toISOString();
    }
    if (t.at) {
      const [hh, mm] = t.at.split(":").map(Number);
      const d = new Date();
      d.setHours(hh ?? 0, mm ?? 0, 0, 0);
      for (let i = 0; i < 8; i++) {
        const cand = new Date(d.getTime() + i * 86_400_000);
        if (cand.getTime() <= Date.now()) continue;
        if (t.weekdays && t.weekdays.length > 0 && !t.weekdays.includes(cand.getDay())) continue;
        return cand.toISOString();
      }
    }
    return null;
  }

  private async tick(): Promise<void> {
    if (!this.deps.isSignedIn() || !this.deps.featureEnabled()) return;
    await this.continueWaitingAll();
    const now = Date.now();
    for (const w of this.store.list()) {
      if (!w.enabled || w.trigger.kind !== "schedule" || this.runner.isRunning(w.id)) continue;
      if (this.blockedReason(w)) continue;
      const last = this.store.listExecutions(w.id, 1)[0];
      const lastMs = last ? Date.parse(last.startedAt) : 0;
      let due = false;
      const t = w.trigger;
      if (t.intervalMinutes) {
        due = now - lastMs >= t.intervalMinutes * 60_000;
      } else if (t.at) {
        const [hh, mm] = t.at.split(":").map(Number);
        const at = new Date();
        at.setHours(hh ?? 0, mm ?? 0, 0, 0);
        const okDay = !t.weekdays || t.weekdays.length === 0 || t.weekdays.includes(at.getDay());
        // Entscheidung 2026-09-09: kein Nachholen — nur im Fenster nach der Uhrzeit.
        due = okDay && now >= at.getTime() && now - at.getTime() < AT_WINDOW_MS && lastMs < at.getTime();
      }
      if (!due) continue;
      // Ein Lauf je Firma: Firmen aus fester Liste und/oder dynamischer Quelle.
      const scopePflicht = (w.settings.scope ?? "company") === "company";
      let firmen: CompanyScope[] = [];
      try {
        firmen = scopePflicht ? await this.resolveCompanySource(w) : [];
      } catch (err) {
        this.deps.audit({ action: "workflow.run.error", severity: "error", summary: `Workflow „${w.name}“ (Zeitplan): Firmenquelle nicht lesbar — ${err instanceof Error ? err.message : String(err)}`, metadata: { workflowId: w.id } });
        continue;
      }
      if (scopePflicht && firmen.length === 0) {
        this.deps.audit({ action: "workflow.run.skipped", severity: "warning", summary: `Workflow „${w.name}“ (Zeitplan) uebersprungen: keine Firmen (Trigger ohne companyIds/companySource oder Quelle leer)`, metadata: { workflowId: w.id } });
        continue;
      }
      // Firmen, die in diesem Zeitfenster schon liefen, ueberspringen (Zeitplan-Idempotenz).
      const state = this.store.getState(w.id);
      const fensterMs = t.intervalMinutes ? t.intervalMinutes * 60_000 : 20 * 3600_000;
      const offen = firmen.filter((f) => {
        const key = f.companyId ? `companyId:${f.companyId}` : `discoveryId:${f.discoveryId}`;
        const last = state.scopeRuns[key];
        return !last || now - Date.parse(last) >= fensterMs;
      });
      try {
        if (!scopePflicht) {
          await this.run(w.id, { trigger: "schedule" });
        } else {
          for (const company of offen.slice(0, 100)) {
            if (!this.store.get(w.id)?.enabled) break;
            await this.run(w.id, { trigger: "schedule", company });
          }
        }
      } catch (err) {
        this.deps.audit({ action: "workflow.run.error", severity: "error", summary: `Workflow „${w.name}“ (Zeitplan) nicht gestartet: ${err instanceof Error ? err.message : String(err)}`, metadata: { workflowId: w.id } });
      }
    }
  }
}

function matchesFilter(payload: Record<string, unknown>, filter: Record<string, unknown>): boolean {
  return Object.entries(filter).every(([k, v]) => {
    const actual = payload[k];
    if (Array.isArray(v)) return v.map(String).includes(String(actual));
    return String(actual) === String(v);
  });
}

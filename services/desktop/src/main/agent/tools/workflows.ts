// W1/W2 — Chat-Tools fuer Workflows (docs/PLAN_WORKFLOWS.md).
//
// workflow_list / workflow_get / workflow_catalog — lesen
// workflow_save   — Definition anlegen/ueberschreiben (Agent baut sie; Bestaetigung)
// workflow_update — Teile aendern (Trigger, enabled, Variablen, Node-Parameter; Bestaetigung)
// workflow_run    — starten (auch Trockenlauf)
// workflow_delete — loeschen (Bestaetigung)
// workflow_approvals / workflow_approve — offene Freigaben lesen/entscheiden
// workflow_from_conversation — Tool-Kette dieser Konversation als Entwurf (W2)

/* eslint-disable @typescript-eslint/no-explicit-any */
import * as yup from "yup";
import { defineTool, userDeclined } from "../define-tool";
import type { Tool } from "../types";
import type { AgentMessage } from "../../../shared/types";
import type { WorkflowDefinition, WorkflowNode, WorkflowTrigger } from "../../../shared/workflow-types";
import type { WorkflowService } from "../../workflows";
import { compileConversation } from "../../workflows/compiler";

export interface WorkflowToolDeps {
  /** Lazy — der Service entsteht im App-Boot. */
  getService: () => WorkflowService | null;
  /** Nachrichten der aktuellen Konversation (fuer workflow_from_conversation). */
  getConversationMessages: (conversationId: string) => AgentMessage[];
}

const nodeYup = yup.object({
  id: yup.string().optional(),
  name: yup.string().trim().min(1).max(80).required(),
  type: yup.string().required(),
  position: yup.array().of(yup.number().required()).length(2).optional(),
  parameters: yup.object().default({}),
  mode: yup.string().oneOf(["perItem", "allItems"]).optional(),
  disabled: yup.boolean().optional(),
  onError: yup.string().oneOf(["stop", "continue", "errorOutput"]).optional(),
  retryOnFail: yup.boolean().optional(),
  maxTries: yup.number().integer().min(1).max(5).optional(),
  confirmed: yup.boolean().optional(),
  notes: yup.string().optional(),
});

function autoLayout(nodes: WorkflowNode[]): WorkflowNode[] {
  return nodes.map((n, i) => ({ ...n, position: n.position ?? [80 + i * 260, 120] }));
}

/** Kompaktdarstellung fuer den Agenten (ohne Positionen). */
function kompakt(def: WorkflowDefinition): Record<string, unknown> {
  return {
    id: def.id,
    name: def.name,
    description: def.description,
    version: def.version,
    enabled: def.enabled,
    trigger: def.trigger,
    variables: def.variables,
    settings: def.settings,
    nodes: def.nodes.map((n) => ({ name: n.name, type: n.type, parameters: n.parameters, mode: n.mode, confirmed: n.confirmed, disabled: n.disabled, onError: n.onError })),
    connections: def.connections,
  };
}

export function buildWorkflowTools(deps: WorkflowToolDeps): Tool[] {
  const svc = (): WorkflowService => {
    const s = deps.getService();
    if (!s) throw new Error("Workflows noch nicht initialisiert.");
    return s;
  };

  const list = defineTool({
    name: "workflow_list",
    summary: "Gespeicherte Workflows mit Trigger, letztem Lauf und offenen Freigaben auflisten.",
    category: "workflow workflows automatisierung ablauf ablaeufe",
    description: "Listet alle Workflows des Nutzers: Name, Trigger, letzter Lauf, naechster Lauf, offene Freigaben, Blockaden.",
    parameters: { type: "object", properties: {} },
    schema: yup.object({}).noUnknown(true),
    preview: (r: { workflows: unknown[] }) => `${r.workflows.length} Workflows`,
    run: async () => ({ workflows: svc().list() }),
  });

  const get = defineTool({
    name: "workflow_get",
    summary: "Einen Workflow vollstaendig lesen (Nodes, Kanten, Trigger, letzte Laeufe).",
    category: "workflow workflows automatisierung ablauf",
    description: "Liefert die Definition eines Workflows (per id oder Name) plus die letzten 5 Laeufe mit Status und Zusammenfassung.",
    parameters: { type: "object", required: ["workflow"], properties: { workflow: { type: "string", description: "id oder Name" } } },
    schema: yup.object({ workflow: yup.string().trim().min(1).required() }).noUnknown(true),
    preview: (r: Record<string, any>) => (r.error as string | undefined) ?? `Workflow „${(r.workflow as { name?: string } | undefined)?.name}“`,
    run: async (args) => {
      const def = svc().resolve(args.workflow);
      if (!def) return { error: `Workflow nicht gefunden: ${args.workflow}` };
      return { workflow: kompakt(def), problems: svc().validate(def), blocked: svc().blockedReason(def), laeufe: svc().executions(def.id, 5).map((e) => ({ id: e.id, status: e.status, trigger: e.trigger, startedAt: e.startedAt, summary: e.summary, error: e.error })) };
    },
  });

  const catalog = defineTool({
    name: "workflow_catalog",
    summary: "Node-Katalog fuer Workflows: erlaubte Tools und Logik-Nodes mit Parametern.",
    category: "workflow workflows nodes katalog bauen entwurf",
    description:
      "Liefert den Katalog aller Node-Typen fuer Workflows: Logik-Nodes (trigger, filter, if, switch, transform, loop, merge, ai, wait, human, stop, subworkflow) " +
      "und Tool-Nodes ('tool:<name>') mit Parametern, Wirkungsklasse (read/additive/mutating/destructive) und Kostenklasse. Vor workflow_save aufrufen. " +
      "Expressions: {{ $json.feld }}, {{ $('Node-Name').item.json.feld }}, {{ $input.all() }}, {{ $vars.name }}, {{ $now }}. " +
      "Tool-Node: parameters = { tool: '<name>', args: {...}, outputPath?: 'items', itemKey?: 'discoveryId' }; mode perItem (Default) oder allItems. " +
      "FIRMENBEZUG: Jeder Lauf gilt fuer GENAU EINE Firma; ihr vollstaendiger Kontext (Stammdaten, Profil, Finanzen/Kennzahlen, Kontakte, CRM) liegt dem Lauf vor. " +
      "In Node-Parametern duerfen SEMANTISCHE PLATZHALTER stehen, frei benannt, z. B. $kassenbestand, $ansprechpartner_vertrieb, $umsatz_letztes_jahr — sie werden je Lauf per KI aus dem " +
      "Firmen-Kontext nach Bedeutung befuellt. Immer einen Fallback mitgeben: $kassenbestand ?? \"Es liegt KEIN Kassenbestand vor\". Strukturiert: {{ $company }} (Objekt), {{ $context }} (Klartext).",
    parameters: { type: "object", properties: { suche: { type: "string", description: "Optionaler Filter (Name/Kategorie/Text)" } } },
    schema: yup.object({ suche: yup.string().trim().optional() }).noUnknown(true),
    preview: (r: { eintraege: number }) => `${r.eintraege} Node-Typen`,
    run: async (args) => {
      const all = svc().catalog();
      const q = args.suche?.toLowerCase();
      const gefiltert = q ? all.filter((e) => `${e.type} ${e.label} ${e.category} ${e.summary}`.toLowerCase().includes(q)) : all;
      return { eintraege: gefiltert.length, katalog: gefiltert.map((e) => ({ type: e.type, label: e.label, category: e.category, summary: e.summary, actionKind: e.actionKind, costClass: e.costClass, parameters: e.parameters })) };
    },
  });

  const save = defineTool({
    name: "workflow_save",
    summary: "Workflow anlegen oder ueberschreiben (Nodes + Kanten + Trigger). Fragt vorher nach.",
    category: "workflow workflows speichern anlegen bauen automatisierung",
    description:
      "Speichert eine Workflow-Definition. nodes: Liste mit name (eindeutig), type, parameters, mode, confirmed; connections: { '<Node-Name>': { main: [[{ node, index }], ...] } } " +
      "(Ausgang 0 = erster Eintrag; if: 0 = wahr, 1 = falsch; loop: 0 = loop, 1 = done). Genau ein Node vom Typ trigger. " +
      "Schreib-Nodes laufen unbeaufsichtigt nur mit Vollmacht oder confirmed=true; mail_send braucht immer confirmed oder einen human-Node davor. " +
      "Der Trigger ist beim Anlegen 'manual', ausser der Nutzer wuenscht ausdruecklich einen Zeitplan (dann companyIds im Trigger, ein Lauf je Firma). " +
      "settings.scope: 'company' (Default, Lauf je Firma mit vollem Kontext) oder 'none' (ohne Firmenbezug, z. B. nur Radar starten). " +
      "Nutze semantische Platzhalter mit Fallback ($kassenbestand ?? \"kein Kassenbestand bekannt\") statt fester Feldnamen. Zeigt den Entwurf und fragt vor dem Speichern nach.",
    parameters: {
      type: "object",
      required: ["name", "nodes", "connections"],
      properties: {
        id: { type: "string", description: "Beim Ueberschreiben" },
        name: { type: "string" },
        description: { type: "string" },
        nodes: { type: "array", items: { type: "object" } },
        connections: { type: "object" },
        variables: { type: "object", description: "{ name: { label, type, value } }" },
        trigger: {
          type: "object",
          description:
            "{ kind: 'manual' | 'schedule' | 'event' | 'chat', intervalMinutes?, at?: 'HH:MM', weekdays?, event?, companyIds?: string[], companySource?: " +
            "{ kind: 'list' } | { kind: 'radarHot', minScore?: number, nurNeue?: boolean } | { kind: 'transaction', transactionId } | { kind: 'allCompanies', limit? } } — Zeitplan: je Firma ein Lauf",
        },
        settings: { type: "object" },
      },
    },
    schema: yup
      .object({
        id: yup.string().optional(),
        name: yup.string().trim().min(1).max(120).required(),
        description: yup.string().max(2000).optional(),
        nodes: yup.array().of(nodeYup).min(1).required(),
        connections: yup.object().required(),
        variables: yup.object().optional(),
        trigger: yup.object().optional(),
        settings: yup.object().optional(),
      })
      .noUnknown(true),
    preview: (r: Record<string, any>) =>
      (r.error as string | undefined) ?? (r.abgebrochen ? "abgebrochen" : `Workflow „${r.workflow?.name}“ gespeichert (v${r.workflow?.version})${(r.problems?.length ?? 0) > 0 ? ` — ${r.problems.length} Hinweise` : ""}`),
    run: async (args, c) => {
      const nodes = autoLayout(
        args.nodes.map((n, i) => ({
          id: n.id ?? `n${i + 1}`,
          name: n.name,
          type: n.type as WorkflowNode["type"],
          position: (n.position as [number, number] | undefined) ?? ([80 + i * 260, 120] as [number, number]),
          parameters: (n.parameters ?? {}) as Record<string, unknown>,
          ...(n.mode ? { mode: n.mode as "perItem" | "allItems" } : {}),
          ...(n.disabled !== undefined ? { disabled: n.disabled } : {}),
          ...(n.onError ? { onError: n.onError as WorkflowNode["onError"] } : {}),
          ...(n.retryOnFail !== undefined ? { retryOnFail: n.retryOnFail } : {}),
          ...(n.maxTries !== undefined ? { maxTries: n.maxTries } : {}),
          ...(n.confirmed !== undefined ? { confirmed: n.confirmed } : {}),
          ...(n.notes ? { notes: n.notes } : {}),
        })),
      );
      const trigger = (args.trigger ?? { kind: "manual" }) as WorkflowTrigger;
      const schritte = nodes.map((n, i) => `${i + 1}. ${n.name} (${n.type === "tool" ? String(n.parameters.tool) : n.type}${n.confirmed ? ", freigegeben" : ""})`).join("\n");
      const value = await c.ui.confirmAction(
        {
          kind: "additive",
          prompt: `Workflow „${args.name}“ ${args.id ? "ueberschreiben" : "anlegen"}?\n\nTrigger: ${trigger.kind}\n${schritte}`,
          confirmValue: "ja",
          options: [
            { value: "ja", label: "Speichern" },
            { value: "nein", label: "Abbrechen" },
          ],
        },
        c.signal,
      );
      if (value !== "ja") return { ...userDeclined(), abgebrochen: true };
      try {
        const { workflow, problems } = svc().save(
          {
            ...(args.id ? { id: args.id } : {}),
            name: args.name,
            description: args.description ?? "",
            nodes,
            connections: args.connections as WorkflowDefinition["connections"],
            variables: (args.variables ?? {}) as WorkflowDefinition["variables"],
            trigger,
            ...(args.settings ? { settings: args.settings as WorkflowDefinition["settings"] } : {}),
            origin: { kind: "chat" },
          },
          { createdBy: "agent" },
        );
        return { workflow: kompakt(workflow), problems, hinweis: problems.length > 0 ? "Der Workflow ist gespeichert, kann aber erst laufen, wenn die Hinweise behoben sind (workflow_update)." : "Gespeichert. Mit workflow_run (dryRun=true) testen; unter Vorgaenge → Workflows ansehen." };
      } catch (err) {
        return { error: err instanceof Error ? err.message : String(err) };
      }
    },
  });

  const update = defineTool({
    name: "workflow_update",
    summary: "Teile eines Workflows aendern: Trigger, aktiv/pausiert, Variablen, Einstellungen, einzelne Node-Parameter.",
    category: "workflow workflows aendern trigger zeitplan pausieren",
    description:
      "Aendert einen Workflow gezielt: enabled, trigger, variables, settings oder Node-Aenderungen (nodePatches: [{ name, parameters?, confirmed?, disabled?, mode?, onError? }]). " +
      "Fuer Umbauten der Struktur workflow_save mit der vollen Definition nutzen. Fragt vor der Aenderung nach.",
    parameters: {
      type: "object",
      required: ["workflow"],
      properties: {
        workflow: { type: "string", description: "id oder Name" },
        enabled: { type: "boolean" },
        trigger: { type: "object" },
        variables: { type: "object" },
        settings: { type: "object" },
        nodePatches: { type: "array", items: { type: "object" } },
        name: { type: "string" },
        description: { type: "string" },
      },
    },
    schema: yup
      .object({
        workflow: yup.string().trim().min(1).required(),
        enabled: yup.boolean().optional(),
        trigger: yup.object().optional(),
        variables: yup.object().optional(),
        settings: yup.object().optional(),
        nodePatches: yup.array().of(yup.object({ name: yup.string().required(), parameters: yup.object().optional(), confirmed: yup.boolean().optional(), disabled: yup.boolean().optional(), mode: yup.string().oneOf(["perItem", "allItems"]).optional(), onError: yup.string().oneOf(["stop", "continue", "errorOutput"]).optional() })).optional(),
        name: yup.string().trim().min(1).max(120).optional(),
        description: yup.string().max(2000).optional(),
      })
      .noUnknown(true),
    preview: (r: Record<string, any>) => (r.error as string | undefined) ?? (r.abgebrochen ? "abgebrochen" : `Workflow „${r.workflow?.name}“ geaendert (v${r.workflow?.version})`),
    run: async (args, c) => {
      const def = svc().resolve(args.workflow);
      if (!def) return { error: `Workflow nicht gefunden: ${args.workflow}` };
      const aenderungen: string[] = [];
      if (args.enabled !== undefined) aenderungen.push(`aktiv → ${args.enabled ? "ja" : "nein"}`);
      if (args.trigger) aenderungen.push(`Trigger → ${JSON.stringify(args.trigger)}`);
      if (args.variables) aenderungen.push(`Variablen → ${Object.keys(args.variables).join(", ")}`);
      if (args.settings) aenderungen.push(`Einstellungen → ${Object.keys(args.settings).join(", ")}`);
      if (args.name) aenderungen.push(`Name → ${args.name}`);
      for (const p of args.nodePatches ?? []) aenderungen.push(`Node „${p.name}“ → ${Object.keys(p).filter((k) => k !== "name").join(", ")}`);
      if (aenderungen.length === 0) return { error: "Keine Aenderung angegeben." };
      const value = await c.ui.confirmAction(
        { kind: "mutating", prompt: `Workflow „${def.name}“ aendern:\n${aenderungen.join("\n")}`, confirmValue: "ja", options: [{ value: "ja", label: "Aendern" }, { value: "nein", label: "Abbrechen" }] },
        c.signal,
      );
      if (value !== "ja") return { ...userDeclined(), abgebrochen: true };
      const nodes = def.nodes.map((n) => {
        const p = (args.nodePatches ?? []).find((x) => x.name === n.name);
        if (!p) return n;
        return {
          ...n,
          ...(p.parameters ? { parameters: { ...n.parameters, ...(p.parameters as Record<string, unknown>) } } : {}),
          ...(p.confirmed !== undefined ? { confirmed: p.confirmed } : {}),
          ...(p.disabled !== undefined ? { disabled: p.disabled } : {}),
          ...(p.mode ? { mode: p.mode as "perItem" | "allItems" } : {}),
          ...(p.onError ? { onError: p.onError as WorkflowNode["onError"] } : {}),
        };
      });
      const unbekannt = (args.nodePatches ?? []).filter((p) => !def.nodes.some((n) => n.name === p.name)).map((p) => p.name);
      if (unbekannt.length > 0) return { error: `Unbekannte Nodes: ${unbekannt.join(", ")}` };
      const w = svc().patch(def.id, {
        nodes,
        ...(args.enabled !== undefined ? { enabled: args.enabled } : {}),
        ...(args.trigger ? { trigger: args.trigger as WorkflowTrigger } : {}),
        ...(args.variables ? { variables: { ...def.variables, ...(args.variables as WorkflowDefinition["variables"]) } } : {}),
        ...(args.settings ? { settings: { ...def.settings, ...(args.settings as Partial<WorkflowDefinition["settings"]>) } } : {}),
        ...(args.name ? { name: args.name } : {}),
        ...(args.description !== undefined ? { description: args.description } : {}),
      });
      if (!w) return { error: "Speichern fehlgeschlagen." };
      return { workflow: kompakt(w), problems: svc().validate(w) };
    },
  });

  const run = defineTool({
    name: "workflow_run",
    summary: "Workflow jetzt starten — optional als Trockenlauf (Schreib-Schritte nur als Vorschau).",
    category: "workflow workflows starten ausfuehren testen trockenlauf",
    description:
      "Startet einen Workflow fuer EINE Firma (firma = Name oder companyId; Pflicht, ausser settings.scope = 'none'). dryRun=true fuehrt Lese-Schritte echt aus, zeigt Schreib-Schritte (CRM, Mail, Import) aber nur als Vorschau — ideal zum Testen. " +
      "Laeuft asynchron; das Ergebnis kommt als Meldung. Mit warten=true wartet das Tool bis zu 5 Minuten auf das Ende und liefert die Zusammenfassung inkl. befuellter Platzhalter.",
    parameters: { type: "object", required: ["workflow"], properties: { workflow: { type: "string" }, firma: { type: "string", description: "Firmenname oder companyId (aus company_search)" }, discoveryId: { type: "string", description: "Alternativ: Radar-Kandidat" }, dryRun: { type: "boolean" }, warten: { type: "boolean" } } },
    schema: yup.object({ workflow: yup.string().trim().min(1).required(), firma: yup.string().trim().optional(), discoveryId: yup.string().trim().optional(), dryRun: yup.boolean().optional(), warten: yup.boolean().optional() }).noUnknown(true),
    preview: (r: Record<string, any>) => (r.error as string | undefined) ?? (r.execution ? `${r.execution.status}: ${r.execution.summary ?? ""}` : r.gestartet ? "gestartet" : "–"),
    run: async (args, c) => {
      const def = svc().resolve(args.workflow);
      if (!def) return { error: `Workflow nicht gefunden: ${args.workflow}` };
      if (!args.dryRun) {
        const schreib = def.nodes.filter((n) => n.type === "tool" && !n.disabled && n.confirmed).map((n) => n.name);
        const value = await c.ui.confirmAction(
          { kind: "additive", prompt: `Workflow „${def.name}“ jetzt echt ausfuehren?${schreib.length > 0 ? `\nFreigegebene Schreib-Schritte: ${schreib.join(", ")}` : ""}`, confirmValue: "ja", options: [{ value: "ja", label: "Starten" }, { value: "nein", label: "Abbrechen" }] },
          c.signal,
        );
        if (value !== "ja") return { ...userDeclined(), abgebrochen: true };
      }
      try {
        const firma = args.firma?.trim();
        const istId = firma ? /^[A-Z0-9_]+_(HRB|HRA|GNR|PR|VR)_\d+$/i.test(firma) || firma.startsWith("cmp_") : false;
        const p = svc().run(def.id, {
          trigger: args.dryRun ? "test" : "chat",
          dryRun: args.dryRun === true,
          ...(args.discoveryId ? { company: { discoveryId: args.discoveryId } } : istId ? { company: { companyId: firma! } } : firma ? { companyQuery: firma } : {}),
        });
        if (args.warten) {
          const ex = await Promise.race([p, new Promise<null>((r) => setTimeout(() => r(null), 5 * 60_000))]);
          if (ex)
            return {
              execution: {
                id: ex.id,
                status: ex.status,
                firma: ex.scope,
                summary: ex.summary,
                error: ex.error,
                schritte: Object.fromEntries(Object.entries(ex.nodeRuns).map(([n, runs]) => [n, runs.at(-1)?.outputItems])),
                platzhalter: Object.fromEntries(Object.entries(ex.nodeRuns).filter(([, runs]) => runs.at(-1)?.platzhalter).map(([n, runs]) => [n, runs.at(-1)!.platzhalter])),
                hinweise: Object.fromEntries(Object.entries(ex.nodeRuns).filter(([, runs]) => runs.at(-1)?.hinweise?.length).map(([n, runs]) => [n, runs.at(-1)!.hinweise])),
                vorschau: args.dryRun ? Object.fromEntries(Object.entries(ex.nodeRuns).map(([n, runs]) => [n, (runs.at(-1)?.output?.[0] ?? []).slice(0, 5).map((i) => i.json)])) : undefined,
              },
            };
          return { gestartet: true, hinweis: "Laeuft noch — Ergebnis kommt als Meldung; workflow_get zeigt den Stand." };
        }
        void p.catch(() => {});
        return { gestartet: true, hinweis: "Gestartet — Ergebnis kommt als Meldung; workflow_get zeigt den Stand." };
      } catch (err) {
        return { error: err instanceof Error ? err.message : String(err) };
      }
    },
  });

  const del = defineTool({
    name: "workflow_delete",
    summary: "Workflow samt Laeufen loeschen (Bestaetigung).",
    category: "workflow workflows loeschen entfernen",
    description: "Loescht einen Workflow und seine Lauf-Historie. Fragt vor dem Loeschen nach.",
    parameters: { type: "object", required: ["workflow"], properties: { workflow: { type: "string" } } },
    schema: yup.object({ workflow: yup.string().trim().min(1).required() }).noUnknown(true),
    preview: (r: Record<string, any>) => (r.error as string | undefined) ?? (r.geloescht ? "geloescht" : "abgebrochen"),
    run: async (args, c) => {
      const def = svc().resolve(args.workflow);
      if (!def) return { error: `Workflow nicht gefunden: ${args.workflow}` };
      const value = await c.ui.confirmAction({ kind: "destructive", prompt: `Workflow „${def.name}“ endgueltig loeschen?`, confirmValue: "ja", options: [{ value: "ja", label: "Loeschen" }, { value: "nein", label: "Abbrechen" }] }, c.signal);
      if (value !== "ja") return { ...userDeclined(), geloescht: false };
      return { geloescht: svc().delete(def.id) };
    },
  });

  const approvals = defineTool({
    name: "workflow_approvals",
    summary: "Offene Freigaben (Human-in-the-Loop) aller Workflows anzeigen.",
    category: "workflow workflows freigabe freigaben genehmigen offen",
    description: "Listet offene Freigaben: welcher Workflow wartet an welchem Schritt worauf, mit Vorschau der betroffenen Items.",
    parameters: { type: "object", properties: {} },
    schema: yup.object({}).noUnknown(true),
    preview: (r: { freigaben: unknown[] }) => `${r.freigaben.length} offene Freigaben`,
    run: async () => ({ freigaben: svc().approvals("open").map((a) => ({ id: a.id, workflow: a.workflowName, schritt: a.nodeName, prompt: a.prompt, items: a.items.length, vorschau: a.items.slice(0, 5).map((i) => i.json), seit: a.createdAt })) }),
  });

  const approve = defineTool({
    name: "workflow_approve",
    summary: "Eine offene Freigabe erteilen oder ablehnen; der Workflow laeuft dann weiter bzw. bricht ab.",
    category: "workflow workflows freigabe genehmigen ablehnen",
    description: "Entscheidet eine offene Freigabe (id aus workflow_approvals). approved=true laesst den Workflow weiterlaufen, false bricht den Lauf ab. Fragt vor der Entscheidung nach.",
    parameters: { type: "object", required: ["approvalId", "approved"], properties: { approvalId: { type: "string" }, approved: { type: "boolean" }, note: { type: "string" } } },
    schema: yup.object({ approvalId: yup.string().trim().min(1).required(), approved: yup.boolean().required(), note: yup.string().max(500).optional() }).noUnknown(true),
    preview: (r: Record<string, any>) => (r.error as string | undefined) ?? (r.entschieden ? (r.approved ? "freigegeben" : "abgelehnt") : "abgebrochen"),
    run: async (args, c) => {
      const a = svc().approvals("open").find((x) => x.id === args.approvalId);
      if (!a) return { error: "Freigabe nicht gefunden oder bereits entschieden." };
      const value = await c.ui.confirmAction(
        { kind: args.approved ? "mutating" : "additive", prompt: `Workflow „${a.workflowName}“, Schritt „${a.nodeName}“: ${a.prompt}\n\n${args.approved ? "FREIGEBEN" : "ABLEHNEN"}?`, confirmValue: "ja", options: [{ value: "ja", label: args.approved ? "Freigeben" : "Ablehnen" }, { value: "nein", label: "Abbrechen" }] },
        c.signal,
      );
      if (value !== "ja") return { ...userDeclined(), entschieden: false };
      return { entschieden: svc().decideApproval(a.id, args.approved, args.note), approved: args.approved };
    },
  });

  const fromConversation = defineTool({
    name: "workflow_from_conversation",
    summary: "Die Tool-Schritte dieser Konversation als Workflow-Entwurf zusammenstellen („speicher das als Workflow“).",
    category: "workflow workflows speichern konversation schritte entwurf",
    description:
      "Kompiliert die bisherigen Tool-Aufrufe dieser Konversation zu einem Workflow-Entwurf: Meta-Tools raus, Fehlversuche gefaltet, wiederholte gleichartige Aufrufe zu EINEM Node je Item, " +
      "wiederkehrende IDs zu Expressions auf den Vorgaenger-Node. Liefert den Entwurf (nodes, connections, hinweise) — pruefe ihn, ergaenze Namen/Filter/Variablen und speichere mit workflow_save. " +
      "Optional sinceMessageId: nur Schritte ab dieser Nachricht.",
    parameters: { type: "object", properties: { conversationId: { type: "string", description: "Aktuelle Konversation (wird automatisch gesetzt, falls bekannt)" }, sinceMessageId: { type: "string" }, name: { type: "string", description: "Vorschlag fuer den Workflow-Namen" } } },
    schema: yup.object({ conversationId: yup.string().optional(), sinceMessageId: yup.string().optional(), name: yup.string().max(120).optional() }).noUnknown(true),
    preview: (r: Record<string, any>) => (r.error as string | undefined) ?? `Entwurf mit ${r.entwurf?.nodes?.length ?? 0} Schritten`,
    run: async (args, c) => {
      const convId = args.conversationId ?? c.conversationId ?? "";
      const messages = convId ? deps.getConversationMessages(convId) : [];
      if (messages.length === 0) return { error: "Keine Konversation gefunden — conversationId angeben." };
      const entwurf = compileConversation(messages, { sinceMessageId: args.sinceMessageId, name: args.name, toolAllowed: (n) => svc().toolExists(n) });
      if (entwurf.nodes.length <= 1) return { error: "In dieser Konversation gab es keine Tool-Schritte, die sich als Workflow speichern lassen." };
      return { entwurf, hinweis: "Entwurf pruefen (Namen, Expressions mit Hinweis „pruefen“, Filter, Variablen), dann workflow_save aufrufen. Trigger bleibt manual, bis der Nutzer einen Zeitplan wuenscht." };
    },
  });

  const share = defineTool({
    name: "workflow_share",
    summary: "Einen Workflow mit der eigenen Organisation teilen (Kopie der Definition; Bestaetigung).",
    category: "workflow workflows teilen organisation kollegen",
    description: "Teilt einen Workflow (id oder Name) mit der Organisation. Mitglieder koennen ihn als eigene Kopie uebernehmen; Zugaenge und Freigaben setzen sie selbst. Erneutes Teilen aktualisiert. Fragt vorher nach.",
    parameters: { type: "object", required: ["workflow"], properties: { workflow: { type: "string" } } },
    schema: yup.object({ workflow: yup.string().trim().min(1).required() }).noUnknown(true),
    preview: (r: Record<string, any>) => (r.error as string | undefined) ?? (r.geteilt ? "geteilt" : "abgebrochen"),
    run: async (args, c) => {
      const def = svc().resolve(args.workflow);
      if (!def) return { error: `Workflow nicht gefunden: ${args.workflow}` };
      const value = await c.ui.confirmAction({ kind: "additive", prompt: `Workflow „${def.name}“ mit der Organisation teilen?`, confirmValue: "ja", options: [{ value: "ja", label: "Teilen" }, { value: "nein", label: "Abbrechen" }] }, c.signal);
      if (value !== "ja") return { ...userDeclined(), geteilt: false };
      try {
        const w = await svc().shareToOrg(def.id);
        return { geteilt: true, orgWorkflowId: w.id };
      } catch (err) {
        return { error: err instanceof Error ? err.message : String(err) };
      }
    },
  });

  const orgList = defineTool({
    name: "workflow_org_list",
    summary: "Von der Organisation geteilte Workflows auflisten (zum Uebernehmen).",
    category: "workflow workflows organisation geteilt vorlagen",
    description: "Listet Workflows, die Mitglieder der Organisation geteilt haben (Name, Beschreibung, Schritte, von wem). Uebernehmen mit workflow_adopt.",
    parameters: { type: "object", properties: {} },
    schema: yup.object({}).noUnknown(true),
    preview: (r: Record<string, any>) => (r.error as string | undefined) ?? `${r.items?.length ?? 0} geteilte Workflows`,
    run: async () => {
      try {
        return { items: (await svc().listOrgWorkflows()).map((i) => ({ id: i.id, name: i.name, description: i.description, schritte: i.nodeCount, von: i.sharedByName ?? i.sharedBy, geteiltAm: i.updatedAt })) };
      } catch (err) {
        return { error: err instanceof Error ? err.message : String(err) };
      }
    },
  });

  const adopt = defineTool({
    name: "workflow_adopt",
    summary: "Einen geteilten Workflow der Organisation als eigene Kopie uebernehmen (Bestaetigung).",
    category: "workflow workflows organisation uebernehmen kopie",
    description: "Uebernimmt einen von der Organisation geteilten Workflow (id aus workflow_org_list) als eigene Kopie: Trigger manuell, Schreib-Schritte nicht freigegeben. Fragt vorher nach.",
    parameters: { type: "object", required: ["orgWorkflowId"], properties: { orgWorkflowId: { type: "string" } } },
    schema: yup.object({ orgWorkflowId: yup.string().trim().min(1).required() }).noUnknown(true),
    preview: (r: Record<string, any>) => (r.error as string | undefined) ?? (r.workflow ? `Workflow „${r.workflow.name}“ uebernommen` : "abgebrochen"),
    run: async (args, c) => {
      const value = await c.ui.confirmAction({ kind: "additive", prompt: `Geteilten Workflow ${args.orgWorkflowId} als eigene Kopie uebernehmen?`, confirmValue: "ja", options: [{ value: "ja", label: "Uebernehmen" }, { value: "nein", label: "Abbrechen" }] }, c.signal);
      if (value !== "ja") return { ...userDeclined() };
      try {
        const r = await svc().adoptFromOrg(args.orgWorkflowId);
        return { workflow: kompakt(r.workflow), problems: r.problems };
      } catch (err) {
        return { error: err instanceof Error ? err.message : String(err) };
      }
    },
  });

  return [list, get, catalog, save, update, run, del, approvals, approve, fromConversation, share, orgList, adopt];
}

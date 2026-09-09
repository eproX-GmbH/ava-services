// W1 (docs/PLAN_WORKFLOWS.md) — Workflows: gespeicherte, deterministische
// Tool-Ketten mit Parametern. Datenmodell nach n8n (Nodes + Kanten je
// Ausgangs-Index, Items-Strom `{ json }`, Expressions), geteilt zwischen
// Main, Preload, Renderer und Chat-Tools.

export type WorkflowNodeType =
  | "trigger"
  | "tool"
  | "filter"
  | "transform"
  | "if"
  | "switch"
  | "loop"
  | "merge"
  | "ai"
  | "wait"
  | "human"
  | "stop"
  | "subworkflow"
  | "note";

export type WorkflowOnError = "stop" | "continue" | "errorOutput";

export interface WorkflowNode {
  id: string;
  /** Eindeutig im Workflow — Expressions verweisen per `$('Name')`. */
  name: string;
  type: WorkflowNodeType;
  position: [number, number];
  /** Je type; bei "tool": { tool: "discovery_scan", args: { ... } }. Werte
   *  koennen Expressions sein ("={{ ... }}" oder "{{ ... }}" im String). */
  parameters: Record<string, unknown>;
  /** perItem = Node laeuft je Eingabe-Item (Default); allItems = einmal. */
  mode?: "perItem" | "allItems";
  disabled?: boolean;
  onError?: WorkflowOnError;
  retryOnFail?: boolean;
  maxTries?: number;
  waitBetweenTriesSec?: number;
  /** Schreib-Node vom Nutzer fuer unbeaufsichtigte Laeufe freigegeben. */
  confirmed?: boolean;
  notes?: string;
  /** v0.1.603 — Daten-Abhaengigkeiten (Producer-Stufen) manuell ueberschreiben; sonst abgeleitet. */
  dependsOn?: string[];
}

export interface WorkflowConnectionTarget {
  node: string;
  index: number;
}

/** connections[nodeName].main[outputIndex] = Ziele. */
export type WorkflowConnections = Record<string, { main: WorkflowConnectionTarget[][] }>;

export interface WorkflowVariable {
  label: string;
  type: "string" | "number" | "boolean" | "list";
  value: unknown;
  description?: string;
}

export type WorkflowTrigger =
  | { kind: "manual" }
  | {
      kind: "schedule";
      /** Intervall in Minuten (>= 15) ODER feste Uhrzeit(en). */
      intervalMinutes?: number;
      /** "07:00" lokal; mit weekdays (0 = So … 6 = Sa). */
      at?: string;
      weekdays?: number[];
      /** Ein Lauf je Firma: feste Firmenliste (companyIds). Ohne Liste laeuft
       *  ein Zeitplan nur bei settings.scope === "none". */
      companyIds?: string[];
      /** Dynamische Firmenquelle (statt/zusaetzlich zu companyIds). */
      companySource?: WorkflowCompanySource;
    }
  | {
      kind: "event";
      event: WorkflowEventKind;
      filter?: Record<string, unknown>;
    }
  | { kind: "chat" };

/** Woher ein Zeitplan seine Firmen nimmt — je Firma ein Lauf. */
export type WorkflowCompanySource =
  | { kind: "list" }
  | { kind: "radarHot"; minScore?: number; nurNeue?: boolean }
  | { kind: "transaction"; transactionId: string }
  | { kind: "allCompanies"; limit?: number };

export type WorkflowEventKind = "radar.newHot" | "mail.inbound" | "alert.created" | "import.finished";

export interface WorkflowSettings {
  executionOrder: "v1";
  timeoutMinutes: number;
  maxItemsPerRun: number;
  /** Deckel je Workflow; inherit = globale Vollmacht. */
  autonomy: "inherit" | "none" | "additive" | "mutating";
  /** Tages-Obergrenze fuer mail_send je Workflow (Entscheidung 2026-09-09: Default 20). */
  maxMailsPerDay: number;
  notifyOnFinish: boolean;
  errorWorkflowId?: string;
  /** Grundgedanke 2026-09-09: ein Lauf = EINE Firma mit vollem Kontext (Default).
   *  "none" nur fuer Ablaeufe ohne Firmenbezug (z. B. Radar-Scan starten). */
  scope?: "company" | "none";
}

/** Firmenbezug eines Laufs. */
export interface WorkflowScope {
  companyId?: string;
  discoveryId?: string;
  companyName?: string;
}

export interface WorkflowDefinition {
  id: string;
  name: string;
  description: string;
  version: number;
  nodes: WorkflowNode[];
  connections: WorkflowConnections;
  variables: Record<string, WorkflowVariable>;
  trigger: WorkflowTrigger;
  settings: WorkflowSettings;
  origin: { kind: "chat" | "assistant" | "manual" | "import" | "org"; conversationId?: string };
  enabled: boolean;
  createdAt: string;
  updatedAt: string;
  createdBy: "user" | "agent";
  pinData?: Record<string, WorkflowItem[]>;
  /** W7 — von der Organisation geteilt (nur lesend uebernommen). */
  sharedFrom?: { orgWorkflowId: string; sharedBy: string } | null;
}

export interface WorkflowItem {
  json: Record<string, unknown>;
  pairedItem?: { item: number; input?: number };
}

export type WorkflowExecutionStatus =
  | "running"
  | "success"
  | "error"
  | "cancelled"
  | "waiting"
  | "paused";

/** Passives Warten auf einen Vorgang: Firmen werden weitergereicht, sobald ihre Stufen fertig sind. */
export interface WorkflowWaiting {
  /** Warten-Node, an dem der Lauf pausiert. */
  node: string;
  transactionId: string;
  stufen: string[];
  /** Firmen, die bereits an die Folge-Schritte weitergegeben wurden. */
  weitergegeben: string[];
  seit: string;
  /** Spaetestens dann geht es mit den fertigen Firmen weiter (Sicherheitsnetz). */
  bis: string;
  /** Zuletzt beobachtet: fertig / offen (nur Anzeige). */
  fertig?: number;
  offen?: number;
}

export interface WorkflowNodeRun {
  startedAt: string;
  finishedAt?: string;
  status: "success" | "error" | "skipped" | "running" | "paused";
  inputItems: number;
  /** Items je Ausgang. */
  outputItems: number[];
  /** Gekuerzt gespeicherte Ausgabe je Ausgang (max 200 Items, 64 KB je Item). */
  output?: WorkflowItem[][];
  error?: string;
  /** Tool-Node: Zahl der Tool-Aufrufe (perItem = Items). */
  toolCalls?: number;
  /** Hinweise (z. B. Platzhalter ohne Wert, uebersprungene Items). */
  hinweise?: string[];
  /** Befuellte semantische Platzhalter dieses Nodes. */
  platzhalter?: Record<string, unknown>;
}

export interface WorkflowExecution {
  id: string;
  workflowId: string;
  workflowName: string;
  workflowVersion: number;
  trigger: "manual" | "schedule" | "event" | "chat" | "test";
  /** Trockenlauf: Schreib-Nodes werden nur vorgeschaut. */
  dryRun: boolean;
  /** Firma dieses Laufs (Kontext liegt dem Lauf als Klartext vor). */
  scope?: WorkflowScope;
  /** Quellen, aus denen der Kontext kam (Tool-Namen). */
  contextQuellen?: string[];
  /** v0.1.610 — Lauf wartet passiv auf einen Vorgang (kein Timer, kein Prozess). */
  waiting?: WorkflowWaiting;
  status: WorkflowExecutionStatus;
  startedAt: string;
  finishedAt?: string;
  nodeRuns: Record<string, WorkflowNodeRun[]>;
  pausedAt?: { node: string; reason: "confirmation" | "wait" | "quota"; approvalId?: string };
  summary?: string;
  error?: string;
}

/** Human-in-the-Loop: offene Freigabe, die den Lauf anhaelt. */
export interface WorkflowApproval {
  id: string;
  executionId: string;
  workflowId: string;
  workflowName: string;
  nodeName: string;
  /** Was passiert bei Freigabe (Klartext, z. B. "12 Mails an … senden"). */
  prompt: string;
  /** Vorschau der Items, um die es geht (gekuerzt). */
  items: WorkflowItem[];
  createdAt: string;
  status: "open" | "approved" | "rejected" | "expired";
  decidedAt?: string;
  /** Freitext des Nutzers bei Ablehnung/Freigabe. */
  note?: string;
}

/** Katalog-Eintrag fuer die Ansicht und den Agenten. */
export interface WorkflowCatalogEntry {
  /** Node-Typ: "tool:<name>" oder ein Logik-Node. */
  type: string;
  label: string;
  category: string;
  summary: string;
  /** JSON-Schema der Parameter (Tool: Schema des Tools). */
  parameters: Record<string, unknown>;
  write: boolean;
  /** Wirkungsklasse fuer die Vollmacht. */
  actionKind: "read" | "additive" | "mutating" | "destructive";
  /** Pfad im Tool-Ergebnis, der zu Items wird (z. B. "items"). */
  outputPath?: string;
  /** Kostenklasse fuer die Schaetzung vor dem Lauf. */
  costClass: "frei" | "kontingent" | "ki" | "extern";
}

export interface WorkflowListEntry {
  id: string;
  name: string;
  description: string;
  version: number;
  enabled: boolean;
  trigger: WorkflowTrigger;
  nodeCount: number;
  lastRun?: { id: string; status: WorkflowExecutionStatus; startedAt: string; summary?: string } | null;
  nextRunAt?: string | null;
  openApprovals: number;
  /** Nicht ausfuehrbar (z. B. Node zu abgeschalteter Funktion) — Grund. */
  blocked?: string | null;
}

/** W7 — mit der Organisation geteilter Workflow (Gateway). */
export interface OrgWorkflowRow {
  id: string;
  sourceId: string;
  name: string;
  description: string;
  version: number;
  sharedBy: string;
  sharedByName: string | null;
  sharedAt: string;
  updatedAt: string;
  nodeCount: number;
  definition?: Record<string, unknown>;
}

/** Fortschritts-Frame Main → Renderer. */
export type WorkflowProgressFrame =
  | { kind: "execution-started"; execution: WorkflowExecution }
  | { kind: "node-started"; executionId: string; workflowId: string; node: string }
  | { kind: "node-finished"; executionId: string; workflowId: string; node: string; run: WorkflowNodeRun }
  | { kind: "execution-finished"; execution: WorkflowExecution }
  | { kind: "approval-open"; approval: WorkflowApproval }
  | { kind: "approvals-changed" };

/** Plan-Staffelung (Entscheidung 2026-09-09): Free max. 1 Workflow, sonst unbegrenzt. */
export const WORKFLOW_LIMITS: Record<string, { maxWorkflows: number | null }> = {
  free: { maxWorkflows: 1 },
  starter: { maxWorkflows: null },
  pro: { maxWorkflows: null },
  enterprise: { maxWorkflows: null },
};

export const DEFAULT_WORKFLOW_SETTINGS: WorkflowSettings = {
  executionOrder: "v1",
  timeoutMinutes: 60,
  maxItemsPerRun: 500,
  autonomy: "inherit",
  maxMailsPerDay: 20,
  notifyOnFinish: true,
  scope: "company",
};

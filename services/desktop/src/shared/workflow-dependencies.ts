// v0.1.603 — Daten-Abhaengigkeiten je Node (docs/PLAN_WORKFLOWS.md §11).
// Elektron-frei; wird von Main (Runner, Validierung) und Renderer (Chips)
// genutzt. Abhaengigkeiten werden aus den Nodes ABGELEITET: Welche Producer-
// Stufe liefert die Daten, die ein Platzhalter oder eine $company-Expression
// braucht? Manuelles Ueberschreiben per `dependsOn` am Node.

import type { WorkflowDefinition, WorkflowNode } from "./workflow-types";

export const PIPELINE_STAGES = ["masterData", "structuredContent", "companyPublication", "website", "companyProfile", "companyContact", "companyEvaluation"] as const;
export type PipelineStage = (typeof PIPELINE_STAGES)[number];

export const STAGE_LABELS: Record<PipelineStage, string> = {
  masterData: "Stammdaten",
  structuredContent: "Handelsregister",
  companyPublication: "Jahresabschluesse",
  website: "Website",
  companyProfile: "Firmenprofil",
  companyContact: "Kontakte",
  companyEvaluation: "Bewertung",
};

/** Massgebliche Stufe: ohne sie ist eine Firma nicht „verarbeitet“. */
export const KEY_STAGE: PipelineStage = "companyProfile";

export function isPipelineStage(v: unknown): v is PipelineStage {
  return typeof v === "string" && (PIPELINE_STAGES as readonly string[]).includes(v);
}

/** Kontext-Sektion ($company.<key>) → Stufe. */
const SECTION_STAGE: Record<string, PipelineStage | null> = {
  stammdaten: "masterData",
  profil: "companyProfile",
  schlagworte: "companyProfile",
  kontakte: "companyContact",
  finanzen: "companyPublication",
  register: "structuredContent",
  crm: null,
  radar: null,
};

/** Wortlisten fuer semantische Platzhalter ($kassenbestand → Jahresabschluesse). */
const KEYWORDS: Array<{ stage: PipelineStage; re: RegExp }> = [
  { stage: "companyPublication", re: /(kasse|kassen|umsatz|umsaetze|umsätze|erloes|erlös|bilanz|eigenkapital|fremdkapital|gewinn|verlust|jahresueberschuss|jahresüberschuss|ebit|ebitda|ergebnis|liquid|cashflow|cash|schulden|verbindlichkeit|forderung|anlageverm|umlaufverm|rueckstellung|rückstellung|abschreibung|kennzahl|finanz|jahresabschluss|lagebericht|mitarbeiterzahl|beschaeftigte|beschäftigte|personalaufwand)/i },
  { stage: "structuredContent", re: /(geschaeftsfuehr|geschäftsführ|gesellschafter|prokur|vorstand|inhaber|stammkapital|grundkapital|rechtsform|gruendung|gründung|handelsregister|registergericht|hrb|hra|unternehmensgegenstand|gegenstand|sitz$|satzung)/i },
  { stage: "companyContact", re: /(ansprechpartner|kontakt|e-?mail|mail|telefon|tel$|durchwahl|linkedin|xing|vertriebsleit|einkaufsleit|leiter|leiterin|entscheider|position|rolle)/i },
  { stage: "website", re: /(website|webseite|homepage|impressum|produkt|dienstleistung|leistung|referenz|karriere|stellen)/i },
  { stage: "companyEvaluation", re: /(bewertung|score|icp|signal|einschaetzung|einschätzung|fit)/i },
];

const PH_RE = /\$([A-Za-zÄÖÜäöüß_][\wÄÖÜäöüß]*)(?!\s*\()/g;
const COMPANY_PATH_RE = /\$(?:company|firma)\s*\.\s*([A-Za-z_]\w*)/g;
const RESERVED = new Set(["json", "input", "vars", "company", "firma", "context", "kontext", "now", "today", "run", "itemIndex"]);

export function stagesForPlaceholder(name: string): PipelineStage[] {
  for (const k of KEYWORDS) if (k.re.test(name)) return [k.stage];
  return [KEY_STAGE];
}

function scanStrings(value: unknown, fn: (s: string) => void): void {
  if (typeof value === "string") fn(value);
  else if (Array.isArray(value)) value.forEach((v) => scanStrings(v, fn));
  else if (value && typeof value === "object") Object.values(value as Record<string, unknown>).forEach((v) => scanStrings(v, fn));
}

export interface NodeRequirement {
  stage: PipelineStage;
  /** Woher die Anforderung stammt (Platzhalter/Expression/dependsOn). */
  grund: string;
}

/** Abgeleitete Anforderungen eines einzelnen Nodes (ohne Sub-Workflow-Vererbung). */
export function nodeRequirements(node: WorkflowNode): NodeRequirement[] {
  const out = new Map<PipelineStage, string>();
  if (node.type === "trigger" || node.type === "note" || node.disabled) return [];
  if (Array.isArray(node.dependsOn)) {
    for (const d of node.dependsOn) if (isPipelineStage(d) && !out.has(d)) out.set(d, "festgelegt");
  }
  scanStrings(node.parameters, (s) => {
    for (const m of s.matchAll(COMPANY_PATH_RE)) {
      const stage = SECTION_STAGE[m[1]!];
      if (stage && !out.has(stage)) out.set(stage, `$company.${m[1]}`);
    }
    // Platzhalter: nur ausserhalb von {{ }} relevant sind sie nicht — beide Formen zaehlen.
    for (const m of s.matchAll(PH_RE)) {
      const name = m[1]!;
      if (RESERVED.has(name)) continue;
      for (const stage of stagesForPlaceholder(name)) if (!out.has(stage)) out.set(stage, `$${name}`);
    }
  });
  return [...out.entries()].map(([stage, grund]) => ({ stage, grund }));
}

/** Anforderungen eines ganzen Workflows (inkl. Sub-Workflows, rekursiv). */
export function workflowRequirements(def: WorkflowDefinition, getDefinition: (id: string) => WorkflowDefinition | null | undefined, depth = 0): NodeRequirement[] {
  const out = new Map<PipelineStage, string>();
  for (const n of def.nodes) {
    for (const r of nodeRequirementsMitSub(n, getDefinition, depth)) if (!out.has(r.stage)) out.set(r.stage, r.grund);
  }
  return [...out.entries()].map(([stage, grund]) => ({ stage, grund }));
}

export function nodeRequirementsMitSub(node: WorkflowNode, getDefinition: (id: string) => WorkflowDefinition | null | undefined, depth = 0): NodeRequirement[] {
  const eigene = nodeRequirements(node);
  if (node.type !== "subworkflow" || depth > 5) return eigene;
  const sub = getDefinition(String(node.parameters.workflowId ?? ""));
  if (!sub) return eigene;
  const out = new Map<PipelineStage, string>(eigene.map((r) => [r.stage, r.grund]));
  for (const r of workflowRequirements(sub, getDefinition, depth + 1)) if (!out.has(r.stage)) out.set(r.stage, `Sub-Workflow „${sub.name}“: ${r.grund}`);
  return [...out.entries()].map(([stage, grund]) => ({ stage, grund }));
}

/** Alle Nodes, die von `nodeName` aus erreichbar sind (ueber Kanten). */
export function downstreamNodes(def: WorkflowDefinition, nodeName: string): WorkflowNode[] {
  const byName = new Map(def.nodes.map((n) => [n.name, n]));
  const seen = new Set<string>();
  const stack = (def.connections[nodeName]?.main ?? []).flat().map((t) => t.node);
  while (stack.length > 0) {
    const n = stack.pop()!;
    if (seen.has(n) || n === nodeName) continue;
    seen.add(n);
    for (const t of (def.connections[n]?.main ?? []).flat()) stack.push(t.node);
  }
  return [...seen].map((n) => byName.get(n)).filter((n): n is WorkflowNode => !!n);
}

/** Anforderungen aller nachfolgenden Nodes eines Warten-Nodes. */
export function downstreamRequirements(def: WorkflowDefinition, nodeName: string, getDefinition: (id: string) => WorkflowDefinition | null | undefined): NodeRequirement[] {
  const out = new Map<PipelineStage, string>();
  for (const n of downstreamNodes(def, nodeName)) {
    for (const r of nodeRequirementsMitSub(n, getDefinition)) if (!out.has(r.stage)) out.set(r.stage, `„${n.name}“: ${r.grund}`);
  }
  return [...out.entries()].map(([stage, grund]) => ({ stage, grund }));
}

/**
 * Stufen, auf die ein Warten-Node wartet: `parameters.bis` (explizit) oder
 * automatisch = Anforderungen der nachfolgenden Nodes, mindestens Firmenprofil.
 */
export function waitStages(def: WorkflowDefinition, node: WorkflowNode, getDefinition: (id: string) => WorkflowDefinition | null | undefined): { stufen: PipelineStage[]; automatisch: boolean; gruende: NodeRequirement[] } {
  const bis = Array.isArray(node.parameters.bis) ? node.parameters.bis.filter(isPipelineStage) : [];
  const gruende = downstreamRequirements(def, node.name, getDefinition);
  if (bis.length > 0) return { stufen: [...new Set(bis)], automatisch: false, gruende };
  const stufen = new Set<PipelineStage>([KEY_STAGE, ...gruende.map((g) => g.stage)]);
  return { stufen: [...stufen], automatisch: true, gruende };
}

/** Validierungs-Hinweise: Warten-Node wartet auf weniger, als nachfolgende Nodes brauchen. */
export function dependencyProblems(def: WorkflowDefinition, getDefinition: (id: string) => WorkflowDefinition | null | undefined): Array<{ node: string; message: string }> {
  const out: Array<{ node: string; message: string }> = [];
  for (const n of def.nodes) {
    if (n.type !== "wait" || typeof n.parameters.transactionId !== "string") continue;
    const w = waitStages(def, n, getDefinition);
    if (w.automatisch) continue;
    const fehlt = w.gruende.filter((g) => !w.stufen.includes(g.stage));
    if (fehlt.length > 0) {
      out.push({ node: n.name, message: `Warten-Node wartet nur auf ${w.stufen.map((s) => STAGE_LABELS[s]).join(", ")}, nachfolgende Schritte brauchen aber ${fehlt.map((f) => `${STAGE_LABELS[f.stage]} (${f.grund})`).join(", ")}. Leeres „bis“ = automatisch.` });
    }
  }
  return out;
}

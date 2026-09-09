// W3 — Workflow-Editor (React Flow): Canvas mit Nodes/Kanten, Node-Panel
// (Parameter, Modus, Freigabe, Fehlerverhalten), Trigger, Läufe mit
// Node-Färbung. Zum Bauen ist der Chat gedacht; hier: Kontrolle und
// kleine Korrekturen. Positionen ohne Wert werden per dagre gelegt.

import { useCallback, useEffect, useMemo, useState } from "react";
import { Link, useNavigate, useParams, useSearchParams } from "react-router-dom";
import { dauerText, firmaText } from "./WorkflowRuns";
import {
  Background,
  Controls,
  Handle,
  MiniMap,
  Position,
  ReactFlow,
  addEdge,
  applyEdgeChanges,
  applyNodeChanges,
  type Connection,
  type Edge,
  type EdgeChange,
  type Node,
  type NodeChange,
  type NodeProps,
} from "@xyflow/react";
import "@xyflow/react/dist/style.css";
import dagre from "dagre";
import type {
  WorkflowItem,
  WorkflowCatalogEntry,
  WorkflowDefinition,
  WorkflowExecution,
  WorkflowNode,
  WorkflowNodeRun,
  WorkflowProgressFrame,
  WorkflowTrigger,
} from "../../../shared/workflow-types";
import { FirmenAuswahl, statusPill, triggerText } from "./Workflows";
import { PIPELINE_STAGES, STAGE_LABELS, nodeRequirementsMitSub, waitStages, type PipelineStage } from "../../../shared/workflow-dependencies";

type WfNodeData = {
  wf: WorkflowNode;
  run?: WorkflowNodeRun;
  write: boolean;
  label: string;
};
type WfFlowNode = Node<WfNodeData, "wf">;

const OUTPUTS: Record<string, string[]> = { if: ["wahr", "falsch"], loop: ["loop", "done"] };

function outputsOf(n: WorkflowNode): string[] {
  if (n.type === "switch") {
    const cases = (n.parameters.cases as Array<{ label?: string; match?: string }> | undefined) ?? [];
    return [...cases.map((c, i) => c.label ?? c.match ?? `Fall ${i + 1}`), "sonst"];
  }
  if (n.type === "note" || n.type === "stop") return [];
  return OUTPUTS[n.type] ?? [""];
}

function WfNode({ data, selected }: NodeProps<WfFlowNode>): JSX.Element {
  const n = data.wf;
  const outs = outputsOf(n);
  const status = data.run?.status;
  const cls = ["wf-node", `wf-node--${n.type}`, selected ? "wf-node--selected" : "", n.disabled ? "wf-node--aus" : "", status ? `wf-node--${status}` : ""].filter(Boolean).join(" ");
  const subtitle = n.type === "tool" ? String(n.parameters.tool ?? "") : n.type === "trigger" ? "Start" : n.type;
  return (
    <div className={cls}>
      {n.type !== "trigger" && <Handle type="target" position={Position.Left} id="in" />}
      <div className="wf-node__title">{n.name}</div>
      <div className="wf-node__sub">{subtitle}</div>
      <div className="wf-node__badges">
        {data.write && <span className={`wf-badge ${n.confirmed ? "wf-badge--ok" : "wf-badge--warn"}`}>{n.confirmed ? "freigegeben" : "Schreib-Schritt"}</span>}
        {n.type === "ai" && <span className="wf-badge">KI</span>}
        {nodeRequirementsMitSub(n, () => null).slice(0, 3).map((r) => (
          <span key={r.stage} className="wf-badge" title={`Braucht ${STAGE_LABELS[r.stage]}: ${r.grund}`}>
            ↳ {STAGE_LABELS[r.stage]}
          </span>
        ))}
        {n.type === "human" && <span className="wf-badge">Freigabe</span>}
        {n.mode === "allItems" && <span className="wf-badge">alle Items</span>}
        {data.run && <span className="wf-badge wf-badge--items">{data.run.outputItems.reduce((a, b) => a + b, 0)} Items</span>}
        {data.run?.error && <span className="wf-badge wf-badge--err" title={data.run.error}>Fehler</span>}
      </div>
      {outs.map((label, i) => (
        <Handle key={i} type="source" position={Position.Right} id={String(i)} style={{ top: outs.length === 1 ? "50%" : `${((i + 1) / (outs.length + 1)) * 100}%` }}>
          {label && <span className="wf-handle-label">{label}</span>}
        </Handle>
      ))}
    </div>
  );
}

const nodeTypes = { wf: WfNode };

function layout(def: WorkflowDefinition): Map<string, [number, number]> {
  const g = new dagre.graphlib.Graph();
  g.setGraph({ rankdir: "LR", nodesep: 40, ranksep: 90 });
  g.setDefaultEdgeLabel(() => ({}));
  for (const n of def.nodes) g.setNode(n.name, { width: 220, height: 90 });
  for (const [from, c] of Object.entries(def.connections)) for (const targets of c.main ?? []) for (const t of targets ?? []) if (def.nodes.some((n) => n.name === t.node)) g.setEdge(from, t.node);
  dagre.layout(g);
  const pos = new Map<string, [number, number]>();
  for (const n of def.nodes) {
    const p = g.node(n.name);
    if (p) pos.set(n.name, [Math.round(p.x - 110), Math.round(p.y - 45)]);
  }
  return pos;
}

function toFlow(def: WorkflowDefinition, catalog: WorkflowCatalogEntry[], ex: WorkflowExecution | null): { nodes: WfFlowNode[]; edges: Edge[] } {
  const needsLayout = def.nodes.some((n, i) => n.position[0] === 80 + i * 260 && n.position[1] === 120) || def.nodes.every((n) => n.position[0] === 0 && n.position[1] === 0);
  const pos = needsLayout ? layout(def) : null;
  const byType = new Map(catalog.map((c) => [c.type, c]));
  const nodes: WfFlowNode[] = def.nodes.map((n) => {
    const entry = n.type === "tool" ? byType.get(`tool:${String(n.parameters.tool)}`) : byType.get(n.type);
    return {
      id: n.name,
      type: "wf",
      position: pos ? { x: pos.get(n.name)?.[0] ?? n.position[0], y: pos.get(n.name)?.[1] ?? n.position[1] } : { x: n.position[0], y: n.position[1] },
      data: { wf: n, run: ex?.nodeRuns[n.name]?.at(-1), write: entry?.write ?? false, label: entry?.label ?? n.type },
    };
  });
  const edges: Edge[] = [];
  for (const [from, c] of Object.entries(def.connections)) {
    (c.main ?? []).forEach((targets, outIdx) => {
      for (const t of targets ?? []) {
        const fromNode = def.nodes.find((n) => n.name === from);
        const label = fromNode ? outputsOf(fromNode)[outIdx] : "";
        const run = ex?.nodeRuns[from]?.at(-1);
        const count = run?.outputItems[outIdx];
        edges.push({
          id: `${from}:${outIdx}→${t.node}:${t.index}`,
          source: from,
          sourceHandle: String(outIdx),
          target: t.node,
          targetHandle: "in",
          label: [label, count !== undefined ? `${count} Items` : ""].filter(Boolean).join(" · ") || undefined,
          animated: run?.status === "running",
        });
      }
    });
  }
  return { nodes, edges };
}

function fromFlow(def: WorkflowDefinition, nodes: WfFlowNode[], edges: Edge[]): WorkflowDefinition {
  const connections: WorkflowDefinition["connections"] = {};
  for (const e of edges) {
    const outIdx = Number(e.sourceHandle ?? 0);
    const c = (connections[e.source] ??= { main: [] });
    while (c.main.length <= outIdx) c.main.push([]);
    c.main[outIdx]!.push({ node: e.target, index: 0 });
  }
  return {
    ...def,
    nodes: nodes.map((n) => ({ ...n.data.wf, name: n.id, position: [Math.round(n.position.x), Math.round(n.position.y)] as [number, number] })),
    connections,
  };
}

type JsonSchema = {
  type?: string;
  description?: string;
  enum?: unknown[];
  properties?: Record<string, JsonSchema>;
  required?: string[];
  items?: JsonSchema;
  default?: unknown;
  minimum?: number;
  maximum?: number;
};

/**
 * W3 — Parameter-Formular aus dem JSON-Schema des Tools/Node-Typs. Jedes
 * Feld nimmt feste Werte ODER Expressions ({{ … }}) ODER semantische
 * Platzhalter ($kassenbestand ?? "…") an; die Vorschlagsliste kommt aus
 * den Ausgaben der Vorgaenger-Schritte im gezeigten Lauf.
 */
function ParamForm({
  schema,
  value,
  onChange,
  vorschlaege,
  listId,
}: {
  schema: JsonSchema;
  value: Record<string, unknown>;
  onChange: (next: Record<string, unknown>) => void;
  vorschlaege: string[];
  listId: string;
}): JSX.Element {
  const props = schema.properties ?? {};
  const required = new Set(schema.required ?? []);
  const setField = (k: string, v: unknown): void => {
    const next = { ...value };
    if (v === undefined || v === "") delete next[k];
    else next[k] = v;
    onChange(next);
  };
  const asText = (v: unknown): string => (v === undefined || v === null ? "" : typeof v === "string" ? v : JSON.stringify(v));
  const parseLoose = (s: string, sch: JsonSchema): unknown => {
    const t = s.trim();
    if (t === "") return undefined;
    if (/\{\{|\$[A-Za-zÄÖÜäöüß_]/.test(t)) return t; // Expression/Platzhalter bleibt Text
    if (sch.type === "number" || sch.type === "integer") return Number.isFinite(Number(t)) ? Number(t) : t;
    if (sch.type === "boolean") return t === "true" ? true : t === "false" ? false : t;
    if (sch.type === "array" || sch.type === "object") {
      try {
        return JSON.parse(t);
      } catch {
        return sch.type === "array" ? t.split(",").map((x) => x.trim()).filter(Boolean) : t;
      }
    }
    return t;
  };
  const keys = Object.keys(props);
  if (keys.length === 0) return <p className="muted small">Keine Parameter.</p>;
  return (
    <div className="wf-form">
      {keys.map((k) => {
        const sch = props[k] ?? {};
        const v = value[k];
        const istExpr = typeof v === "string" && /\{\{|\$[A-Za-zÄÖÜäöüß_]/.test(v);
        const label = `${k}${required.has(k) ? " *" : ""}`;
        return (
          <label key={k} className="field wf-form__field">
            <span>
              {label}
              {sch.type && <span className="muted"> · {sch.type}{sch.type === "array" && sch.items?.type ? ` von ${sch.items.type}` : ""}</span>}
              {istExpr && <span className="wf-badge wf-badge--items">Expression</span>}
            </span>
            {sch.enum && !istExpr ? (
              <select value={asText(v)} onChange={(e) => setField(k, e.target.value)}>
                <option value="">–</option>
                {sch.enum.map((o) => (
                  <option key={String(o)} value={String(o)}>
                    {String(o)}
                  </option>
                ))}
              </select>
            ) : sch.type === "boolean" && !istExpr ? (
              <select value={v === undefined ? "" : String(v)} onChange={(e) => setField(k, e.target.value === "" ? undefined : e.target.value === "true")}>
                <option value="">–</option>
                <option value="true">ja</option>
                <option value="false">nein</option>
              </select>
            ) : sch.type === "object" || (sch.type === "array" && sch.items?.type === "object") || (typeof v === "string" && v.length > 80) ? (
              <textarea rows={4} className="wf-params" value={asText(v)} onChange={(e) => setField(k, parseLoose(e.target.value, sch))} spellCheck={false} />
            ) : (
              <input value={asText(v)} list={listId} placeholder={sch.type === "array" ? "a, b, c oder {{ … }}" : "Wert, {{ Expression }} oder $platzhalter ?? \"Fallback\""} onChange={(e) => setField(k, parseLoose(e.target.value, sch))} />
            )}
            {sch.description && <span className="muted small">{sch.description}</span>}
          </label>
        );
      })}
      <datalist id={listId}>
        {vorschlaege.map((s) => (
          <option key={s} value={s} />
        ))}
      </datalist>
    </div>
  );
}

/** Vorschlaege fuer Expressions aus den Ausgaben der Vorgaenger im gezeigten Lauf. */
function expressionVorschlaege(def: WorkflowDefinition, nodeName: string, ex: WorkflowExecution | null): string[] {
  const out = new Set<string>(["{{ $json.name }}", "{{ $company.name }}", "{{ $vars.name }}", '$platzhalter ?? "Fallback"', "{{ $input.count }}", "{{ $now }}"]);
  // Vorgaenger: alle Nodes, von denen eine Kante zu nodeName fuehrt (transitiv, max 50).
  const vorgaenger = new Set<string>();
  const stack = [nodeName];
  while (stack.length > 0 && vorgaenger.size < 50) {
    const cur = stack.pop()!;
    for (const [from, c] of Object.entries(def.connections)) {
      if ((c.main ?? []).some((targets) => (targets ?? []).some((t) => t.node === cur)) && !vorgaenger.has(from)) {
        vorgaenger.add(from);
        stack.push(from);
      }
    }
  }
  for (const v of vorgaenger) {
    const first = ex?.nodeRuns[v]?.at(-1)?.output?.[0]?.[0]?.json;
    if (!first) continue;
    for (const k of Object.keys(first).slice(0, 25)) {
      out.add(`{{ $('${v}').item.json.${k} }}`);
      out.add(`{{ $json.${k} }}`);
    }
  }
  return [...out];
}

// ---- v0.1.612 — Lauf-Detail je Node: Eingabe | Ausgabe | Details ------------

function zelle(v: unknown): string {
  if (v == null) return "";
  if (typeof v === "string") return v.length > 80 ? `${v.slice(0, 80)}…` : v;
  if (typeof v === "number" || typeof v === "boolean") return String(v);
  try {
    const j = JSON.stringify(v);
    return j.length > 80 ? `${j.slice(0, 80)}…` : j;
  } catch {
    return String(v);
  }
}

function ItemsTable({ items, leerText }: { items: WorkflowItem[]; leerText: string }): JSX.Element {
  const [json, setJson] = useState(false);
  const [alle, setAlle] = useState(false);
  const gezeigt = alle ? items : items.slice(0, 25);
  const spalten = useMemo(() => {
    const keys: string[] = [];
    for (const it of items.slice(0, 50)) for (const k of Object.keys(it.json ?? {})) if (!keys.includes(k)) keys.push(k);
    return keys.slice(0, 14);
  }, [items]);
  if (items.length === 0) return <p className="muted small">{leerText}</p>;
  return (
    <div className="wf-items">
      <div className="wf-items__bar">
        <span className="muted small">{items.length} Items{spalten.length === 14 ? " · erste 14 Spalten" : ""}</span>
        <button type="button" className="link" onClick={() => setJson((v) => !v)}>
          {json ? "Tabelle" : "JSON"}
        </button>
        {items.length > 25 && (
          <button type="button" className="link" onClick={() => setAlle((v) => !v)}>
            {alle ? "nur 25" : `alle ${items.length}`}
          </button>
        )}
      </div>
      {json ? (
        <pre className="wf-pre">{JSON.stringify(gezeigt.map((i) => i.json), null, 1)}</pre>
      ) : (
        <div className="wf-items__wrap">
          <table className="radar-table wf-items__table">
            <thead>
              <tr>
                <th>#</th>
                {spalten.map((k) => (
                  <th key={k}>{k}</th>
                ))}
              </tr>
            </thead>
            <tbody>
              {gezeigt.map((it, i) => (
                <tr key={i}>
                  <td className="muted">{i + 1}</td>
                  {spalten.map((k) => (
                    <td key={k} title={zelle((it.json ?? {})[k])}>
                      {zelle((it.json ?? {})[k])}
                    </td>
                  ))}
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}

function RunDetail({ def, execution, nodeName }: { def: WorkflowDefinition; execution: WorkflowExecution; nodeName: string }): JSX.Element | null {
  const runs = execution.nodeRuns[nodeName] ?? [];
  const [durchgang, setDurchgang] = useState(runs.length - 1);
  const [tab, setTab] = useState<"eingabe" | "ausgabe" | "details">("ausgabe");
  const idx = Math.min(Math.max(0, durchgang), runs.length - 1);
  const run = runs[idx];
  if (!run) return null;
  // Eingabe = Ausgaben der Vorgaenger auf den Kanten zu diesem Node (gleicher Durchgang, sonst letzter).
  const eingabe: WorkflowItem[] = [];
  for (const [from, conn] of Object.entries(def.connections)) {
    (conn?.main ?? []).forEach((targets, outIdx) => {
      if (!(targets ?? []).some((t) => t.node === nodeName)) return;
      const fr = execution.nodeRuns[from];
      const r = fr?.[Math.min(idx, (fr?.length ?? 1) - 1)] ?? fr?.at(-1);
      for (const it of r?.output?.[outIdx] ?? []) eingabe.push(it);
    });
  }
  const ausgabe = (run.output ?? []).flat();
  const dauer = run.finishedAt ? Math.max(0, Date.parse(run.finishedAt) - Date.parse(run.startedAt)) : null;
  return (
    <div className="wf-rundetail">
      {runs.length > 1 && (
        <label className="field">
          <span>Durchgang</span>
          <select value={idx} onChange={(e) => setDurchgang(Number(e.target.value))}>
            {runs.map((r, i) => (
              <option key={i} value={i}>
                {i + 1} von {runs.length} · {new Date(r.startedAt).toLocaleTimeString("de-DE", { timeStyle: "short" })} · {r.status} · {r.outputItems.reduce((a, b) => a + b, 0)} Items
              </option>
            ))}
          </select>
        </label>
      )}
      <div className="wf-panel__tabs">
        <button type="button" className={`proc-toggle${tab === "eingabe" ? " wf-tab--active" : ""}`} onClick={() => setTab("eingabe")}>
          Eingabe ({eingabe.length})
        </button>
        <button type="button" className={`proc-toggle${tab === "ausgabe" ? " wf-tab--active" : ""}`} onClick={() => setTab("ausgabe")}>
          Ausgabe ({ausgabe.length})
        </button>
        <button type="button" className={`proc-toggle${tab === "details" ? " wf-tab--active" : ""}`} onClick={() => setTab("details")}>
          Details
        </button>
      </div>
      {tab === "eingabe" && <ItemsTable items={eingabe} leerText="Keine Eingabe-Items (Start-Node oder Vorgänger ohne Ausgabe)." />}
      {tab === "ausgabe" && <ItemsTable items={ausgabe} leerText={run.status === "error" ? "Keine Ausgabe — Schritt ist fehlgeschlagen." : "Keine Ausgabe-Items."} />}
      {tab === "details" && (
        <div className="wf-rundetail__facts">
          <div>
            <span className="muted">Status</span> {statusPill(run.status)}
          </div>
          <div>
            <span className="muted">Start</span> {new Date(run.startedAt).toLocaleString("de-DE", { dateStyle: "short", timeStyle: "medium" })}
          </div>
          {dauer != null && (
            <div>
              <span className="muted">Dauer</span> {dauer < 1000 ? `${dauer} ms` : dauer < 60_000 ? `${(dauer / 1000).toFixed(1)} s` : `${Math.round(dauer / 60_000)} min`}
            </div>
          )}
          <div>
            <span className="muted">Items</span> {run.inputItems} rein → {run.outputItems.join(" / ")} raus{run.outputItems.length > 1 ? " (je Ausgang)" : ""}
          </div>
          {run.toolCalls != null && (
            <div>
              <span className="muted">Tool-Aufrufe</span> {run.toolCalls}
            </div>
          )}
          {run.error && <div className="warn">{run.error}</div>}
          {(run.hinweise ?? []).map((h, i) => (
            <div key={i} className="muted small">
              {h}
            </div>
          ))}
          {run.platzhalter && (
            <details className="settings-collapse" open>
              <summary>Befüllte Platzhalter</summary>
              <pre className="wf-pre">{JSON.stringify(run.platzhalter, null, 1)}</pre>
            </details>
          )}
        </div>
      )}
    </div>
  );
}

export function WorkflowEditor(): JSX.Element {
  const { id = "" } = useParams();
  const [searchParams] = useSearchParams();
  const navigate = useNavigate();
  const [def, setDef] = useState<WorkflowDefinition | null>(null);
  const [catalog, setCatalog] = useState<WorkflowCatalogEntry[]>([]);
  const [nodes, setNodes] = useState<WfFlowNode[]>([]);
  const [edges, setEdges] = useState<Edge[]>([]);
  const [selected, setSelected] = useState<string | null>(null);
  const [executions, setExecutions] = useState<WorkflowExecution[]>([]);
  const [shownExecution, setShownExecution] = useState<WorkflowExecution | null>(null);
  // v0.1.603 — Sub-Workflows (fuer abgeleitete Daten-Abhaengigkeiten).
  const [subDefs, setSubDefs] = useState<Record<string, WorkflowDefinition>>({});
  useEffect(() => {
    if (!def) return;
    const ids = def.nodes.filter((n) => n.type === "subworkflow" && typeof n.parameters.workflowId === "string").map((n) => String(n.parameters.workflowId)).filter((id) => id && !subDefs[id]);
    if (ids.length === 0) return;
    void Promise.all(ids.map((id) => window.api.workflows.get(id).catch(() => null))).then((ds) => {
      setSubDefs((prev) => {
        const next = { ...prev };
        ds.forEach((d, i) => { if (d) next[ids[i]!] = d; });
        return next;
      });
    });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [def]);
  const getSubDef = (id: string): WorkflowDefinition | null => subDefs[id] ?? null;
  const [tab, setTab] = useState<"node" | "trigger" | "runs" | "add">("node");
  const [dirty, setDirty] = useState(false);
  const [notice, setNotice] = useState<string | null>(null);
  const [problems, setProblems] = useState<Array<{ node?: string; message: string }>>([]);
  const [paramText, setParamText] = useState("");
  const [paramError, setParamError] = useState<string | null>(null);
  const [addQuery, setAddQuery] = useState("");
  const [firmaFuer, setFirmaFuer] = useState<{ dryRun: boolean; untilNode?: string } | null>(null);
  const [kosten, setKosten] = useState<{ hinweis: string } | null>(null);
  // W8 — Undo/Redo: Schnappschuesse von Nodes+Kanten+Definition.
  const [history, setHistory] = useState<Array<{ nodes: WfFlowNode[]; edges: Edge[]; def: WorkflowDefinition }>>([]);
  const [future, setFuture] = useState<Array<{ nodes: WfFlowNode[]; edges: Edge[]; def: WorkflowDefinition }>>([]);
  const [andere, setAndere] = useState<Array<{ id: string; name: string }>>([]);

  const load = useCallback(async () => {
    const [d, c, ex] = await Promise.all([window.api.workflows.get(id), window.api.workflows.catalog(), window.api.workflows.executions(id, 30)]);
    if (!d) {
      setNotice("Workflow nicht gefunden.");
      return;
    }
    setDef(d);
    setCatalog(c);
    setExecutions(ex);
    void window.api.workflows.estimate(id).then(setKosten);
    void window.api.workflows.list().then((l) => setAndere(l.filter((w) => w.id !== id).map((w) => ({ id: w.id, name: w.name }))));
    // v0.1.612 — ?lauf=<id> aus der Historie: genau diesen Lauf zeigen.
    const gewuenscht = searchParams.get("lauf");
    let latest = ex[0] ?? null;
    if (gewuenscht) latest = ex.find((e) => e.id === gewuenscht) ?? (await window.api.workflows.execution(id, gewuenscht)) ?? latest;
    setShownExecution(latest);
    const f = toFlow(d, c, latest);
    setNodes(f.nodes);
    setEdges(f.edges);
    setDirty(false);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [id]);

  useEffect(() => {
    void load();
  }, [load]);

  useEffect(
    () =>
      window.api.workflows.onProgress((f: WorkflowProgressFrame) => {
        if ("workflowId" in f && f.workflowId !== id) return;
        if (f.kind === "execution-started" && f.execution.workflowId === id) setShownExecution(f.execution);
        if (f.kind === "node-finished" || f.kind === "node-started") {
          void window.api.workflows.execution(id, f.executionId).then((ex) => ex && setShownExecution(ex));
        }
        if (f.kind === "execution-finished" && f.execution.workflowId === id) {
          setShownExecution(f.execution);
          void window.api.workflows.executions(id, 30).then(setExecutions);
        }
      }),
    [id],
  );

  // Lauf-Ergebnisse an die Nodes haengen (ohne Positionen zu verlieren).
  useEffect(() => {
    setNodes((prev) => prev.map((n) => ({ ...n, data: { ...n.data, run: shownExecution?.nodeRuns[n.id]?.at(-1) } })));
    setEdges((prev) =>
      prev.map((e) => {
        const run = shownExecution?.nodeRuns[e.source]?.at(-1);
        const count = run?.outputItems[Number(e.sourceHandle ?? 0)];
        const base = String(e.label ?? "").split(" · ")[0] ?? "";
        const label = [base, count !== undefined ? `${count} Items` : ""].filter(Boolean).join(" · ");
        return { ...e, label: label || undefined, animated: run?.status === "running" };
      }),
    );
  }, [shownExecution]);

  const selectedNode = useMemo(() => nodes.find((n) => n.id === selected)?.data.wf ?? null, [nodes, selected]);
  // v0.1.616 — Name als lokaler Entwurf: Umbenennen erst beim Verlassen des
  // Felds. Vorher aenderte jeder Tastendruck den Namen im Node, waehrend die
  // Auswahl noch am alten Namen hing — nach dem ersten Zeichen war das Feld tot.
  const [nameDraft, setNameDraft] = useState("");
  useEffect(() => {
    setNameDraft(nodes.find((n) => n.id === selected)?.data.wf.name ?? "");
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [selected]);
  useEffect(() => {
    setParamText(selectedNode ? JSON.stringify(selectedNode.parameters, null, 2) : "");
    setParamError(null);
  }, [selectedNode?.name, selectedNode?.parameters]); // eslint-disable-line react-hooks/exhaustive-deps

  const onNodesChange = useCallback((changes: NodeChange<WfFlowNode>[]) => {
    setNodes((ns) => applyNodeChanges(changes, ns));
    if (changes.some((c) => c.type === "position" || c.type === "remove")) setDirty(true);
  }, []);
  const onEdgesChange = useCallback((changes: EdgeChange[]) => {
    setEdges((es) => applyEdgeChanges(changes, es));
    if (changes.some((c) => c.type === "remove")) setDirty(true);
  }, []);
  const onConnect = (c: Connection): void => {
    snapshot();
    setEdges((es) => addEdge({ ...c, id: `${c.source}:${c.sourceHandle}→${c.target}`, targetHandle: "in" }, es));
    setDirty(true);
  };

  const snapshot = (): void => {
    if (!def) return;
    setHistory((h) => [...h.slice(-49), { nodes, edges, def }]);
    setFuture([]);
  };
  const undo = (): void => {
    const last = history[history.length - 1];
    if (!last || !def) return;
    setFuture((f) => [...f, { nodes, edges, def }]);
    setHistory((h) => h.slice(0, -1));
    setNodes(last.nodes);
    setEdges(last.edges);
    setDef(last.def);
    setDirty(true);
  };
  const redo = (): void => {
    const next = future[future.length - 1];
    if (!next || !def) return;
    setHistory((h) => [...h, { nodes, edges, def }]);
    setFuture((f) => f.slice(0, -1));
    setNodes(next.nodes);
    setEdges(next.edges);
    setDef(next.def);
    setDirty(true);
  };
  useEffect(() => {
    const onKey = (e: KeyboardEvent): void => {
      const mod = e.metaKey || e.ctrlKey;
      if (!mod || e.key.toLowerCase() !== "z") return;
      const t = e.target as HTMLElement | null;
      if (t && (t.tagName === "INPUT" || t.tagName === "TEXTAREA" || t.isContentEditable)) return;
      e.preventDefault();
      if (e.shiftKey) redo();
      else undo();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }); // eslint-disable-line react-hooks/exhaustive-deps

  const updateNode = (name: string, patch: Partial<WorkflowNode>): void => {
    snapshot();
    setNodes((ns) => ns.map((n) => (n.id === name ? { ...n, data: { ...n.data, wf: { ...n.data.wf, ...patch } } } : n)));
    setDirty(true);
  };

  const applyParams = (): void => {
    if (!selectedNode) return;
    try {
      const parsed = JSON.parse(paramText) as Record<string, unknown>;
      updateNode(selectedNode.name, { parameters: parsed });
      setParamError(null);
    } catch (err) {
      setParamError(err instanceof Error ? err.message : String(err));
    }
  };

  const addNode = (entry: WorkflowCatalogEntry): void => {
    snapshot();
    const base = entry.label.replace(/^tool:/, "");
    let name = base, i = 2;
    while (nodes.some((n) => n.id === name)) name = `${base} ${i++}`;
    const isTool = entry.type.startsWith("tool:");
    const wf: WorkflowNode = {
      id: `n_${Date.now().toString(36)}`,
      name,
      type: isTool ? "tool" : (entry.type as WorkflowNode["type"]),
      position: [0, 0],
      parameters: isTool ? { tool: entry.type.slice(5), args: {} } : {},
    };
    const last = nodes.reduce((m, n) => Math.max(m, n.position.x), 0);
    setNodes((ns) => [...ns, { id: name, type: "wf", position: { x: last + 280, y: 120 }, data: { wf, write: entry.write, label: entry.label } }]);
    setSelected(name);
    setTab("node");
    setDirty(true);
  };

  const save = async (): Promise<void> => {
    if (!def) return;
    const next = fromFlow(def, nodes, edges);
    const r = await window.api.workflows.save({ ...next, id: def.id });
    if ("error" in r) {
      setNotice(r.error);
      return;
    }
    setProblems(r.problems);
    setNotice(r.problems.length > 0 ? `Gespeichert (v${r.workflow.version}) — ${r.problems.length} Hinweise` : `Gespeichert (v${r.workflow.version}).`);
    setDef(r.workflow);
    setDirty(false);
  };

  const run = async (dryRun: boolean, untilNode?: string): Promise<void> => {
    if (dirty) await save();
    if ((def?.settings.scope ?? "company") === "company") {
      setFirmaFuer({ dryRun, untilNode });
      return;
    }
    await starte(dryRun, null, untilNode);
  };

  const starte = async (dryRun: boolean, firma: { companyId: string; name: string } | null, untilNode?: string): Promise<void> => {
    setFirmaFuer(null);
    const r = await window.api.workflows.run(id, { dryRun, ...(untilNode ? { untilNode } : {}), ...(firma ? { companyId: firma.companyId, companyName: firma.name } : {}) });
    setNotice(r.error ?? (dryRun ? `Trockenlauf gestartet${firma ? ` für ${firma.name}` : ""}.` : `Lauf gestartet${firma ? ` für ${firma.name}` : ""}.`));
    setTab("runs");
  };

  const setTrigger = (t: WorkflowTrigger): void => {
    if (!def) return;
    setDef({ ...def, trigger: t });
    setDirty(true);
  };

  if (!def) return <div className="radar-page">{notice ?? "Lädt…"}</div>;

  const running = shownExecution?.status === "running" || shownExecution?.status === "paused" || shownExecution?.status === "waiting";
  const filteredCatalog = catalog.filter((c) => c.type !== "trigger" && (!addQuery || `${c.type} ${c.label} ${c.category} ${c.summary}`.toLowerCase().includes(addQuery.toLowerCase())));

  return (
    <div className="wf-editor">
      <div className="wf-editor__bar">
        <div className="wf-editor__title">
          <Link to="/workflows" className="link">
            ← Workflows
          </Link>
          <strong>{def.name}</strong>
          <span className="muted">v{def.version} · Trigger: {triggerText(def.trigger)}</span>
          {shownExecution && statusPill(shownExecution.status)}
          {dirty && <span className="pill pill--paused">ungespeichert</span>}
          {kosten && <span className="muted small" title="Grobe Kostenuebersicht je Lauf">{kosten.hinweis}</span>}
        </div>
        <div className="wf-editor__actions">
          <button type="button" className="proc-toggle" onClick={() => void run(true)} disabled={running}>
            Testen (Trockenlauf)
          </button>
          <button type="button" className="proc-toggle" onClick={() => void run(false)} disabled={running}>
            Ausführen
          </button>
          {running && shownExecution && (
            <button type="button" className="proc-toggle" onClick={() => void window.api.workflows.cancel(shownExecution.id)}>
              Abbrechen
            </button>
          )}
          <button type="button" className="proc-toggle" onClick={undo} disabled={history.length === 0} title="Rückgängig (Cmd/Strg+Z)">
            ↶
          </button>
          <button type="button" className="proc-toggle" onClick={redo} disabled={future.length === 0} title="Wiederholen (Shift+Cmd/Strg+Z)">
            ↷
          </button>
          <button type="button" className="primary" onClick={() => void save()} disabled={!dirty}>
            Speichern
          </button>
          <button type="button" className="proc-toggle" onClick={() => navigate("/chat")} title="Größere Umbauten im Chat: „ändere im Workflow X …“">
            Im Chat ändern
          </button>
        </div>
      </div>
      {notice && <div className="radar-notice wf-editor__notice">{notice}</div>}
      {shownExecution && (
        <div className="wf-runhead">
          <span>
            <strong>Lauf</strong> vom {new Date(shownExecution.startedAt).toLocaleString("de-DE", { dateStyle: "short", timeStyle: "short" })}
          </span>
          <span className="muted">Auslöser: {shownExecution.trigger === "test" ? "Trockenlauf" : shownExecution.trigger}</span>
          <span className="muted">Firma: {firmaText(shownExecution)}</span>
          <span className="muted">Dauer: {dauerText(shownExecution)}</span>
          {statusPill(shownExecution.status)}
          {shownExecution.waiting && (
            <span className="muted">
              {shownExecution.waiting.fertig ?? shownExecution.waiting.weitergegeben.length} Firmen weitergegeben, {shownExecution.waiting.offen ?? "?"} offen · wartet seit{" "}
              {new Date(shownExecution.waiting.seit).toLocaleString("de-DE", { dateStyle: "short", timeStyle: "short" })}
            </span>
          )}
          {shownExecution.error && <span className="warn small">{shownExecution.error}</span>}
          <span className="wf-runhead__actions">
            {(shownExecution.status === "running" || shownExecution.status === "waiting" || shownExecution.status === "paused") && (
              <button type="button" className="proc-toggle" onClick={() => void window.api.workflows.cancel(shownExecution.id).then(() => load())}>
                Lauf abbrechen
              </button>
            )}
            {shownExecution.status !== "running" && (
              <button
                type="button"
                className="proc-toggle"
                title="Denselben Lauf mit denselben Eingaben (Firma, Start-Items) erneut starten"
                onClick={() =>
                  void window.api.workflows.rerun(id, shownExecution.id).then((r) => {
                    setNotice(r.gestartet ? "Lauf wiederholt." : `Wiederholen nicht möglich: ${r.error ?? "unbekannt"}`);
                  })
                }
              >
                Lauf wiederholen
              </button>
            )}
            <Link to="/workflows/laeufe" className="link">
              Alle Läufe
            </Link>
          </span>
        </div>
      )}
      {firmaFuer && (
        <div className="wf-editor__notice">
          <FirmenAuswahl onAbbruch={() => setFirmaFuer(null)} onWahl={(f) => void starte(firmaFuer.dryRun, f, firmaFuer.untilNode)} />
        </div>
      )}
      {problems.length > 0 && (
        <div className="radar-hint wf-editor__notice">
          {problems.map((p, i) => (
            <div key={i}>
              {p.node ? `„${p.node}“: ` : ""}
              {p.message}
            </div>
          ))}
        </div>
      )}
      <div className="wf-editor__body">
        <div className="wf-canvas">
          <ReactFlow
            nodes={nodes}
            edges={edges}
            nodeTypes={nodeTypes}
            onNodesChange={onNodesChange}
            onEdgesChange={onEdgesChange}
            onConnect={onConnect}
            onNodeClick={(_e, n) => {
              setSelected(n.id);
              setTab("node");
            }}
            onPaneClick={() => setSelected(null)}
            fitView
            deleteKeyCode={["Backspace", "Delete"]}
            proOptions={{ hideAttribution: true }}
          >
            <Background gap={16} />
            <Controls showInteractive={false} />
            <MiniMap pannable zoomable />
          </ReactFlow>
        </div>
        <aside className="wf-panel">
          <div className="wf-panel__tabs">
            {(["node", "trigger", "runs", "add"] as const).map((t) => (
              <button key={t} type="button" className={`proc-toggle${tab === t ? " wf-tab--active" : ""}`} onClick={() => setTab(t)}>
                {t === "node" ? "Schritt" : t === "trigger" ? "Trigger" : t === "runs" ? `Läufe (${executions.length})` : "Hinzufügen"}
              </button>
            ))}
          </div>

          {tab === "node" && !selectedNode && <p className="muted small">Klick auf einen Schritt im Canvas, um Parameter, Modus und Freigabe zu sehen.</p>}
          {tab === "node" && selectedNode && (
            <div className="wf-panel__section">
              <label className="field">
                <span>Name</span>
                <input
                  value={nameDraft}
                  onChange={(e) => setNameDraft(e.target.value)}
                  onBlur={() => selected && renameNode(selected, nameDraft)}
                  onKeyDown={(e) => {
                    if (e.key === "Enter") (e.target as HTMLInputElement).blur();
                    if (e.key === "Escape") setNameDraft(selectedNode.name);
                  }}
                />
              </label>
              <div className="muted small">Typ: {selectedNode.type === "tool" ? `Tool ${String(selectedNode.parameters.tool)}` : selectedNode.type}</div>
              <label className="field">
                <span>Modus</span>
                <select value={selectedNode.mode ?? "perItem"} onChange={(e) => updateNode(selectedNode.name, { mode: e.target.value as "perItem" | "allItems" })}>
                  <option value="perItem">je Item</option>
                  <option value="allItems">einmal für alle Items</option>
                </select>
              </label>
              <label className="field">
                <span>Bei Fehler</span>
                <select value={selectedNode.onError ?? "stop"} onChange={(e) => updateNode(selectedNode.name, { onError: e.target.value as WorkflowNode["onError"] })}>
                  <option value="stop">Lauf abbrechen</option>
                  <option value="continue">Items durchreichen</option>
                  <option value="errorOutput">auf Fehler-Ausgang</option>
                </select>
              </label>
              <label className="org-check">
                <input type="checkbox" checked={selectedNode.confirmed === true} onChange={(e) => updateNode(selectedNode.name, { confirmed: e.target.checked })} />
                <span>
                  Für unbeaufsichtigte Läufe freigegeben
                  <span className="org-check__hint">Schreib-Schritte laufen im Zeitplan sonst nur mit passender Vollmacht; Mail-Versand nur mit dieser Freigabe oder einem Freigabe-Schritt davor.</span>
                </span>
              </label>
              <label className="org-check">
                <input type="checkbox" checked={selectedNode.disabled === true} onChange={(e) => updateNode(selectedNode.name, { disabled: e.target.checked })} />
                <span>Deaktiviert (Items werden durchgereicht)</span>
              </label>
              {(() => {
                const reqs = nodeRequirementsMitSub(selectedNode, getSubDef);
                if (reqs.length === 0 && selectedNode.type !== "wait") return null;
                return (
                  <div className="wf-deps">
                    {reqs.length > 0 && (
                      <div className="muted small">
                        Braucht:{" "}
                        {reqs.map((r) => (
                          <span key={r.stage} className="wf-badge" title={r.grund}>
                            {STAGE_LABELS[r.stage]}
                          </span>
                        ))}
                      </div>
                    )}
                    <details className="settings-collapse">
                      <summary>Abhängigkeiten festlegen</summary>
                      <div className="wf-weekdays">
                        {PIPELINE_STAGES.map((st) => {
                          const list = (selectedNode.dependsOn ?? []).filter((x): x is PipelineStage => (PIPELINE_STAGES as readonly string[]).includes(x));
                          const on = list.includes(st);
                          return (
                            <label key={st} className="org-check">
                              <input type="checkbox" checked={on} onChange={(e) => updateNode(selectedNode.name, { dependsOn: e.target.checked ? [...list, st] : list.filter((x) => x !== st) })} />
                              <span>{STAGE_LABELS[st]}</span>
                            </label>
                          );
                        })}
                      </div>
                      <div className="muted small">Ohne Auswahl leitet AVA die Stufen aus Platzhaltern und Expressions ab (z. B. $kassenbestand → Jahresabschlüsse). Läuft die Firma noch in einem Vorgang, wartet der Schritt darauf.</div>
                    </details>
                    {selectedNode.type === "wait" && typeof selectedNode.parameters.transactionId === "string" && (() => {
                      const w = waitStages(def, selectedNode, getSubDef);
                      const bis = (Array.isArray(selectedNode.parameters.bis) ? selectedNode.parameters.bis : []).filter((x): x is PipelineStage => (PIPELINE_STAGES as readonly string[]).includes(String(x)));
                      return (
                        <div className="wf-panel__section">
                          <div className="muted small">
                            Wartet auf:{" "}
                            {w.stufen.map((st) => (
                              <span key={st} className="wf-badge wf-badge--ok">{STAGE_LABELS[st]}</span>
                            ))}
                            {w.automatisch ? " (automatisch aus den Folge-Schritten)" : " (festgelegt)"}
                          </div>
                          {w.gruende.length > 0 && <div className="muted small">Folge-Schritte brauchen: {w.gruende.map((g) => `${STAGE_LABELS[g.stage]} — ${g.grund}`).join(" · ")}</div>}
                          <div className="wf-weekdays">
                            {PIPELINE_STAGES.map((st) => (
                              <label key={st} className="org-check">
                                <input type="checkbox" checked={bis.includes(st)} onChange={(e) => updateNode(selectedNode.name, { parameters: { ...selectedNode.parameters, bis: e.target.checked ? [...bis, st] : bis.filter((x) => x !== st) } })} />
                                <span>{STAGE_LABELS[st]}</span>
                              </label>
                            ))}
                          </div>
                          <div className="muted small">Keine Auswahl = automatisch. Gewartet wird auf den Endzustand (fertig oder fehlgeschlagen), damit eine ausgefallene Quelle den Lauf nicht ewig blockiert; fehlende Werte nutzen den Fallback des Platzhalters.</div>
                        </div>
                      );
                    })()}
                  </div>
                );
              })()}
              {(() => {
                const entry = selectedNode.type === "tool" ? catalog.find((c) => c.type === `tool:${String(selectedNode.parameters.tool)}`) : catalog.find((c) => c.type === selectedNode.type);
                const schema = (entry?.parameters ?? {}) as JsonSchema;
                const vorschlaege = expressionVorschlaege(def, selectedNode.name, shownExecution);
                if (selectedNode.type === "tool") {
                  const args = (selectedNode.parameters.args as Record<string, unknown> | undefined) ?? {};
                  return (
                    <>
                      <div className="muted small">Argumente für {String(selectedNode.parameters.tool)} — Werte, Expressions oder Platzhalter</div>
                      <ParamForm schema={schema} value={args} onChange={(next) => updateNode(selectedNode.name, { parameters: { ...selectedNode.parameters, args: next } })} vorschlaege={vorschlaege} listId={`wf-sug-${selectedNode.id}`} />
                    </>
                  );
                }
                if (selectedNode.type !== "trigger" && selectedNode.type !== "note") {
                  return <ParamForm schema={schema} value={selectedNode.parameters} onChange={(next) => updateNode(selectedNode.name, { parameters: next })} vorschlaege={vorschlaege} listId={`wf-sug-${selectedNode.id}`} />;
                }
                return null;
              })()}
              <details className="settings-collapse">
                <summary>Erweitert: Parameter als JSON</summary>
                <textarea className="wf-params" value={paramText} onChange={(e) => setParamText(e.target.value)} spellCheck={false} rows={12} />
                {paramError && <div className="muted small warn">{paramError}</div>}
                <button type="button" className="proc-toggle" onClick={applyParams}>
                  JSON übernehmen
                </button>
              </details>
              <div className="org-actions">
                <button
                  type="button"
                  className="link"
                  onClick={() => {
                    snapshot();
                    setNodes((ns) => ns.filter((n) => n.id !== selectedNode.name));
                    setEdges((es) => es.filter((e) => e.source !== selectedNode.name && e.target !== selectedNode.name));
                    setSelected(null);
                    setDirty(true);
                  }}
                >
                  Schritt entfernen
                </button>
              </div>
              {selectedNode.type !== "trigger" && (
                <div className="org-actions">
                  <button type="button" className="proc-toggle" onClick={() => void run(true, selectedNode.name)} title="Testlauf bis einschließlich dieses Schritts (Trockenlauf, Pin-Daten werden genutzt)">
                    Bis hierhin testen
                  </button>
                  {shownExecution?.nodeRuns[selectedNode.name]?.at(-1)?.output?.[0] && (
                    <button
                      type="button"
                      className="proc-toggle"
                      title="Ausgabe dieses Laufs als Pin speichern: Testläufe nutzen sie statt den Schritt auszuführen"
                      onClick={() => {
                        const out = shownExecution!.nodeRuns[selectedNode.name]!.at(-1)!.output![0]!;
                        const pinData = { ...(def.pinData ?? {}), [selectedNode.name]: out };
                        void window.api.workflows.patch(def.id, { pinData }).then((r) => {
                          if (r.workflow) {
                            setDef(r.workflow);
                            setNotice(`Ausgabe von „${selectedNode.name}“ gepinnt (${out.length} Items).`);
                          }
                        });
                      }}
                    >
                      Ausgabe pinnen
                    </button>
                  )}
                  {def.pinData?.[selectedNode.name] && (
                    <button
                      type="button"
                      className="link"
                      onClick={() => {
                        const pinData = { ...(def.pinData ?? {}) };
                        delete pinData[selectedNode.name];
                        void window.api.workflows.patch(def.id, { pinData }).then((r) => r.workflow && setDef(r.workflow));
                      }}
                    >
                      Pin entfernen ({def.pinData[selectedNode.name]!.length} Items)
                    </button>
                  )}
                </div>
              )}
              {selectedNode && shownExecution?.nodeRuns[selectedNode.name] && <RunDetail def={def} execution={shownExecution} nodeName={selectedNode.name} />}
            </div>
          )}

          {tab === "trigger" && (
            <div className="wf-panel__section">
              <label className="field">
                <span>Art</span>
                <select
                  value={def.trigger.kind}
                  onChange={(e) => {
                    const k = e.target.value as WorkflowTrigger["kind"];
                    setTrigger(k === "schedule" ? { kind: "schedule", at: "07:00", weekdays: [1, 2, 3, 4, 5] } : k === "event" ? { kind: "event", event: "radar.newHot" } : { kind: k });
                  }}
                >
                  <option value="manual">manuell</option>
                  <option value="schedule">Zeitplan</option>
                  <option value="event">Ereignis</option>
                  <option value="chat">per Chat</option>
                </select>
              </label>
              {def.trigger.kind === "schedule" && (
                <>
                  <label className="field">
                    <span>Uhrzeit (täglich)</span>
                    <input type="time" value={def.trigger.at ?? ""} onChange={(e) => setTrigger({ kind: "schedule", at: e.target.value || undefined, weekdays: def.trigger.kind === "schedule" ? def.trigger.weekdays : undefined })} />
                  </label>
                  <div className="wf-weekdays">
                    {["So", "Mo", "Di", "Mi", "Do", "Fr", "Sa"].map((d, i) => {
                      const t = def.trigger as Extract<WorkflowTrigger, { kind: "schedule" }>;
                      const on = !t.weekdays || t.weekdays.length === 0 || t.weekdays.includes(i);
                      return (
                        <label key={d} className="field-inline">
                          <input
                            type="checkbox"
                            checked={on}
                            onChange={(e) => {
                              const cur = new Set(t.weekdays && t.weekdays.length > 0 ? t.weekdays : [0, 1, 2, 3, 4, 5, 6]);
                              if (e.target.checked) cur.add(i);
                              else cur.delete(i);
                              setTrigger({ ...t, weekdays: [...cur].sort() });
                            }}
                          />
                          <span>{d}</span>
                        </label>
                      );
                    })}
                  </div>
                  <label className="field">
                    <span>oder Intervall (Minuten, leer = Uhrzeit)</span>
                    <input
                      type="number"
                      min={15}
                      value={def.trigger.intervalMinutes ?? ""}
                      onChange={(e) => setTrigger({ kind: "schedule", intervalMinutes: e.target.value ? Number(e.target.value) : undefined, at: e.target.value ? undefined : "07:00" })}
                    />
                  </label>
                  <p className="muted small">Läuft nur, wenn AVA zur Zeit des Triggers geöffnet ist; versäumte Läufe werden nicht nachgeholt.</p>
                </>
              )}
              {def.trigger.kind === "event" && (
                <label className="field">
                  <span>Ereignis</span>
                  <select value={def.trigger.event} onChange={(e) => setTrigger({ kind: "event", event: e.target.value as Extract<WorkflowTrigger, { kind: "event" }>["event"] })}>
                    <option value="radar.newHot">Radar: neuer heißer Treffer</option>
                    <option value="mail.inbound">Mail: eingehende Nachricht</option>
                    <option value="alert.created">Neue Meldung</option>
                    <option value="import.finished">Import abgeschlossen</option>
                  </select>
                </label>
              )}
              <label className="org-check">
                <input type="checkbox" checked={def.enabled} onChange={(e) => { setDef({ ...def, enabled: e.target.checked }); setDirty(true); }} />
                <span>Workflow aktiv (Trigger greifen)</span>
              </label>
              <label className="field">
                <span>Firmenbezug</span>
                <select value={def.settings.scope ?? "company"} onChange={(e) => { setDef({ ...def, settings: { ...def.settings, scope: e.target.value as "company" | "none" } }); setDirty(true); }}>
                  <option value="company">je Lauf eine Firma (voller Kontext)</option>
                  <option value="none">ohne Firma (z. B. nur Radar starten)</option>
                </select>
              </label>
              {def.trigger.kind === "schedule" && (def.settings.scope ?? "company") === "company" && (
                <label className="field">
                  <span>Firmenquelle (je Firma ein Lauf)</span>
                  <select
                    value={def.trigger.companySource?.kind ?? "list"}
                    onChange={(e) => {
                      const k = e.target.value as "list" | "radarHot" | "transaction" | "allCompanies";
                      const t = def.trigger as Extract<WorkflowTrigger, { kind: "schedule" }>;
                      setTrigger({
                        ...t,
                        companySource: k === "list" ? { kind: "list" } : k === "radarHot" ? { kind: "radarHot", minScore: 70, nurNeue: true } : k === "transaction" ? { kind: "transaction", transactionId: "" } : { kind: "allCompanies", limit: 200 },
                      });
                    }}
                  >
                    <option value="list">feste Liste (companyIds unten)</option>
                    <option value="radarHot">Radar: heiße Kandidaten (Score ab Schwelle, noch nicht importiert)</option>
                    <option value="transaction">alle Firmen eines Vorgangs</option>
                    <option value="allCompanies">alle meine Firmen</option>
                  </select>
                </label>
              )}
              {def.trigger.kind === "schedule" && def.trigger.companySource?.kind === "radarHot" && (
                <label className="field">
                  <span>Mindest-Score</span>
                  <input type="number" min={0} max={100} value={def.trigger.companySource.minScore ?? 70} onChange={(e) => setTrigger({ ...(def.trigger as Extract<WorkflowTrigger, { kind: "schedule" }>), companySource: { kind: "radarHot", minScore: Number(e.target.value), nurNeue: true } })} />
                </label>
              )}
              {def.trigger.kind === "schedule" && def.trigger.companySource?.kind === "transaction" && (
                <label className="field">
                  <span>Vorgangs-ID</span>
                  <input value={def.trigger.companySource.transactionId} onChange={(e) => setTrigger({ ...(def.trigger as Extract<WorkflowTrigger, { kind: "schedule" }>), companySource: { kind: "transaction", transactionId: e.target.value.trim() } })} />
                </label>
              )}
              {def.trigger.kind === "schedule" && (def.settings.scope ?? "company") === "company" && (
                <label className="field">
                  <span>Firmen für den Zeitplan (companyIds, eine je Zeile)</span>
                  <textarea
                    rows={4}
                    value={(def.trigger.companyIds ?? []).join("\n")}
                    onChange={(e) => setTrigger({ ...def.trigger, kind: "schedule", companyIds: e.target.value.split(/\n/).map((s) => s.trim()).filter(Boolean) } as WorkflowTrigger)}
                  />
                </label>
              )}
              <label className="field">
                <span>Fehler-Workflow (läuft bei Fehler mit Fehler-Item)</span>
                <select value={def.settings.errorWorkflowId ?? ""} onChange={(e) => { setDef({ ...def, settings: { ...def.settings, errorWorkflowId: e.target.value || undefined } }); setDirty(true); }}>
                  <option value="">keiner</option>
                  {andere.map((w) => (
                    <option key={w.id} value={w.id}>
                      {w.name}
                    </option>
                  ))}
                </select>
              </label>
              <label className="field">
                <span>Mails je Tag höchstens</span>
                <input type="number" min={0} value={def.settings.maxMailsPerDay} onChange={(e) => { setDef({ ...def, settings: { ...def.settings, maxMailsPerDay: Number(e.target.value) } }); setDirty(true); }} />
              </label>
            </div>
          )}

          {tab === "runs" && (
            <div className="wf-panel__section">
              {executions.length === 0 && <p className="muted small">Noch kein Lauf.</p>}
              <div className="org-list">
                {executions.map((ex) => (
                  <button key={ex.id} type="button" className={`org-row wf-run${shownExecution?.id === ex.id ? " wf-run--active" : ""}`} onClick={() => setShownExecution(ex)}>
                    <div className="org-row__main">
                      <span className="org-row__title">
                        {new Date(ex.startedAt).toLocaleString("de-DE", { dateStyle: "short", timeStyle: "short" })} · {ex.trigger}
                        {ex.dryRun ? " · Trockenlauf" : ""}
                        {ex.scope?.companyName ? ` · ${ex.scope.companyName}` : ""}
                      </span>
                      <span className="org-row__meta">{ex.summary ?? ex.error ?? ""}</span>
                    </div>
                    <div className="org-row__actions">{statusPill(ex.status)}</div>
                  </button>
                ))}
              </div>
            </div>
          )}

          {tab === "add" && (
            <div className="wf-panel__section">
              <input className="telegram-input" placeholder="Schritt suchen (z. B. mail, hubspot, filter)" value={addQuery} onChange={(e) => setAddQuery(e.target.value)} />
              <div className="org-list wf-palette">
                {filteredCatalog.slice(0, 60).map((c) => (
                  <button key={c.type} type="button" className="org-row" onClick={() => addNode(c)}>
                    <div className="org-row__main">
                      <span className="org-row__title">
                        {c.label} <span className="muted">· {c.category}</span>
                      </span>
                      <span className="org-row__meta">{c.summary}</span>
                    </div>
                    <div className="org-row__actions">{c.write && <span className="wf-badge wf-badge--warn">{c.actionKind}</span>}</div>
                  </button>
                ))}
              </div>
            </div>
          )}
        </aside>
      </div>
    </div>
  );

  function renameNode(oldName: string, newName: string): void {
    const n = newName.trim();
    if (!n || n === oldName) return;
    if (nodes.some((x) => x.id === n)) {
      setNotice(`Es gibt schon einen Schritt „${n}“.`);
      setNameDraft(oldName);
      return;
    }
    snapshot();
    setNodes((ns) => ns.map((x) => (x.id === oldName ? { ...x, id: n, data: { ...x.data, wf: { ...x.data.wf, name: n } } } : x)));
    setEdges((es) => es.map((e) => ({ ...e, source: e.source === oldName ? n : e.source, target: e.target === oldName ? n : e.target })));
    setSelected(n);
    setDirty(true);
  }
}

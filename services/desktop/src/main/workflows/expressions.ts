// W1 — Expressions fuer Workflows: `{{ $json.score >= 80 }}`,
// `{{ $('Kandidaten lesen').item.json.discoveryId }}`, `{{ $input.all() }}`,
// `{{ $vars.mindestScore }}`, `{{ $now }}`, `{{ $run.index }}`.
//
// Entscheidung (2026-09-09, dem Assistenten ueberlassen): jsep-Parser mit
// eigener, sicherer Auswertung. Damit sieht die Syntax aus wie JavaScript
// (was n8n-Nutzer erwarten) — Vergleiche, Arithmetik, Ternaer, Member-
// Zugriff, Array-Methoden, Template-Strings —, aber es gibt KEIN eval,
// KEIN vm, keine Prototyp-Zugriffe, keine Zuweisungen, keine Schleifen.
// Laufzeit ist durch eine Schrittgrenze begrenzt.

import jsep from "jsep";
import jsepArrow from "@jsep-plugin/arrow";
import jsepObject from "@jsep-plugin/object";
import jsepTemplate from "@jsep-plugin/template";

// Pfeilfunktionen (map/filter), Objekt-Literale, Template-Strings, ??, in.
jsep.plugins.register(jsepArrow, jsepObject, jsepTemplate);
jsep.addBinaryOp("??", 1);
jsep.addBinaryOp("in", 7);
// Bitweise Operatoren sind nicht sinnvoll und werden entfernt.
for (const op of ["|", "&", "^", "<<", ">>", ">>>"]) jsep.removeBinaryOp(op);

export interface ExpressionContext {
  /** Aktuelles Item (json). */
  json: Record<string, unknown>;
  /** Index des aktuellen Items in der Eingabe. */
  itemIndex: number;
  /** Alle Eingabe-Items des Nodes. */
  inputItems: Array<{ json: Record<string, unknown> }>;
  /** Ausgabe frueherer Nodes (Name → Items je Ausgang 0), fuer $('Name'). */
  nodeOutput: (name: string) => Array<{ json: Record<string, unknown> }> | undefined;
  /** Paired-Item-Index frueherer Nodes, falls bekannt (Name → Index). */
  pairedIndex: (name: string) => number | undefined;
  vars: Record<string, unknown>;
  run: { index: number; executionId: string; workflowName: string; dryRun: boolean };
  /** Firmen-Kontext des Laufs (strukturiert) — $company / $firma. */
  company?: Record<string, unknown>;
  /** Firmen-Kontext als Klartext — $context / $kontext. */
  contextText?: string;
}

const MAX_STEPS = 20_000;
const EXPR_RE = /\{\{([\s\S]*?)\}\}/g;

const FORBIDDEN_PROPS = new Set(["__proto__", "constructor", "prototype", "__defineGetter__", "__defineSetter__", "__lookupGetter__", "__lookupSetter__"]);

/** Enthaelt der Wert eine Expression? */
export function hasExpression(value: unknown): boolean {
  return typeof value === "string" && /\{\{[\s\S]*?\}\}/.test(value);
}

/**
 * Loest einen Parameterwert auf: Strings mit `{{ }}` werden ausgewertet.
 * Besteht der String NUR aus einer Expression, kommt der rohe Wert (Zahl,
 * Array, Objekt) zurueck; sonst wird als Text interpoliert. Objekte/Arrays
 * werden rekursiv aufgeloest.
 */
export function resolveValue(value: unknown, ctx: ExpressionContext): unknown {
  if (typeof value === "string") {
    const trimmed = value.trim();
    const single = /^\{\{([\s\S]*)\}\}$/.exec(trimmed);
    if (single && !single[1]!.includes("}}")) {
      return evaluate(single[1]!, ctx);
    }
    if (!hasExpression(value)) return value;
    return value.replace(EXPR_RE, (_m, inner: string) => stringify(evaluate(inner, ctx)));
  }
  if (Array.isArray(value)) return value.map((v) => resolveValue(v, ctx));
  if (value && typeof value === "object") {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value as Record<string, unknown>)) out[k] = resolveValue(v, ctx);
    return out;
  }
  return value;
}

function stringify(v: unknown): string {
  if (v == null) return "";
  if (typeof v === "string") return v;
  if (typeof v === "number" || typeof v === "boolean") return String(v);
  try {
    return JSON.stringify(v);
  } catch {
    return String(v);
  }
}

/** Wertet eine einzelne Expression (ohne `{{ }}`) aus. Wirft bei Fehlern. */
export function evaluate(source: string, ctx: ExpressionContext): unknown {
  const ast = jsep(source.trim());
  const state = { steps: 0 };
  return evalNode(ast, ctx, state);
}

type Node = jsep.Expression;

function evalNode(node: Node, ctx: ExpressionContext, state: { steps: number }): unknown {
  if (++state.steps > MAX_STEPS) throw new Error("Expression zu aufwendig (Schrittgrenze).");
  switch (node.type) {
    case "Literal":
      return (node as jsep.Literal).value;
    case "Identifier":
      return resolveIdentifier((node as jsep.Identifier).name, ctx);
    case "ThisExpression":
      return ctx.json;
    case "ArrayExpression":
      return (node as jsep.ArrayExpression).elements.map((e) => (e ? evalNode(e, ctx, state) : null));
    case "ObjectExpression": {
      const out: Record<string, unknown> = {};
      for (const p of (node as unknown as { properties: Array<{ key: Node; value: Node; shorthand?: boolean; computed?: boolean }> }).properties) {
        const key = p.computed ? String(evalNode(p.key, ctx, state)) : p.key.type === "Identifier" ? (p.key as jsep.Identifier).name : String((p.key as jsep.Literal).value);
        assertProp(key);
        out[key] = p.shorthand ? resolveIdentifier(key, ctx) : evalNode(p.value, ctx, state);
      }
      return out;
    }
    case "TemplateLiteral": {
      const t = node as unknown as { quasis: Array<{ value: { cooked: string } }>; expressions: Node[] };
      let s = "";
      t.quasis.forEach((q, i) => {
        s += q.value.cooked;
        if (i < t.expressions.length) s += stringify(evalNode(t.expressions[i]!, ctx, state));
      });
      return s;
    }
    case "UnaryExpression": {
      const u = node as jsep.UnaryExpression;
      const v = evalNode(u.argument, ctx, state);
      switch (u.operator) {
        case "!":
          return !v;
        case "-":
          return -(v as number);
        case "+":
          return +(v as number);
        case "typeof":
          return typeof v;
        default:
          throw new Error(`Operator nicht erlaubt: ${u.operator}`);
      }
    }
    case "BinaryExpression": {
      const b = node as jsep.BinaryExpression;
      if (b.operator === "&&") return evalNode(b.left, ctx, state) && evalNode(b.right, ctx, state);
      if (b.operator === "||") return evalNode(b.left, ctx, state) || evalNode(b.right, ctx, state);
      if (b.operator === "??") {
        const l = evalNode(b.left, ctx, state);
        return l ?? evalNode(b.right, ctx, state);
      }
      const l = evalNode(b.left, ctx, state) as never;
      const r = evalNode(b.right, ctx, state) as never;
      switch (b.operator) {
        case "+": return (l as number) + (r as number);
        case "-": return (l as number) - (r as number);
        case "*": return (l as number) * (r as number);
        case "/": return (l as number) / (r as number);
        case "%": return (l as number) % (r as number);
        case "==": return l == r; // eslint-disable-line eqeqeq
        case "!=": return l != r; // eslint-disable-line eqeqeq
        case "===": return l === r;
        case "!==": return l !== r;
        case "<": return l < r;
        case "<=": return l <= r;
        case ">": return l > r;
        case ">=": return l >= r;
        case "in": return typeof r === "object" && r !== null && String(l) in (r as object);
        default:
          throw new Error(`Operator nicht erlaubt: ${b.operator}`);
      }
    }
    case "ConditionalExpression": {
      const c = node as jsep.ConditionalExpression;
      return evalNode(c.test, ctx, state) ? evalNode(c.consequent, ctx, state) : evalNode(c.alternate, ctx, state);
    }
    case "MemberExpression": {
      const m = node as jsep.MemberExpression;
      const obj = evalNode(m.object, ctx, state);
      const key = m.computed ? evalNode(m.property, ctx, state) : (m.property as jsep.Identifier).name;
      return getMember(obj, key);
    }
    case "CallExpression": {
      const c = node as jsep.CallExpression;
      const args = c.arguments.map((a) => evalNode(a, ctx, state));
      // $('Node')
      if (c.callee.type === "Identifier" && (c.callee as jsep.Identifier).name === "$") {
        return nodeRef(String(args[0] ?? ""), ctx);
      }
      if (c.callee.type === "MemberExpression") {
        const m = c.callee as jsep.MemberExpression;
        const obj = evalNode(m.object, ctx, state);
        const method = m.computed ? String(evalNode(m.property, ctx, state)) : (m.property as jsep.Identifier).name;
        return callMethod(obj, method, args, ctx, state);
      }
      if (c.callee.type === "Identifier") {
        return callGlobal((c.callee as jsep.Identifier).name, args);
      }
      throw new Error("Aufruf nicht erlaubt.");
    }
    case "ArrowFunctionExpression": {
      // Nur als Argument von Array-Methoden (map/filter/…) erlaubt — siehe callMethod.
      return makeArrow(node as unknown as ArrowNode, ctx, state);
    }
    default:
      throw new Error(`Syntax nicht erlaubt: ${node.type}`);
  }
}

interface ArrowNode {
  params: Array<{ type: string; name?: string }>;
  body: Node;
}

function makeArrow(node: ArrowNode, ctx: ExpressionContext, state: { steps: number }): (...a: unknown[]) => unknown {
  const names = node.params.map((p) => {
    if (p.type !== "Identifier" || !p.name) throw new Error("Nur einfache Parameter in Pfeilfunktionen.");
    return p.name;
  });
  return (...a: unknown[]) => {
    const scoped: ExpressionContext = { ...ctx, vars: { ...ctx.vars } };
    const locals: Record<string, unknown> = {};
    names.forEach((n, i) => (locals[n] = a[i]));
    (scoped as ExpressionContext & { locals?: Record<string, unknown> }).locals = {
      ...((ctx as ExpressionContext & { locals?: Record<string, unknown> }).locals ?? {}),
      ...locals,
    };
    return evalNode(node.body, scoped, state);
  };
}

function resolveIdentifier(name: string, ctx: ExpressionContext): unknown {
  const locals = (ctx as ExpressionContext & { locals?: Record<string, unknown> }).locals;
  if (locals && name in locals) return locals[name];
  switch (name) {
    case "$json":
      return ctx.json;
    case "$input":
      return {
        all: () => ctx.inputItems,
        first: () => ctx.inputItems[0],
        last: () => ctx.inputItems[ctx.inputItems.length - 1],
        item: ctx.inputItems[ctx.itemIndex],
        count: ctx.inputItems.length,
      };
    case "$vars":
      return ctx.vars;
    case "$now":
      return new Date().toISOString();
    case "$today":
      return new Date().toISOString().slice(0, 10);
    case "$run":
      return ctx.run;
    case "$company":
    case "$firma":
      return ctx.company ?? {};
    case "$context":
    case "$kontext":
      return ctx.contextText ?? "";
    case "$itemIndex":
      return ctx.itemIndex;
    case "true":
      return true;
    case "false":
      return false;
    case "null":
      return null;
    case "undefined":
      return undefined;
    case "Math":
      return SAFE_MATH;
    case "Number":
      return Number;
    case "String":
      return String;
    case "Boolean":
      return Boolean;
    case "Date":
      return SAFE_DATE;
    case "JSON":
      return { stringify: JSON.stringify, parse: JSON.parse };
    default:
      throw new Error(`Unbekannter Bezeichner: ${name}`);
  }
}

function nodeRef(name: string, ctx: ExpressionContext): unknown {
  const items = ctx.nodeOutput(name);
  if (!items) throw new Error(`Node „${name}“ hat noch keine Ausgabe (nicht vorher gelaufen?).`);
  const idx = ctx.pairedIndex(name) ?? ctx.itemIndex;
  return {
    item: items[Math.min(idx, items.length - 1)] ?? { json: {} },
    all: () => items,
    first: () => items[0],
    last: () => items[items.length - 1],
    count: items.length,
  };
}

const SAFE_MATH = Object.freeze({
  abs: Math.abs, ceil: Math.ceil, floor: Math.floor, round: Math.round, max: Math.max, min: Math.min, sqrt: Math.sqrt, pow: Math.pow, trunc: Math.trunc,
});
const SAFE_DATE = Object.freeze({
  now: () => Date.now(),
  iso: (v?: unknown) => (v == null ? new Date() : new Date(v as string)).toISOString(),
  parse: (v: string) => Date.parse(v),
  daysAgo: (n: number) => new Date(Date.now() - n * 86_400_000).toISOString(),
});

function assertProp(key: string): void {
  if (FORBIDDEN_PROPS.has(key)) throw new Error(`Zugriff nicht erlaubt: ${key}`);
}

function getMember(obj: unknown, key: unknown): unknown {
  if (obj == null) return undefined;
  const k = typeof key === "number" ? key : String(key);
  if (typeof k === "string") assertProp(k);
  if (typeof obj === "string" && k === "length") return obj.length;
  if (Array.isArray(obj) && k === "length") return obj.length;
  if (typeof obj !== "object" && typeof obj !== "function" && typeof obj !== "string") return undefined;
  if (typeof obj === "string") return undefined;
  return (obj as Record<string | number, unknown>)[k as string];
}

const STRING_METHODS = new Set(["toLowerCase", "toUpperCase", "trim", "includes", "startsWith", "endsWith", "split", "replace", "replaceAll", "slice", "substring", "indexOf", "padStart", "padEnd", "match", "toString", "localeCompare", "concat", "repeat", "at", "charAt"]);
const ARRAY_METHODS = new Set(["map", "filter", "find", "findIndex", "some", "every", "slice", "concat", "join", "includes", "indexOf", "flat", "flatMap", "reduce", "sort", "reverse", "at", "length", "toSorted"]);
const NUMBER_METHODS = new Set(["toFixed", "toString", "toLocaleString"]);

function callMethod(obj: unknown, method: string, args: unknown[], ctx: ExpressionContext, state: { steps: number }): unknown {
  assertProp(method);
  if (typeof obj === "string") {
    if (!STRING_METHODS.has(method)) throw new Error(`String-Methode nicht erlaubt: ${method}`);
    return (obj as unknown as Record<string, (...a: unknown[]) => unknown>)[method]!.apply(obj, args);
  }
  if (typeof obj === "number") {
    if (!NUMBER_METHODS.has(method)) throw new Error(`Zahl-Methode nicht erlaubt: ${method}`);
    return (obj as unknown as Record<string, (...a: unknown[]) => unknown>)[method]!.apply(obj, args);
  }
  if (Array.isArray(obj)) {
    if (!ARRAY_METHODS.has(method)) throw new Error(`Array-Methode nicht erlaubt: ${method}`);
    if (method === "sort" || method === "reverse") obj = [...obj]; // nie in-place
    if (method === "toSorted") method = "sort", (obj = [...(obj as unknown[])]);
    const fn = (obj as unknown as Record<string, (...a: unknown[]) => unknown>)[method]!;
    // Schrittgrenze auch in Callbacks
    state.steps += (obj as unknown[]).length;
    if (state.steps > MAX_STEPS) throw new Error("Expression zu aufwendig (Schrittgrenze).");
    return fn.apply(obj, args);
  }
  if (obj && typeof obj === "object") {
    const fn = (obj as Record<string, unknown>)[method];
    if (typeof fn === "function") return (fn as (...a: unknown[]) => unknown).apply(obj, args);
    throw new Error(`Methode nicht vorhanden: ${method}`);
  }
  if (typeof obj === "function") {
    // Number("1"), String(x), Boolean(x)
    return (obj as (...a: unknown[]) => unknown)(...args);
  }
  throw new Error(`Methodenaufruf auf ${typeof obj} nicht erlaubt.`);
}

function callGlobal(name: string, args: unknown[]): unknown {
  switch (name) {
    case "Number":
      return Number(args[0]);
    case "String":
      return String(args[0] ?? "");
    case "Boolean":
      return Boolean(args[0]);
    case "parseInt":
      return parseInt(String(args[0]), (args[1] as number) ?? 10);
    case "parseFloat":
      return parseFloat(String(args[0]));
    case "isNaN":
      return Number.isNaN(Number(args[0]));
    default:
      throw new Error(`Funktion nicht erlaubt: ${name}`);
  }
}

/** Findet alle Node-Namen, auf die eine Definition per $('Name') verweist. */
export function referencedNodeNames(value: unknown): string[] {
  const out = new Set<string>();
  const walk = (v: unknown): void => {
    if (typeof v === "string") {
      for (const m of v.matchAll(/\$\(\s*(['"])(.+?)\1\s*\)/g)) out.add(m[2]!);
    } else if (Array.isArray(v)) v.forEach(walk);
    else if (v && typeof v === "object") Object.values(v as Record<string, unknown>).forEach(walk);
  };
  walk(value);
  return [...out];
}

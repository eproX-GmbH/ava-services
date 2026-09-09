// W1b — Semantische Platzhalter (Operator-Vorgabe 2026-09-09).
//
// AVA erfindet beim Bauen eines Workflows Platzhalter wie `$kassenbestand`,
// `$ansprechpartner_vertrieb` oder `$umsatz_letztes_jahr`. Es gibt keine
// feste Liste: Die KI des Workflow-Laufs befuellt sie aus dem Firmen-
// Kontext nach SEMANTISCHER Aehnlichkeit („… der Kassenbestand betraegt
// 100.000 EUR …“ → $kassenbestand = "100.000 EUR"). Fehlt der Wert, greift
// der Fallback: `$kassenbestand ?? "Es liegt KEIN Kassenbestand vor"`.
//
// Abgrenzung zu Expressions: `$json`, `$input`, `$vars`, `$company`,
// `$context`, `$now`, `$today`, `$run`, `$itemIndex` und `$('Node')` sind
// keine Platzhalter, sondern Expression-Wurzeln.

import type { LlmProviderManager } from "../agent/providers";
import { buildMessages, parseJsonObject, streamToText } from "../link-monitor/llm";

const RESERVED = new Set(["json", "input", "vars", "company", "firma", "context", "kontext", "now", "today", "run", "itemIndex"]);

/** `$name` (nicht `$(`), optional gefolgt von `?? "Fallback"` / `?? 'Fallback'`. */
const PH_RE = /\$([A-Za-zÄÖÜäöüß_][\wÄÖÜäöüß]*)(?!\s*\()(?:\s*\?\?\s*(?:"((?:[^"\\]|\\.)*)"|'((?:[^'\\]|\\.)*)'))?/g;

export interface PlaceholderRef {
  name: string;
  fallback: string | null;
}

/** Alle semantischen Platzhalter in einem Wert (rekursiv). */
export function findPlaceholders(value: unknown): PlaceholderRef[] {
  const out = new Map<string, PlaceholderRef>();
  const walk = (v: unknown): void => {
    if (typeof v === "string") {
      for (const m of v.matchAll(PH_RE)) {
        const name = m[1]!;
        if (RESERVED.has(name)) continue;
        const fallback = m[2] ?? m[3] ?? null;
        if (!out.has(name) || (fallback && !out.get(name)!.fallback)) out.set(name, { name, fallback });
      }
    } else if (Array.isArray(v)) v.forEach(walk);
    else if (v && typeof v === "object") Object.values(v as Record<string, unknown>).forEach(walk);
  };
  walk(value);
  return [...out.values()];
}

/**
 * Ersetzt Platzhalter durch Werte. Innerhalb von `{{ }}` wird als JSON-
 * Literal eingesetzt (Zahlen bleiben Zahlen), ausserhalb als Text.
 * Unbekannte Werte: Fallback, sonst "" und ein Hinweis.
 */
export function applyPlaceholders(
  value: unknown,
  values: Record<string, unknown>,
  hinweise: string[],
): unknown {
  if (typeof value === "string") {
    let out = "";
    let last = 0;
    // Segmente: innerhalb/ausserhalb von {{ }}
    const segs = value.split(/(\{\{[\s\S]*?\}\})/g);
    for (const seg of segs) {
      const inExpr = seg.startsWith("{{") && seg.endsWith("}}");
      out += seg.replace(PH_RE, (_m, name: string, fb1?: string, fb2?: string) => {
        if (RESERVED.has(name)) return _m;
        const fallback = fb1 ?? fb2 ?? null;
        const v = values[name];
        const fehlt = v === undefined || v === null || v === "";
        if (fehlt) {
          if (fallback === null) hinweise.push(`Platzhalter $${name}: kein Wert im Firmen-Kontext und kein Fallback.`);
          const f = fallback ?? "";
          return inExpr ? JSON.stringify(f) : f;
        }
        if (inExpr) return JSON.stringify(v);
        return typeof v === "string" ? v : typeof v === "number" || typeof v === "boolean" ? String(v) : JSON.stringify(v);
      });
      last += seg.length;
    }
    void last;
    return out;
  }
  if (Array.isArray(value)) return value.map((v) => applyPlaceholders(v, values, hinweise));
  if (value && typeof value === "object") {
    const o: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value as Record<string, unknown>)) o[k] = applyPlaceholders(v, values, hinweise);
    return o;
  }
  return value;
}

/**
 * Befuellt Platzhalter aus dem Firmen-Kontext per Hintergrund-Modell.
 * Ein Aufruf je Node und Lauf (Cache liegt beim Aufrufer). Antwort: JSON
 * { "<name>": <Wert oder null> }. Zahlen als Zahl, wenn eindeutig; sonst
 * kurzer Klartext. Nichts erfinden.
 */
export async function resolvePlaceholdersWithLlm(
  providers: LlmProviderManager,
  contextText: string,
  refs: PlaceholderRef[],
  signal: AbortSignal,
): Promise<Record<string, unknown>> {
  if (refs.length === 0) return {};
  if (!providers.getStatus().ready) {
    throw new Error("Platzhalter brauchen ein Hintergrund-Modell (API-Schluessel oder lokales Modell).");
  }
  const system =
    "Du befuellst Platzhalter fuer einen automatisierten Vertriebs-Workflow aus dem Firmen-Kontext. " +
    "Die Platzhalter-Namen sind frei gewaehlt — ordne sie nach ihrer BEDEUTUNG dem passenden Inhalt im Kontext zu " +
    "(z. B. $kassenbestand → Kassenbestand/liquide Mittel aus dem juengsten Jahresabschluss; $ansprechpartner_vertrieb → " +
    "Person mit Vertriebsrolle; $umsatz → Umsatzerloese des juengsten Jahres). Regeln: NUR Werte aus dem Kontext, nichts erfinden; " +
    "fehlt ein Wert oder ist er unklar → null. Zahlen als Zahl (ohne Einheit) wenn eindeutig, sonst kurzer Klartext mit Einheit/Jahr. " +
    'Antworte NUR als JSON-Objekt: {"<name>": <Wert oder null>, ...}.';
  const user = `Platzhalter: ${refs.map((r) => `$${r.name}`).join(", ")}\n\n${contextText}`;
  const modelOverride = providers.getProducerModelOverride();
  for (let versuch = 0; versuch < 2; versuch++) {
    const raw = await streamToText(providers, buildMessages(system, user, "wf-placeholders"), {
      timeoutMs: 120_000,
      signal,
      ...(modelOverride ? { modelOverride } : {}),
    });
    const parsed = parseJsonObject(raw);
    if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
      const obj = parsed as Record<string, unknown>;
      const out: Record<string, unknown> = {};
      for (const r of refs) {
        const v = obj[r.name] ?? obj[`$${r.name}`];
        out[r.name] = v === undefined ? null : v;
      }
      return out;
    }
  }
  throw new Error("Platzhalter-Befuellung lieferte kein gueltiges JSON.");
}

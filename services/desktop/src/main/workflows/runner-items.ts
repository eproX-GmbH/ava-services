// W1 — Tool-Ergebnis → Items (electron-frei, damit testbar).

import type { WorkflowItem } from "../../shared/workflow-types";
import { OUTPUT_LIST_KEYS } from "./catalog";

/**
 * Tool-Ergebnis → Items: outputPath, sonst bekannte Listen-Schluessel, sonst
 * das einzige Array-Feld, sonst ein Item. `hinweise` (optional) bekommt
 * Diagnose-Zeilen, z. B. wenn ein outputPath ins Leere zeigt — vorher
 * kamen dann still 0 Items heraus ("Radar-Kandidaten laden: 0 Items").
 */
export function resultToItems(result: unknown, outputPath: string | undefined, pairedIndex: number, hinweise?: string[]): WorkflowItem[] {
  const wrap = (rows: unknown[]): WorkflowItem[] =>
    rows.map((r) => ({ json: r && typeof r === "object" && !Array.isArray(r) ? (r as Record<string, unknown>) : { value: r }, pairedItem: { item: pairedIndex } }));
  if (result == null) return [];
  if (Array.isArray(result)) return wrap(result);
  if (typeof result !== "object") return [{ json: { value: result }, pairedItem: { item: pairedIndex } }];
  const obj = result as Record<string, unknown>;
  const listenFelder = Object.entries(obj).filter(([, v]) => Array.isArray(v)).map(([k, v]) => `${k} (${(v as unknown[]).length})`);
  const beschreibung = (): string => `Ergebnis-Felder: ${Object.keys(obj).join(", ") || "keine"}${listenFelder.length ? ` · Listen: ${listenFelder.join(", ")}` : ""}`;
  if (outputPath) {
    const v = outputPath.split(".").reduce<unknown>((acc, k) => (acc && typeof acc === "object" ? (acc as Record<string, unknown>)[k] : undefined), obj);
    if (Array.isArray(v)) return wrap(v);
    if (v && typeof v === "object") return [{ json: v as Record<string, unknown>, pairedItem: { item: pairedIndex } }];
    hinweise?.push(`outputPath „${outputPath}“ nicht im Ergebnis gefunden — ${beschreibung()}; es wird auf die bekannte Liste zurueckgegriffen.`);
  }
  for (const k of OUTPUT_LIST_KEYS) {
    if (Array.isArray(obj[k])) {
      if ((obj[k] as unknown[]).length === 0) hinweise?.push(`Tool lieferte eine leere Liste „${k}“${typeof obj.hinweis === "string" ? ` — ${obj.hinweis}` : ""}.`);
      return wrap(obj[k] as unknown[]);
    }
  }
  const einzige = Object.entries(obj).filter(([, v]) => Array.isArray(v));
  if (einzige.length === 1) {
    hinweise?.push(`Liste unter „${einzige[0]![0]}“ verwendet (kein bekannter Listen-Schluessel).`);
    return wrap(einzige[0]![1] as unknown[]);
  }
  return [{ json: obj, pairedItem: { item: pairedIndex } }];
}


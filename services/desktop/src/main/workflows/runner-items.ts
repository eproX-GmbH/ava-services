// W1 — Tool-Ergebnis → Items (electron-frei, damit testbar).

import type { WorkflowItem } from "../../shared/workflow-types";
import { OUTPUT_LIST_KEYS } from "./catalog";

/** Tool-Ergebnis → Items: outputPath, sonst bekannte Listen-Schluessel, sonst ein Item. */
export function resultToItems(result: unknown, outputPath: string | undefined, pairedIndex: number): WorkflowItem[] {
  const wrap = (rows: unknown[]): WorkflowItem[] =>
    rows.map((r) => ({ json: r && typeof r === "object" && !Array.isArray(r) ? (r as Record<string, unknown>) : { value: r }, pairedItem: { item: pairedIndex } }));
  if (result == null) return [];
  if (Array.isArray(result)) return wrap(result);
  if (typeof result !== "object") return [{ json: { value: result }, pairedItem: { item: pairedIndex } }];
  const obj = result as Record<string, unknown>;
  if (outputPath) {
    const v = outputPath.split(".").reduce<unknown>((acc, k) => (acc && typeof acc === "object" ? (acc as Record<string, unknown>)[k] : undefined), obj);
    return Array.isArray(v) ? wrap(v) : v && typeof v === "object" ? [{ json: v as Record<string, unknown>, pairedItem: { item: pairedIndex } }] : [];
  }
  for (const k of OUTPUT_LIST_KEYS) {
    if (Array.isArray(obj[k])) return wrap(obj[k] as unknown[]);
  }
  return [{ json: obj, pairedItem: { item: pairedIndex } }];
}


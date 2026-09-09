// v0.1.614 — Freies Objekt fuer Tool-Schemata.
//
// defineTool.parseArgs validiert mit `stripUnknown: true`. Ein `yup.object()`
// OHNE Shape kennt keine Felder und verwirft dabei ALLE Schluessel — die
// Argumente kamen leer beim Tool an (Workflow-Parameter, HubSpot-/Notion-/
// Obsidian-Eigenschaften). `mixed` wird nicht gestrippt.

import * as yup from "yup";

export function freiesObjekt(): yup.MixedSchema<Record<string, unknown> | undefined> {
  return yup
    .mixed<Record<string, unknown>>()
    .test("objekt", "muss ein Objekt sein", (v) => v === undefined || v === null || (typeof v === "object" && !Array.isArray(v)));
}

import * as yup from "yup";
import type { Tool, ToolContext } from "./types";
import { normaliseToolArgs } from "./tool-arg-normalizer";

// Helper for declaring a tool from a yup schema + JSON Schema.
//
// Why both schemas: yup is the runtime gate (so we get clean error messages
// the model can react to), and the JSON Schema is what /api/chat's tools[]
// field consumes — Ollama's small models follow tool calls more reliably
// when they see a real schema in the system prompt instead of just a
// description string.
//
// We don't auto-derive JSON Schema from yup on purpose: the model-facing
// schema is documentation, and writing it by hand lets us include
// constraints (enum values, max length) the model actually uses.

export interface DefineToolArgs<TArgs, TResult> {
  name: string;
  description: string;
  /** v0.1.240 — Lazy-Tool-Loading teaser (≤ ~30 tokens). */
  summary?: string;
  /** v0.1.240 — Optional grouping bucket for `tool_search`. */
  category?: string;
  parameters: Record<string, unknown>;
  /** yup schema enforced before run(). Validation errors surface to the model. */
  schema: yup.Schema<TArgs>;
  run: (args: TArgs, ctx: ToolContext) => Promise<TResult>;
  /** Short, model-readable summary for the tool-result frame. */
  preview: (result: TResult) => string;
}

export function defineTool<TArgs, TResult>(
  spec: DefineToolArgs<TArgs, TResult>,
): Tool<TArgs, TResult> {
  return {
    name: spec.name,
    description: spec.description,
    ...(spec.summary !== undefined ? { summary: spec.summary } : {}),
    ...(spec.category !== undefined ? { category: spec.category } : {}),
    parameters: spec.parameters,
    parseArgs: (raw) => {
      // v0.1.227 — Zentrale Argument-Normalisierung VOR der Validierung.
      // Repariert die häufigsten LLM-Misformatierungen (JSON-Strings
      // statt Objects, Single-Values statt Arrays, "true"/"yes" statt
      // Boolean, etc.). Greift schweigend; bei Misserfolg fallen wir
      // auf den Original-Wert zurück und yup wirft normale Fehler.
      const { args: normalized, appliedFixes } = normaliseToolArgs(
        raw,
        spec.schema,
      );
      if (appliedFixes.length > 0) {
        console.info(
          `[tool:${spec.name}] arg-normalizer fixed: ${appliedFixes.join(", ")}`,
        );
      }
      try {
        return spec.schema.validateSync(normalized, {
          abortEarly: false,
          stripUnknown: true,
        });
      } catch (err) {
        if (err instanceof yup.ValidationError) {
          throw new Error(`invalid args: ${err.errors.join("; ")}`);
        }
        throw err;
      }
    },
    run: spec.run,
    preview: spec.preview,
  };
}

import * as yup from "yup";
import type { Tool, ToolContext } from "./types";

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
    parameters: spec.parameters,
    parseArgs: (raw) => {
      try {
        return spec.schema.validateSync(raw, {
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

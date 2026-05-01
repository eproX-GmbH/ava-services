import * as yup from "yup";
import { defineTool } from "../define-tool";
import type { Tool } from "../types";
import type { GeneralMemoryStore } from "../general-memory";

// Memory tools (Phase 8.k10h).
//
// Two tools the agent can call against the long-lived general-memory
// store (see ../general-memory.ts). Per-conversation transcripts are
// already in context — these tools are only for facts the user has
// asked the agent to remember across sessions.
//
// Why two tools rather than one merged "memory" tool with an "action"
// arg: small models pick the right tool faster when each tool's job
// fits in its name + description, and JSON-schema validation gives us
// per-tool arg shapes for free. Yields better tool-call accuracy on
// qwen2.5:3b, which is now the local default.

export function buildMemoryTools(deps: {
  generalMemory: GeneralMemoryStore;
}): Tool[] {
  const recall = defineTool({
    name: "recall_memory",
    description:
      "Look up long-term memory the user has asked you to remember across conversations (preferences, facts about them, ongoing tasks). Call this proactively at the start of a turn when the user's question hints at prior context (\"as I mentioned\", \"remember the …\", or anything pronoun-heavy without an antecedent in this conversation). Returns matching entries newest-first; an empty `query` returns recent entries.",
    parameters: {
      type: "object",
      properties: {
        query: {
          type: "string",
          description:
            "Substring or keyword to filter entries by (matches content + tags, case-insensitive). Leave empty to list recent entries.",
        },
        limit: {
          type: "integer",
          minimum: 1,
          maximum: 50,
          description: "Max entries to return. Default 10.",
        },
      },
    },
    schema: yup
      .object({
        query: yup.string().optional(),
        limit: yup.number().integer().min(1).max(50).optional(),
      })
      .noUnknown(true),
    preview: (r: { count: number; query: string }) =>
      r.query
        ? `recall("${r.query}") → ${r.count} match${r.count === 1 ? "" : "es"}`
        : `recall recent → ${r.count} entr${r.count === 1 ? "y" : "ies"}`,
    run: async (args) => {
      const limit = args.limit ?? 10;
      const entries = deps.generalMemory.search(args.query ?? "", limit);
      return {
        count: entries.length,
        query: args.query ?? "",
        entries: entries.map((e) => ({
          id: e.id,
          content: e.content,
          tags: e.tags ?? [],
          createdAt: new Date(e.createdAt).toISOString(),
        })),
      };
    },
  });

  const remember = defineTool({
    name: "remember",
    description:
      "Save a fact, preference, or note to long-term memory so you can recall it in future conversations. Use this when the user explicitly asks (\"remember that …\", \"keep this in mind\") OR when they share a stable preference you'd want to honour next time (preferred language, role, recurring company they care about). Do NOT save volatile per-conversation context — that's already in transcript memory.",
    parameters: {
      type: "object",
      required: ["content"],
      properties: {
        content: {
          type: "string",
          minLength: 1,
          description:
            "The fact to remember, written as a self-contained sentence. Future-you will read this without conversation context, so don't say \"the company we just discussed\" — name it.",
        },
        tags: {
          type: "array",
          items: { type: "string" },
          description:
            "Optional short tags for grouping (e.g. \"preference\", \"company:acme\"). Lowercase, no spaces.",
        },
      },
    },
    schema: yup
      .object({
        content: yup.string().required().min(1),
        tags: yup.array().of(yup.string().required()).optional(),
      })
      .noUnknown(true),
    preview: (r: { content: string }) => {
      const snippet =
        r.content.length > 60 ? r.content.slice(0, 57) + "…" : r.content;
      return `remembered: ${snippet}`;
    },
    run: async (args) => {
      const entry = deps.generalMemory.add({
        content: args.content,
        ...(args.tags ? { tags: args.tags } : {}),
      });
      return {
        id: entry.id,
        content: entry.content,
        tags: entry.tags ?? [],
      };
    },
  });

  const forget = defineTool({
    name: "forget_memory",
    description:
      "Delete a long-term memory entry by id. Get the id from `recall_memory` first — the user usually says \"vergiss [thing]\" or \"lösche, dass …\", and you should look up the matching entry, confirm with the user that you've found the right one (single-shot `ask_user_choice` with Ja/Nein when there's any ambiguity), and only then call this. Irreversible.",
    parameters: {
      type: "object",
      required: ["id"],
      properties: {
        id: {
          type: "string",
          description: "Entry id from `recall_memory[].entries[].id`.",
        },
      },
    },
    schema: yup.object({ id: yup.string().required().min(1) }).noUnknown(true),
    preview: (r: { ok: boolean; id: string }) =>
      r.ok ? `forgot ${r.id.slice(0, 8)}…` : "entry not found",
    run: async (args) => {
      const ok = deps.generalMemory.remove(args.id);
      return { ok, id: args.id };
    },
  });

  return [recall, remember, forget];
}

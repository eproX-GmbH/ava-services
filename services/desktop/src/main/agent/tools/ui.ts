import * as yup from "yup";
import { defineTool } from "../define-tool";
import type { Tool } from "../types";

// UI tools (Phase 8.c).
//
// These don't hit the gateway — they roundtrip into the renderer (askUser
// pauses for input, navigate routes the SPA, notify shows a native popup).
// All three use the per-request UiBridge on `ctx.ui`.

export function buildUiTools(): Tool[] {
  const askUser = defineTool({
    name: "ask_user_choice",
    description:
      "Ask the user to pick one option. Use when a search returns multiple plausible matches and you cannot reasonably guess. Returns the picked option's `value` string.",
    parameters: {
      type: "object",
      properties: {
        prompt: {
          type: "string",
          description: "Short question shown above the buttons.",
        },
        options: {
          type: "array",
          minItems: 2,
          maxItems: 8,
          description: "Choices the user can pick from.",
          items: {
            type: "object",
            required: ["value", "label"],
            properties: {
              value: {
                type: "string",
                description:
                  "Stable token returned to the agent (e.g. companyId).",
              },
              label: {
                type: "string",
                description: "Human-readable button text.",
              },
              description: {
                type: "string",
                description: "Optional secondary text under the label.",
              },
            },
          },
        },
      },
      required: ["prompt", "options"],
    },
    schema: yup.object({
      prompt: yup.string().trim().min(1).required(),
      options: yup
        .array()
        .of(
          yup
            .object({
              value: yup.string().trim().min(1).required(),
              label: yup.string().trim().min(1).required(),
              description: yup.string().trim().optional(),
            })
            .required(),
        )
        .min(2)
        .max(8)
        .required(),
    }),
    run: async (args, ctx) => {
      const value = await ctx.ui.askChoice(
        args.prompt,
        args.options as { value: string; label: string; description?: string }[],
        ctx.signal,
      );
      return { value };
    },
    preview: (r) => `picked: ${r.value}`,
  });

  const navigate = defineTool({
    name: "navigate",
    description:
      "Switch the renderer to another route. Paths are SPA-relative, e.g. `/companies/<id>`, `/transactions`, `/chat`. Use AFTER fetching data so the user lands on a populated view.",
    parameters: {
      type: "object",
      properties: {
        path: {
          type: "string",
          description: "SPA path beginning with `/`.",
        },
      },
      required: ["path"],
    },
    schema: yup.object({
      path: yup
        .string()
        .trim()
        .matches(/^\//, "must start with /")
        .min(1)
        .required(),
    }),
    run: async (args, ctx) => {
      ctx.ui.navigate(args.path);
      return { ok: true, path: args.path };
    },
    preview: (r) => `navigated to ${r.path}`,
  });

  const notify = defineTool({
    name: "notify",
    description:
      "Show a native OS notification. Use sparingly — only for events the user genuinely wants pushed (e.g. 'transaction X finished'). Do not use for chat replies.",
    parameters: {
      type: "object",
      properties: {
        title: { type: "string", description: "Bold first line." },
        body: { type: "string", description: "One short sentence." },
      },
      required: ["title", "body"],
    },
    schema: yup.object({
      title: yup.string().trim().min(1).max(100).required(),
      body: yup.string().trim().min(1).max(300).required(),
    }),
    run: async (args, ctx) => {
      ctx.ui.notify(args.title, args.body);
      return { ok: true };
    },
    preview: () => "notification sent",
  });

  return [askUser, navigate, notify];
}

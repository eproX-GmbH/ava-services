import * as yup from "yup";
import { defineTool, userDeclined } from "../define-tool";
import type { Tool } from "../types";
import type { WatchStore } from "../watch-store";
import type {
  AlertKind,
  Watch,
  WatchCadence,
  WatchTrigger,
} from "../../../shared/types";

// Watch self-service tools (Phase 8.t2).
//
// Five tools, one shape: register / list / remove / pause / resume.
// `register` is the only one that goes through propose-and-confirm
// (mirror of `profile_propose_update`): translates the user's
// natural-language phrasing into a `WatchTrigger`, shows the draft via
// `ask_user_choice`, persists on confirm. The other four are direct
// reads / explicit destructive ops where a confirm gate would feel
// ceremonial.
//
// Cadence enum is locked to daily / weekly / monthly. Anything more
// granular invites scheduling complexity (alignment, timezones, "every
// Tuesday") that v1 doesn't need. The watcher executor evaluates
// `≥ N hours since lastCheckedAt` and that's it.

const CADENCE_VALUES: readonly WatchCadence[] = ["daily", "weekly", "monthly"];

const ALERT_KINDS: readonly AlertKind[] = [
  "publication",
  "financial-delta",
  "profile-change",
  "evaluation-flag",
];

export interface WatchesToolDeps {
  store: WatchStore;
  /** Fired after every successful mutation so the renderer's chip +
   *  Settings panel re-sync. */
  onChanged: () => void;
}

export function buildWatchesTools(deps: WatchesToolDeps): Tool[] {
  const list = defineTool({
    name: "watch_list",
    description:
      "List the user's standing watches (newest first) with id, prompt, cadence, trigger scope, last-checked timestamp, and active state. Use when the user asks 'was beobachtest du gerade für mich' / 'welche Watches sind aktiv'. Always returns the count + cap so the agent can warn the user when they're near the limit.",
    parameters: { type: "object", properties: {} },
    schema: yup.object({}).noUnknown(true),
    preview: (r: { count: number; cap: number }) =>
      `${r.count} / ${r.cap} active watches`,
    run: async () => {
      const all = deps.store.list();
      const active = all.filter((w) => w.enabled).length;
      return {
        count: active,
        cap: deps.store.cap(),
        items: all.map((w) => ({
          id: w.id,
          prompt: w.prompt,
          cadence: w.cadence,
          trigger: w.trigger,
          enabled: w.enabled,
          createdAt: w.createdAt,
          lastCheckedAt: w.lastCheckedAt,
          hits: w.hits.length,
        })),
      };
    },
  });

  const register = defineTool({
    name: "watch_register",
    description:
      "Register a new standing watch. Translate the user's natural-language phrasing into a `trigger.rubric` (a German one-line criterion the LLM judge will evaluate against future candidates) plus optional `companyIds` / `topics` scoping. ALWAYS go through propose-and-confirm: the tool itself shows the draft via `ask_user_choice` and only persists on user confirm. Cap is 20 active watches; the tool refuses past that with a German message the user can read verbatim. After a successful register, the next heartbeat tick (or the next `alerts_trigger_heartbeat` call) will start evaluating the rubric.\n\nWhen the user names a specific company ('schau auf ACME'), resolve the companyId via `company_search` first and pass it in `companyIds`. When the user names a clear data type ('nur Publikationen'), pass it in `topics`. When the user is generic ('immer wenn etwas Wichtiges passiert'), leave both empty — the rubric carries the meaning.",
    parameters: {
      type: "object",
      required: ["prompt", "cadence", "rubric"],
      properties: {
        prompt: {
          type: "string",
          description:
            "The user's verbatim phrasing (or your best paraphrase if they were vague). Stored for display + audit.",
        },
        cadence: {
          type: "string",
          enum: ["daily", "weekly", "monthly"],
          description:
            "How often the watch evaluates. Default to 'weekly' when the user didn't say.",
        },
        rubric: {
          type: "string",
          description:
            "German one-line criterion. Concrete and observable (e.g. 'Wechsel auf C-Level (Geschäftsführung, Vorstand)'). Avoid vague phrases like 'wichtige Sachen'.",
        },
        companyIds: {
          type: "array",
          items: { type: "string" },
          description:
            "Optional: only evaluate candidates for these companies. Resolve via `company_search` first.",
        },
        topics: {
          type: "array",
          items: { type: "string", enum: ALERT_KINDS as unknown as string[] },
          description:
            "Optional: only evaluate candidates whose kind matches one of these. The four kinds are publication, financial-delta, profile-change, evaluation-flag.",
        },
      },
    },
    schema: yup
      .object({
        prompt: yup.string().trim().min(1).max(500).required(),
        cadence: yup.string().oneOf(CADENCE_VALUES).required(),
        rubric: yup.string().trim().min(1).max(500).required(),
        companyIds: yup
          .array()
          .of(yup.string().required().min(1))
          .optional(),
        topics: yup
          .array()
          .of(yup.string().oneOf(ALERT_KINDS).required())
          .optional(),
      })
      .noUnknown(true),
    preview: (r: { applied: boolean; activeCount?: number }) =>
      r.applied
        ? `watch registered (${r.activeCount} active)`
        : "watch declined",
    run: async (args, ctx) => {
      // Build a draft preview the user can read verbatim before persistence.
      const trigger: WatchTrigger = {
        rubric: args.rubric,
        ...(args.companyIds && args.companyIds.length > 0
          ? { companyIds: args.companyIds }
          : {}),
        ...(args.topics && args.topics.length > 0
          ? { topics: args.topics as AlertKind[] }
          : {}),
      };
      const draft = renderWatchDraft({
        prompt: args.prompt,
        cadence: args.cadence as WatchCadence,
        trigger,
      });
      const value = await ctx.ui.askChoice(
        `Ich würde folgenden Watch einrichten:\n\n${draft}\n\nSoll ich starten?`,
        [
          {
            value: "accept",
            label: "Ja, einrichten",
            description: "Watch wird ab dem nächsten Heartbeat-Tick geprüft",
          },
          {
            value: "decline",
            label: "Verwerfen",
            description: "Nichts persistieren",
          },
        ],
        ctx.signal,
      );
      if (value !== "accept") return userDeclined();
      try {
        const row = deps.store.add({
          prompt: args.prompt,
          trigger,
          cadence: args.cadence as WatchCadence,
        });
        deps.onChanged();
        return {
          applied: true,
          watchId: row.id,
          activeCount: deps.store.activeCount(),
          cap: deps.store.cap(),
        };
      } catch (err) {
        // Cap-hit gets the user-readable message verbatim.
        return {
          applied: false,
          error: err instanceof Error ? err.message : String(err),
        };
      }
    },
  });

  const remove = defineTool({
    name: "watch_remove",
    description:
      "Delete a watch by id. Idempotent — removing an unknown id reports `wasFound: false` cleanly. Use when the user says 'lösche den ACME-Watch'. Get the id via `watch_list` first if the user named the watch by topic, not by id.",
    parameters: {
      type: "object",
      required: ["id"],
      properties: {
        id: { type: "string", description: "Watch id from watch_list[].id." },
      },
    },
    schema: yup
      .object({ id: yup.string().required().min(1) })
      .noUnknown(true),
    preview: (r: { wasFound: boolean }) =>
      r.wasFound ? "watch removed" : "watch not found",
    run: async (args) => {
      const wasFound = deps.store.remove(args.id);
      if (wasFound) deps.onChanged();
      return { wasFound };
    },
  });

  const pause = defineTool({
    name: "watch_pause",
    description:
      "Disable a watch (`enabled: false`) without deleting it. The executor skips paused watches; resume with `watch_resume`. Use when the user says 'pausiere den ACME-Watch'.",
    parameters: {
      type: "object",
      required: ["id"],
      properties: { id: { type: "string" } },
    },
    schema: yup
      .object({ id: yup.string().required().min(1) })
      .noUnknown(true),
    preview: (r: { ok: boolean }) => (r.ok ? "watch paused" : "watch not found"),
    run: async (args) => {
      const ok = deps.store.setEnabled(args.id, false);
      if (ok) deps.onChanged();
      return { ok };
    },
  });

  const resume = defineTool({
    name: "watch_resume",
    description:
      "Re-enable a paused watch (`enabled: true`). Use when the user says 'aktiviere den ACME-Watch wieder' / 'resume X'. Refuses with the cap message if re-activating would push past the active limit.",
    parameters: {
      type: "object",
      required: ["id"],
      properties: { id: { type: "string" } },
    },
    schema: yup
      .object({ id: yup.string().required().min(1) })
      .noUnknown(true),
    preview: (r: { ok: boolean }) =>
      r.ok ? "watch resumed" : "watch not resumed",
    run: async (args) => {
      // Cap check on resume (a paused watch over the cap could otherwise
      // sneak past via repeated pause/resume).
      const all = deps.store.list();
      const target = all.find((w) => w.id === args.id);
      if (!target) return { ok: false, error: "Watch nicht gefunden." };
      if (target.enabled) return { ok: true };
      const active = all.filter((w) => w.enabled).length;
      if (active >= deps.store.cap()) {
        return {
          ok: false,
          error: `Maximal ${deps.store.cap()} aktive Watches; bitte zuerst einen entfernen oder pausieren.`,
        };
      }
      const ok = deps.store.setEnabled(args.id, true);
      if (ok) deps.onChanged();
      return { ok };
    },
  });

  return [list, register, remove, pause, resume];
}

// ---- Helpers --------------------------------------------------------------

function renderWatchDraft(input: {
  prompt: string;
  cadence: WatchCadence;
  trigger: WatchTrigger;
}): string {
  const lines: string[] = [];
  lines.push(`  Anliegen:  ${input.prompt}`);
  lines.push(`  Rubrik:    ${input.trigger.rubric}`);
  lines.push(`  Frequenz:  ${cadenceLabel(input.cadence)}`);
  if (input.trigger.companyIds && input.trigger.companyIds.length > 0) {
    lines.push(
      `  Firmen:    ${input.trigger.companyIds.length} ausgewählte`,
    );
  } else {
    lines.push(`  Firmen:    alle (kein Filter)`);
  }
  if (input.trigger.topics && input.trigger.topics.length > 0) {
    lines.push(`  Datentyp:  ${input.trigger.topics.join(", ")}`);
  } else {
    lines.push(`  Datentyp:  alle`);
  }
  return lines.join("\n");
}

function cadenceLabel(c: WatchCadence): string {
  switch (c) {
    case "daily":
      return "täglich";
    case "weekly":
      return "wöchentlich";
    case "monthly":
      return "monatlich";
  }
}

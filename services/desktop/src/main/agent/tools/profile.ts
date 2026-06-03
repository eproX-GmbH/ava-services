import * as yup from "yup";
import { defineTool, userDeclined } from "../define-tool";
import type { Tool } from "../types";
import type { UserProfileStore } from "../profile-store";
import type {
  UserProfile,
  UserProfileTone,
} from "../../../shared/types";

// User-profile tools (Phase 8.t1).
//
// Four tools, two execution modes:
//
//   - `profile_get`         — read.
//   - `profile_set`         — direct write. Used for EXPLICIT user
//                             requests ("update my bio to …") and
//                             the first-run nudge response (where
//                             the user is responding to the agent's
//                             explicit ask).
//   - `profile_propose_update` — propose-and-confirm. Used for
//                             AGENT-INFERRED updates from observed
//                             conversation. Renders an
//                             ask_user_choice card with the proposed
//                             patch verbatim; on confirm calls
//                             profile_set internally. Prevents the
//                             agent from silently editing the user's
//                             lens.
//   - `profile_clear`        — destructive reset.
//
// The propose-and-confirm rule is enforced in two places:
//   1. The system prompt has a hard "no silent edits" clause.
//   2. The agent has the `propose` tool to make the right thing easy.

const TONE_VALUES: readonly UserProfileTone[] = [
  "neutral",
  "knapp",
  "ausführlich",
];

export interface ProfileToolDeps {
  store: UserProfileStore;
  /** Fired after every successful write so the renderer's Settings
   *  panel resyncs without polling. */
  onChanged: () => void;
}

export function buildProfileTools(deps: ProfileToolDeps): Tool[] {
  const get = defineTool({
    name: "profile_get",
    description:
      "Read the user's stored profile (bio, role, industries, geographies, topics, tone, skip flag). Call before `profile_propose_update` if you're unsure what's already known. Empty profile returns the default shape with empty fields.",
    parameters: { type: "object", properties: {} },
    schema: yup.object({}).noUnknown(true),
    preview: (r: UserProfile) =>
      r.bio
        ? `profile · ${r.bio.length} char bio · ${r.industries.length} industries`
        : r.profileSkipped
          ? "profile · skipped"
          : "profile · empty",
    run: async () => deps.store.get(),
  });

  const set = defineTool({
    name: "profile_set",
    description:
      "Direct write to the user profile. Only call when the user EXPLICITLY asked ('update my bio to …', 'I work at X now', 'set my tone to knapp') OR when the user is responding to the first-run nudge. For AGENT-INFERRED updates use `profile_propose_update` instead — the user must confirm what you observed before it persists. Pass only the fields that should change; everything else stays.",
    parameters: {
      type: "object",
      properties: {
        bio: {
          type: "string",
          description:
            "Free-text 2-3 sentences describing the user's context. Capped at 300 chars upstream.",
        },
        role: {
          // v0.1.187 — single string type (Gemini rejects union types
          // like ["string", "null"] in function declarations). Pass
          // empty string to clear; omit the field for "no change".
          type: "string",
          description:
            "Job role / function (e.g. 'B2B-Vertrieb', 'Investment-Analyst'). Pass empty string to clear; omit to leave unchanged.",
        },
        industries: {
          type: "array",
          items: { type: "string" },
          description:
            "Industries the user focuses on. ≤12 entries; deduped case-insensitively.",
        },
        geographies: {
          type: "array",
          items: { type: "string" },
          description:
            "Regions the user focuses on (e.g. 'Bayern', 'DACH').",
        },
        topics: {
          type: "array",
          items: { type: "string" },
          description:
            "Recurring topics the user cares about ('Geschäftsführer-Wechsel', 'M&A', 'Finanzkennzahlen').",
        },
        tone: {
          // v0.1.187 — Google Gemini's function-declaration validator
          // rejects `enum` on union types like `["string", "null"]`
          // ("enum: only allowed for STRING type"). We drop the
          // explicit nullable union here and keep the field as a
          // plain enum of strings — the property is optional anyway,
          // so the model expresses "no preference" by omitting the
          // field rather than by passing null. The yup schema below
          // still accepts null for back-compat when callers pass it.
          type: "string",
          enum: ["neutral", "knapp", "ausführlich"],
          description:
            "How verbose the agent should be. Omit the field for 'no preference / default behaviour'.",
        },
        profileSkipped: {
          type: "boolean",
          description:
            "Set true when the user declined the first-run nudge. Sticky — prevents re-prompting unless the user explicitly says 'lass uns mein Profil mal aktualisieren'.",
        },
      },
    },
    schema: yup
      .object({
        bio: yup.string().optional(),
        role: yup.string().nullable().optional(),
        industries: yup.array().of(yup.string().required()).optional(),
        geographies: yup.array().of(yup.string().required()).optional(),
        topics: yup.array().of(yup.string().required()).optional(),
        tone: yup
          .string()
          .oneOf([...TONE_VALUES])
          .nullable()
          .optional(),
        profileSkipped: yup.boolean().optional(),
      })
      .noUnknown(true),
    preview: (r: UserProfile) =>
      r.profileSkipped
        ? "profile skipped"
        : `profile updated · ${r.bio.length} char bio`,
    run: async (args) => {
      const next = deps.store.set(args as Partial<UserProfile>);
      deps.onChanged();
      return next;
    },
  });

  const proposeUpdate = defineTool({
    name: "profile_propose_update",
    description:
      "Propose-and-confirm path for AGENT-INFERRED profile updates. Use when you've observed stable signals across the conversation ('user mentioned they work in Vertrieb' + 'they focus on Bayern' + 'they care about Geschäftsführer-Wechsel'). Renders an ask_user_choice card showing the proposed patch verbatim; user confirms → applied. NEVER use this to write silently — the gate is the whole point. Call `ask_user_choice` separately yourself if you want the user to confirm a more nuanced wording. Skip if the user already explicitly told you the same thing in the SAME conversation (use `profile_set` directly).",
    parameters: {
      type: "object",
      required: ["patch", "reason"],
      properties: {
        patch: {
          type: "object",
          description:
            "The fields you'd like to set. Same shape as `profile_set`.",
          properties: {
            bio: { type: "string" },
            // v0.1.187 — single string type for Gemini compat.
            // Empty string clears; omit for "no change".
            role: { type: "string" },
            industries: { type: "array", items: { type: "string" } },
            geographies: { type: "array", items: { type: "string" } },
            topics: { type: "array", items: { type: "string" } },
            tone: {
              // v0.1.187 — see profile_set.tone above. Plain string
              // enum so Google Gemini accepts the schema; omit the
              // field for "no change".
              type: "string",
              enum: ["neutral", "knapp", "ausführlich"],
            },
          },
        },
        reason: {
          type: "string",
          description:
            "One-sentence German justification surfaced to the user above the choice card ('Ich habe aus dem Gespräch geschlossen, dass …'). Keep it concrete and brief.",
        },
      },
    },
    schema: yup
      .object({
        patch: yup
          .object({
            bio: yup.string().optional(),
            role: yup.string().nullable().optional(),
            industries: yup.array().of(yup.string().required()).optional(),
            geographies: yup.array().of(yup.string().required()).optional(),
            topics: yup.array().of(yup.string().required()).optional(),
            tone: yup
              .string()
              .oneOf([...TONE_VALUES])
              .nullable()
              .optional(),
          })
          .noUnknown(true)
          .required(),
        reason: yup.string().trim().min(1).max(300).required(),
      })
      .noUnknown(true),
    preview: (r: { applied: boolean }) =>
      r.applied ? "profile patch applied" : "profile patch declined",
    run: async (args, ctx) => {
      const summary = renderPatch(args.patch);
      const prompt = `${args.reason}\n\nVorschlag:\n${summary}`;
      const value = await ctx.ui.askChoice(
        prompt,
        [
          {
            value: "accept",
            label: "Übernehmen",
            description: "In das Profil schreiben",
          },
          {
            value: "decline",
            label: "Verwerfen",
            description: "Nicht ins Profil aufnehmen",
          },
        ],
        ctx.signal,
      );
      if (value !== "accept") {
        return userDeclined();
      }
      const next = deps.store.set(args.patch as Partial<UserProfile>);
      deps.onChanged();
      return { applied: true, profile: next };
    },
  });

  const clear = defineTool({
    name: "profile_clear",
    description:
      "Wipe the profile back to defaults. Use when the user explicitly says 'vergiss, was du über mich weißt', 'profil zurücksetzen', 'forget my profile'. Destructive; no propose-and-confirm gate (the user already explicitly asked).",
    parameters: { type: "object", properties: {} },
    schema: yup.object({}).noUnknown(true),
    preview: () => "profile cleared",
    run: async () => {
      const next = deps.store.clear();
      deps.onChanged();
      return next;
    },
  });

  return [get, set, proposeUpdate, clear];
}

// ---- Helpers --------------------------------------------------------------

function renderPatch(patch: Record<string, unknown>): string {
  const lines: string[] = [];
  if (typeof patch.bio === "string" && patch.bio.trim()) {
    lines.push(`  Bio: ${patch.bio.trim()}`);
  }
  if (typeof patch.role === "string" && patch.role.trim()) {
    lines.push(`  Rolle: ${patch.role.trim()}`);
  } else if (patch.role === null) {
    lines.push(`  Rolle: (entfernen)`);
  }
  if (Array.isArray(patch.industries) && patch.industries.length > 0) {
    lines.push(`  Branchen: ${patch.industries.join(", ")}`);
  }
  if (Array.isArray(patch.geographies) && patch.geographies.length > 0) {
    lines.push(`  Regionen: ${patch.geographies.join(", ")}`);
  }
  if (Array.isArray(patch.topics) && patch.topics.length > 0) {
    lines.push(`  Schwerpunktthemen: ${patch.topics.join(", ")}`);
  }
  if (typeof patch.tone === "string" && patch.tone) {
    lines.push(`  Bevorzugter Ton: ${patch.tone}`);
  } else if (patch.tone === null) {
    lines.push(`  Bevorzugter Ton: (zurücksetzen)`);
  }
  return lines.length > 0 ? lines.join("\n") : "  (keine Felder)";
}

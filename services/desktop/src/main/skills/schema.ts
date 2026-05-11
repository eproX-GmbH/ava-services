// S1 — Skills frontmatter validation schema.
//
// Mirrors PLANS.md §2.3 narrowed by §2.4 guardrails:
//   - b2b-scope is REQUIRED and must be one of the five enum values
//     (§2.4 rule 1). Anything else → reject at load time.
//   - allowed-tools defaults to [] — an empty list means "pure prose
//     skill; NO tools fire" (§2.4 rule 2).
//   - metadata.ava.requires is parsed but NOT enforced in S1; the
//     loader logs a German "[skills] gate not satisfied: …" and
//     skip-loads. Real gate evaluation lands when S2 wires the agent.

import * as yup from "yup";

export const B2B_SCOPES = [
  "outreach",
  "qualifying",
  "competitive",
  "data-extraction",
  "internal",
] as const;

export type B2bScope = (typeof B2B_SCOPES)[number];

export const LANGUAGES = ["de", "en"] as const;
export type SkillLanguage = (typeof LANGUAGES)[number];

export interface SkillArgument {
  name: string;
  description: string;
  required: boolean;
}

export interface SkillMetadataAvaRequires {
  crm?: string;
  ollama?: string;
  tier?: string;
  [key: string]: string | undefined;
}

export interface SkillMetadata {
  ava?: {
    requires?: SkillMetadataAvaRequires;
  };
}

export interface SkillFrontmatter {
  name: string;
  description: string;
  language: SkillLanguage;
  "b2b-scope": B2bScope;
  "allowed-tools": string[];
  "requires-user-confirm": boolean;
  "disable-model-invocation": boolean;
  "user-invocable": boolean;
  arguments: SkillArgument[];
  metadata?: SkillMetadata;
}

// kebab-case validator: lowercase letters, digits and dashes; must start
// with a letter; no consecutive dashes; no trailing dash. Matches the
// names users see in `/skill-name`.
const KEBAB = /^[a-z][a-z0-9]*(?:-[a-z0-9]+)*$/;

const argumentSchema: yup.ObjectSchema<SkillArgument> = yup
  .object({
    name: yup
      .string()
      .required("Feld 'name' fehlt in einem Argument")
      .matches(KEBAB, "Argumentname muss in kebab-case sein"),
    description: yup
      .string()
      .required("Feld 'description' fehlt in einem Argument"),
    required: yup.boolean().default(false),
  })
  .noUnknown();

const requiresSchema = yup
  .object({
    crm: yup.string().optional(),
    ollama: yup.string().optional(),
    tier: yup.string().optional(),
  })
  .noUnknown(false); // allow forward-compatible extra keys

const metadataSchema = yup
  .object({
    ava: yup
      .object({
        requires: requiresSchema.optional(),
      })
      .optional(),
  })
  .noUnknown(false);

// We let yup infer the schema type rather than declaring it as
// `ObjectSchema<SkillFrontmatter>` — yup's array-with-default typing
// (`__default: "d"`) doesn't line up cleanly with the explicit
// `string[]` / `SkillArgument[]` fields, and forcing the shape with
// casts triggers `noUncheckedIndexedAccess` complaints. The runtime
// behaviour is the right one; consumers should use `ValidatedFrontmatter`
// (yup.InferType) instead of `SkillFrontmatter` directly when they
// need the post-validation shape.
export const frontmatterSchema = yup
  .object({
    name: yup
      .string()
      .required(
        "Feld 'name' fehlt — jedes Skill braucht einen eindeutigen Bezeichner",
      )
      .matches(
        KEBAB,
        "Feld 'name' muss in kebab-case sein (z. B. 'outreach-draft')",
      ),
    description: yup
      .string()
      .required(
        "Feld 'description' fehlt — der Agent nutzt es zur Aktivierung",
      )
      .min(1, "Feld 'description' darf nicht leer sein"),
    language: yup
      .mixed<SkillLanguage>()
      .oneOf(
        LANGUAGES as unknown as SkillLanguage[],
        "Feld 'language' muss 'de' oder 'en' sein",
      )
      .default("de"),
    "b2b-scope": yup
      .mixed<B2bScope>()
      .oneOf(
        B2B_SCOPES as unknown as B2bScope[],
        `Feld 'b2b-scope' fehlt oder ist ungültig (erlaubt: ${B2B_SCOPES.join(", ")})`,
      )
      .required(
        `Feld 'b2b-scope' fehlt oder ist ungültig (erlaubt: ${B2B_SCOPES.join(", ")})`,
      ),
    "allowed-tools": yup.array().of(yup.string().required()).default([]),
    "requires-user-confirm": yup.boolean().default(true),
    "disable-model-invocation": yup.boolean().default(false),
    "user-invocable": yup.boolean().default(true),
    arguments: yup.array().of(argumentSchema).default([]),
    metadata: metadataSchema.optional(),
  })
  .noUnknown(false);

export type ValidatedFrontmatter = yup.InferType<typeof frontmatterSchema>;

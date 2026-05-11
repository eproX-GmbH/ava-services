// S1 — Skill discovery + load pipeline.
//
// Scans the per-user and workspace skills directories for
// `<dir>/<name>/SKILL.md`, parses + validates each, hashes the raw
// contents, and returns LoadedSkill records. Validation failures and
// unsatisfied metadata gates are logged in German and silently
// skipped (per PLANS.md §2.5).

import { createHash } from "node:crypto";
import { existsSync, readFileSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";
import { parseSkillFile, SkillParseError } from "./parser";
import { denyAllGates, type GateEvaluator } from "./gate";
import {
  frontmatterSchema,
  type B2bScope,
  type SkillArgument,
  type SkillLanguage,
  type SkillMetadata,
} from "./schema";

export type SkillScope = "user" | "workspace";

/**
 * S4 — Trust state. Drives the orchestrator gate (only `"trusted"`
 * skills auto-activate or fire on /name) and the Settings → Skills
 * row banner that prompts re-confirmation.
 *
 *  - "trusted":   on-disk hash matches the stored trust entry.
 *  - "untrusted": first-seen skill with no trust-store entry.
 *  - "modified":  trust entry exists but the on-disk hash differs.
 */
export type SkillTrust = "trusted" | "untrusted" | "modified";

export interface LoadedSkill {
  id: string;
  name: string;
  description: string;
  language: SkillLanguage;
  b2bScope: B2bScope;
  allowedTools: string[];
  requiresUserConfirm: boolean;
  disableModelInvocation: boolean;
  userInvocable: boolean;
  arguments: SkillArgument[];
  metadata: SkillMetadata;
  body: string;
  hash: string;
  sourcePath: string;
  scope: SkillScope;
  /** S3 — gate evaluation result. Gate-failing skills are still loaded
   *  but flagged unavailable so the Settings UI can show a reason
   *  instead of hiding the skill. The orchestrator must check this
   *  flag before letting the skill auto-activate or fire on `/name`. */
  gateSatisfied: boolean;
  /** German one-liner when `gateSatisfied === false`, e.g.
   *  "HubSpot ist nicht verbunden". Null when satisfied. */
  gateReason: string | null;
  /** S4 — trust state vs. the user's trust store. The orchestrator
   *  refuses to auto-activate or `/name`-invoke anything that isn't
   *  `"trusted"`. Always `"trusted"` if no trust evaluator was
   *  provided to the loader (back-compat for tests). */
  trust: SkillTrust;
  /** S4 — when `trust === "modified"`, the list of allowed-tools the
   *  user previously approved. Lets the trust dialog diff against
   *  the new on-disk list. Empty array when no diff available. */
  previouslyTrustedAllowedTools: string[];
}

export interface LoadOptions {
  userDir: string | null;
  workspaceDir: string | null;
  /** S2 — gate evaluator. Skills whose `metadata.ava.requires` block is
   *  unsatisfied are skipped silently (German log). Defaults to
   *  `denyAllGates` (any requires-entry → skip), matching S1 behaviour. */
  evaluateGate?: GateEvaluator;
  /** S4 — trust evaluator. When omitted, all skills get
   *  `trust: "trusted"` (back-compat for S1/S2/S3 test scripts). */
  evaluateTrust?: TrustEvaluator;
}

export interface TrustEvaluation {
  trust: SkillTrust;
  /** When `trust === "modified"`, the prior approved tool list. */
  previouslyTrustedAllowedTools: string[];
}

export type TrustEvaluator = (
  name: string,
  hash: string,
) => TrustEvaluation;

export interface LoadResult {
  skills: LoadedSkill[];
  errors: Array<{ path: string; message: string }>;
}

function sha256(input: string): string {
  return createHash("sha256").update(input, "utf8").digest("hex");
}

function findSkillFiles(dir: string): string[] {
  const out: string[] = [];
  if (!existsSync(dir)) return out;
  let entries: string[];
  try {
    entries = readdirSync(dir);
  } catch (err) {
    console.warn(
      `[skills] Verzeichnis konnte nicht gelesen werden: ${dir} (${
        err instanceof Error ? err.message : String(err)
      })`,
    );
    return out;
  }
  for (const entry of entries) {
    const sub = join(dir, entry);
    let st;
    try {
      st = statSync(sub);
    } catch {
      continue;
    }
    if (!st.isDirectory()) continue;
    const skillPath = join(sub, "SKILL.md");
    if (existsSync(skillPath)) out.push(skillPath);
  }
  return out;
}

function evaluateGate(
  skill: LoadedSkill,
  evaluate: GateEvaluator,
): { ok: boolean; reason: string | null } {
  const res = evaluate(skill);
  if (res.ok) return { ok: true, reason: null };
  const req = skill.metadata?.ava?.requires;
  const unmet: string[] = [];
  if (req) {
    for (const [k, v] of Object.entries(req)) {
      if (v) unmet.push(`${k}=${v}`);
    }
  }
  console.warn(
    `[skills] gate not satisfied: ${skill.name} verlangt ${unmet.join(", ") || "(unbekannt)"} — ${res.reason ?? "Voraussetzung fehlt"} (Skill bleibt sichtbar, aber inaktiv)`,
  );
  return { ok: false, reason: res.reason ?? "Voraussetzung fehlt" };
}

async function loadOne(
  path: string,
  scope: SkillScope,
  errors: LoadResult["errors"],
  evaluate: GateEvaluator,
  evaluateTrust: TrustEvaluator,
): Promise<LoadedSkill | null> {
  let raw: string;
  try {
    raw = readFileSync(path, "utf8");
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    console.warn(`[skills] '${path}' übersprungen: Datei nicht lesbar (${msg})`);
    errors.push({ path, message: msg });
    return null;
  }

  let parsed;
  try {
    parsed = parseSkillFile(raw);
  } catch (err) {
    const msg =
      err instanceof SkillParseError
        ? err.message
        : err instanceof Error
          ? err.message
          : String(err);
    console.warn(`[skills] '${path}' übersprungen: ${msg}`);
    errors.push({ path, message: msg });
    return null;
  }

  let validated;
  try {
    validated = await frontmatterSchema.validate(parsed.frontmatter, {
      abortEarly: true,
      stripUnknown: false,
    });
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    console.warn(`[skills] '${path}' übersprungen: ${msg}`);
    errors.push({ path, message: msg });
    return null;
  }

  const hash = sha256(raw);
  const skill: LoadedSkill = {
    id: `${scope}:${validated.name}`,
    name: validated.name,
    description: validated.description,
    language: validated.language,
    b2bScope: validated["b2b-scope"],
    allowedTools: validated["allowed-tools"] ?? [],
    requiresUserConfirm: validated["requires-user-confirm"],
    disableModelInvocation: validated["disable-model-invocation"],
    userInvocable: validated["user-invocable"],
    arguments: (validated.arguments ?? []) as SkillArgument[],
    metadata: (validated.metadata ?? {}) as SkillMetadata,
    body: parsed.body,
    hash,
    sourcePath: path,
    scope,
    gateSatisfied: true,
    gateReason: null,
    trust: "trusted",
    previouslyTrustedAllowedTools: [],
  };

  const gate = evaluateGate(skill, evaluate);
  skill.gateSatisfied = gate.ok;
  skill.gateReason = gate.reason;

  const trust = evaluateTrust(validated.name, hash);
  skill.trust = trust.trust;
  skill.previouslyTrustedAllowedTools = trust.previouslyTrustedAllowedTools;
  if (trust.trust !== "trusted") {
    console.log(
      `[skills] '${validated.name}' Vertrauensstatus: ${trust.trust} (bleibt sichtbar, aktiviert sich aber nicht)`,
    );
  }
  return skill;
}

const trustAllAsTrusted: TrustEvaluator = () => ({
  trust: "trusted",
  previouslyTrustedAllowedTools: [],
});

export async function loadSkills(opts: LoadOptions): Promise<LoadResult> {
  const errors: LoadResult["errors"] = [];
  const evaluate = opts.evaluateGate ?? denyAllGates;
  const evaluateTrust = opts.evaluateTrust ?? trustAllAsTrusted;
  const userPaths = opts.userDir ? findSkillFiles(opts.userDir) : [];
  const workspacePaths = opts.workspaceDir
    ? findSkillFiles(opts.workspaceDir)
    : [];

  const userSkills: LoadedSkill[] = [];
  for (const p of userPaths) {
    const s = await loadOne(p, "user", errors, evaluate, evaluateTrust);
    if (s) userSkills.push(s);
  }
  const workspaceSkills: LoadedSkill[] = [];
  for (const p of workspacePaths) {
    const s = await loadOne(p, "workspace", errors, evaluate, evaluateTrust);
    if (s) workspaceSkills.push(s);
  }

  // Name uniqueness: user scope wins. Warn in German on conflict.
  const byName = new Map<string, LoadedSkill>();
  for (const s of userSkills) byName.set(s.name, s);
  for (const s of workspaceSkills) {
    if (byName.has(s.name)) {
      console.warn(
        `[skills] Namenskonflikt: '${s.name}' existiert in beiden Bereichen — die Nutzer-Variante (${
          byName.get(s.name)!.sourcePath
        }) hat Vorrang; Workspace-Variante (${s.sourcePath}) wird ignoriert`,
      );
      continue;
    }
    byName.set(s.name, s);
  }

  return { skills: Array.from(byName.values()), errors };
}

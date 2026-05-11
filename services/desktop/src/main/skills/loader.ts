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
import {
  frontmatterSchema,
  type B2bScope,
  type SkillArgument,
  type SkillLanguage,
  type SkillMetadata,
} from "./schema";

export type SkillScope = "user" | "workspace";

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
}

export interface LoadOptions {
  userDir: string | null;
  workspaceDir: string | null;
}

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

// TODO(S2): real gate evaluation. For now we only check presence of
// keys and log "[skills] gate not satisfied: …" when any requires
// entry is set, since the gate-evaluator (CRM connected? Ollama
// installed? Tier ≥ Pro?) is not wired yet.
function gateSatisfied(skill: LoadedSkill): boolean {
  const req = skill.metadata?.ava?.requires;
  if (!req) return true;
  const unmet: string[] = [];
  for (const [k, v] of Object.entries(req)) {
    if (v) unmet.push(`${k}=${v}`);
  }
  if (unmet.length === 0) return true;
  console.warn(
    `[skills] gate not satisfied: ${skill.name} verlangt ${unmet.join(
      ", ",
    )} (S2 wertet Gates aus; aktuell wird das Skill übersprungen)`,
  );
  return false;
}

async function loadOne(
  path: string,
  scope: SkillScope,
  errors: LoadResult["errors"],
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
  };

  if (!gateSatisfied(skill)) return null;
  return skill;
}

export async function loadSkills(opts: LoadOptions): Promise<LoadResult> {
  const errors: LoadResult["errors"] = [];
  const userPaths = opts.userDir ? findSkillFiles(opts.userDir) : [];
  const workspacePaths = opts.workspaceDir
    ? findSkillFiles(opts.workspaceDir)
    : [];

  const userSkills: LoadedSkill[] = [];
  for (const p of userPaths) {
    const s = await loadOne(p, "user", errors);
    if (s) userSkills.push(s);
  }
  const workspaceSkills: LoadedSkill[] = [];
  for (const p of workspacePaths) {
    const s = await loadOne(p, "workspace", errors);
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

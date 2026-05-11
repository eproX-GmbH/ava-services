// S4 — Skill-save helpers.
//
// `buildSkillFile(payload)` is a pure function: takes a frontmatter +
// body payload, returns the directory name and serialised SKILL.md
// contents. Kept pure so the test script can round-trip it without
// touching the filesystem.
//
// `saveSkillToDisk(userDir, payload)` writes that file under
// `<userDir>/<name>/SKILL.md` after a defence-in-depth schema
// re-validation. Refuses to overwrite a file whose existing
// `frontmatter.name` differs (sanity check for buggy callers).
//
// The renderer-facing IPC handler in `main/index.ts` chains the
// `saveSkillToDisk` write with a trust-store update + a SkillStore
// reload — that's outside this module so the pure path stays
// testable.

import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { stringify as stringifyYaml } from "yaml";
import { frontmatterSchema } from "./schema";
import { parseSkillFile } from "./parser";
import type {
  B2bScope,
  SkillArgument,
  SkillLanguage,
} from "./schema";

export interface SkillSavePayload {
  frontmatter: {
    name: string;
    description: string;
    language: SkillLanguage;
    "b2b-scope": B2bScope;
    "allowed-tools": string[];
    "requires-user-confirm": boolean;
    "disable-model-invocation": boolean;
    "user-invocable": boolean;
    arguments: SkillArgument[];
  };
  body: string;
}

export interface BuildResult {
  dirName: string;
  contents: string;
}

/**
 * Serialise a save payload into a SKILL.md file body. Pure — no fs,
 * no schema validation (the caller is expected to validate first via
 * the same schema the loader uses). The output round-trips: parsing
 * `contents` with `parseSkillFile` + `frontmatterSchema` yields the
 * same frontmatter (modulo defaulted fields) + the body trimmed.
 */
export function buildSkillFile(payload: SkillSavePayload): BuildResult {
  const fm = payload.frontmatter;
  // Order fields deterministically so the on-disk form is stable and
  // diffs are minimal across re-saves. We mirror the order users see
  // in PLANS.md §2.3 and the schema definition.
  const ordered: Record<string, unknown> = {
    name: fm.name,
    description: fm.description,
    language: fm.language,
    "b2b-scope": fm["b2b-scope"],
    "allowed-tools": fm["allowed-tools"],
    "requires-user-confirm": fm["requires-user-confirm"],
    "disable-model-invocation": fm["disable-model-invocation"],
    "user-invocable": fm["user-invocable"],
  };
  if (fm.arguments && fm.arguments.length > 0) {
    ordered.arguments = fm.arguments;
  }
  const yaml = stringifyYaml(ordered, {
    lineWidth: 0,
    defaultStringType: "PLAIN",
  });
  const body = (payload.body ?? "").replace(/\s+$/g, "");
  const contents = `---\n${yaml}---\n\n${body}\n`;
  return { dirName: fm.name, contents };
}

export interface SaveResult {
  ok: boolean;
  /** Resolved absolute path of the written SKILL.md. */
  path?: string;
  /** Final validated skill name (echoes payload.frontmatter.name). */
  name?: string;
  /** German error message when `ok === false`. */
  error?: string;
}

/**
 * Validate + write a skill to `<userDir>/<name>/SKILL.md`. Creates
 * the directory if needed. Refuses to overwrite a file with a
 * different `frontmatter.name` on disk than `payload.frontmatter.name`
 * (a paranoia check for the case where the directory name was set
 * by hand to one thing and the payload name to another).
 */
export async function saveSkillToDisk(
  userDir: string,
  payload: SkillSavePayload,
): Promise<SaveResult> {
  // 1. Validate the frontmatter server-side. Defence in depth: the
  // renderer already validates client-side, but the IPC payload is
  // untrusted.
  let validated;
  try {
    validated = await frontmatterSchema.validate(payload.frontmatter, {
      abortEarly: true,
      stripUnknown: false,
    });
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    return { ok: false, error: msg };
  }

  const name = validated.name;
  const targetDir = join(userDir, name);
  const targetFile = join(targetDir, "SKILL.md");

  // 2. If the file already exists, sanity-check the on-disk name
  // matches. We allow overwriting our own file, but refuse if the
  // user repurposed the directory for a differently-named skill.
  if (existsSync(targetFile)) {
    try {
      const existing = readFileSync(targetFile, "utf8");
      const parsed = parseSkillFile(existing);
      const existingName =
        parsed.frontmatter &&
        typeof parsed.frontmatter === "object" &&
        "name" in parsed.frontmatter
          ? String((parsed.frontmatter as Record<string, unknown>).name ?? "")
          : "";
      if (existingName && existingName !== name) {
        return {
          ok: false,
          error: `Im Verzeichnis '${name}' liegt bereits ein anderes Skill ('${existingName}'). Bitte erst aufräumen, bevor du speicherst.`,
        };
      }
    } catch {
      // unreadable / malformed — we'll happily overwrite it
    }
  }

  // 3. Build + write.
  const built = buildSkillFile({
    frontmatter: {
      name: validated.name,
      description: validated.description,
      language: validated.language,
      "b2b-scope": validated["b2b-scope"],
      "allowed-tools": validated["allowed-tools"] ?? [],
      "requires-user-confirm": validated["requires-user-confirm"],
      "disable-model-invocation": validated["disable-model-invocation"],
      "user-invocable": validated["user-invocable"],
      arguments: (validated.arguments ?? []) as SkillArgument[],
    },
    body: payload.body,
  });

  try {
    mkdirSync(targetDir, { recursive: true });
    writeFileSync(targetFile, built.contents, { mode: 0o600 });
  } catch (err) {
    return {
      ok: false,
      error: `Schreiben fehlgeschlagen: ${err instanceof Error ? err.message : String(err)}`,
    };
  }

  return { ok: true, path: targetFile, name };
}

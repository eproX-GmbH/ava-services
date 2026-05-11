// S1 — Public surface of the skills module.
//
// `initSkills(app)` discovers + loads skills from:
//   - userData/skills/<name>/SKILL.md
//   - <cwd>/.ava/skills/<name>/SKILL.md (workspace; only if dir exists)
// It then starts a debounced fs.watch loop so edits hot-reload.
//
// IPC + window.api surface is intentionally deferred — that ships
// with S3 (Settings → Skills UI).

import type { App } from "electron";
import {
  copyFileSync,
  existsSync,
  mkdirSync,
  readdirSync,
  statSync,
} from "node:fs";
import { join } from "node:path";
import { SkillStore } from "./store";
import type { GateEvaluator } from "./gate";

export { SkillStore } from "./store";
export type { LoadedSkill, SkillScope } from "./loader";
export type {
  B2bScope,
  SkillLanguage,
  SkillArgument,
  SkillMetadata,
} from "./schema";
export { buildGateEvaluator, denyAllGates } from "./gate";
export type { GateEvaluator, GateDeps } from "./gate";
export {
  parseSlashInvocation,
  renderSkillBody,
  checkSkillAllowlist,
  autoActivateSkill,
} from "./allowlist";
export type { SlashInvocation, AllowlistCheck } from "./allowlist";

export interface InitSkillsOptions {
  /** Override userData path — used by the test script with fixtures. */
  userDir?: string | null;
  /** Override workspace dir — used by the test script with fixtures. */
  workspaceDir?: string | null;
  /** Skip starting fs.watch (test script). */
  watch?: boolean;
  /** S2 — gate evaluator (CRM connected? Ollama running?). When omitted,
   *  the loader denies every `metadata.ava.requires` block (S1 behaviour). */
  evaluateGate?: GateEvaluator;
  /** S6 — override the bundled-skills source directory. Used by tests
   *  to point at `resources/skills/` directly. In normal init this is
   *  derived from `app.isPackaged` and skipped if `app` is null. */
  bundledDir?: string | null;
}

/**
 * S6 — Copy bundled `SKILL.md` files from the desktop's `resources/skills/`
 * tree into `<userData>/skills/<name>/SKILL.md`, but only if the target
 * file does not yet exist. Never overwrites — the user can edit or
 * delete a bundled skill and we must not clobber their changes on
 * upgrade. Errors are logged in German and otherwise swallowed so a
 * single bad copy can't break startup.
 */
export function vendorBundledSkills(
  bundledDir: string,
  userDir: string,
): void {
  if (!existsSync(bundledDir)) {
    console.log(
      `[skills] kein gebündeltes Skill-Verzeichnis unter ${bundledDir} — übersprungen`,
    );
    return;
  }
  let entries: string[];
  try {
    entries = readdirSync(bundledDir);
  } catch (err) {
    console.warn(
      `[skills] gebündeltes Skill-Verzeichnis nicht lesbar: ${bundledDir} (${
        err instanceof Error ? err.message : String(err)
      })`,
    );
    return;
  }
  for (const entry of entries) {
    const src = join(bundledDir, entry, "SKILL.md");
    let st;
    try {
      st = statSync(join(bundledDir, entry));
    } catch {
      continue;
    }
    if (!st.isDirectory()) continue;
    if (!existsSync(src)) continue;
    const targetDir = join(userDir, entry);
    const target = join(targetDir, "SKILL.md");
    if (existsSync(target)) continue;
    try {
      mkdirSync(targetDir, { recursive: true });
      copyFileSync(src, target);
      console.log(`[skills] vendored bundled skill '${entry}' → ${target}`);
    } catch (err) {
      console.warn(
        `[skills] Vendor-Kopie fehlgeschlagen für '${entry}': ${
          err instanceof Error ? err.message : String(err)
        }`,
      );
    }
  }
}

export async function initSkills(
  app: App | null,
  opts: InitSkillsOptions = {},
): Promise<SkillStore> {
  let userDir: string | null;
  if (opts.userDir !== undefined) {
    userDir = opts.userDir;
  } else if (app) {
    userDir = join(app.getPath("userData"), "skills");
    try {
      mkdirSync(userDir, { recursive: true });
    } catch {
      // best-effort: if we can't create it, loadSkills() will just see
      // an empty list. We don't fail init for that.
    }
  } else {
    userDir = null;
  }

  // S6 — Vendor the bundled starter skills into userDir BEFORE the
  // loader scans the dir. The copy is no-overwrite (per-file
  // existence check) so user edits survive upgrades. Skipped if the
  // caller passed an explicit userDir override (tests) unless they
  // also passed an explicit bundledDir.
  let bundledDir: string | null = null;
  if (opts.bundledDir !== undefined) {
    bundledDir = opts.bundledDir;
  } else if (app && opts.userDir === undefined) {
    bundledDir = app.isPackaged
      ? join(process.resourcesPath, "skills")
      : join(app.getAppPath(), "resources", "skills");
  }
  if (bundledDir && userDir) {
    try {
      mkdirSync(userDir, { recursive: true });
      vendorBundledSkills(bundledDir, userDir);
    } catch (err) {
      console.warn(
        `[skills] Vendor-Schritt fehlgeschlagen: ${
          err instanceof Error ? err.message : String(err)
        }`,
      );
    }
  }

  let workspaceDir: string | null;
  if (opts.workspaceDir !== undefined) {
    workspaceDir = opts.workspaceDir;
  } else {
    const candidate = join(process.cwd(), ".ava", "skills");
    workspaceDir = existsSync(candidate) ? candidate : null;
  }

  const store = new SkillStore(userDir, workspaceDir, opts.evaluateGate);
  await store.reload();

  const userCount = store.list().filter((s) => s.scope === "user").length;
  const workspaceCount = store
    .list()
    .filter((s) => s.scope === "workspace").length;
  console.log(
    `[skills] loaded ${store.list().length} skills (${userCount} user, ${workspaceCount} workspace)`,
  );

  if (opts.watch !== false) store.startWatching();
  return store;
}

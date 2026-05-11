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
import { existsSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { SkillStore } from "./store";

export { SkillStore } from "./store";
export type { LoadedSkill, SkillScope } from "./loader";
export type {
  B2bScope,
  SkillLanguage,
  SkillArgument,
  SkillMetadata,
} from "./schema";

export interface InitSkillsOptions {
  /** Override userData path — used by the test script with fixtures. */
  userDir?: string | null;
  /** Override workspace dir — used by the test script with fixtures. */
  workspaceDir?: string | null;
  /** Skip starting fs.watch (test script). */
  watch?: boolean;
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

  let workspaceDir: string | null;
  if (opts.workspaceDir !== undefined) {
    workspaceDir = opts.workspaceDir;
  } else {
    const candidate = join(process.cwd(), ".ava", "skills");
    workspaceDir = existsSync(candidate) ? candidate : null;
  }

  const store = new SkillStore(userDir, workspaceDir);
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

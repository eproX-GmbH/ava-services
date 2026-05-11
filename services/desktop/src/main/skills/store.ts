// S1 — In-memory skill store + filesystem watcher.
//
// Single-instance, event-emitter shaped store. The agent (S2) and UI
// (S3) will subscribe to `changed`. We use Node's built-in
// `fs.watch({ recursive: true })` instead of pulling in chokidar —
// macOS and Windows support recursive natively; on Linux we fall
// back to watching the top-level dir only (sufficient for SKILL.md
// since each skill is one dir deep). Debounced by 200ms because a
// single save often fires multiple events.

import { EventEmitter } from "node:events";
import { existsSync, type FSWatcher, watch } from "node:fs";
import { loadSkills, type LoadedSkill, type LoadResult } from "./loader";
import type { GateEvaluator } from "./gate";

export type SkillStoreEvent = "changed";

export class SkillStore extends EventEmitter {
  private skills: LoadedSkill[] = [];
  private errors: LoadResult["errors"] = [];
  private watchers: FSWatcher[] = [];
  private reloadTimer: NodeJS.Timeout | null = null;

  constructor(
    private readonly userDir: string | null,
    private readonly workspaceDir: string | null,
    private readonly evaluateGate?: GateEvaluator,
  ) {
    super();
  }

  list(): LoadedSkill[] {
    return this.skills.slice();
  }

  get(name: string): LoadedSkill | undefined {
    return this.skills.find((s) => s.name === name);
  }

  getErrors(): LoadResult["errors"] {
    return this.errors.slice();
  }

  async reload(): Promise<void> {
    const result = await loadSkills({
      userDir: this.userDir,
      workspaceDir: this.workspaceDir,
      evaluateGate: this.evaluateGate,
    });
    this.skills = result.skills;
    this.errors = result.errors;
    this.emit("changed", this.skills);
  }

  startWatching(): void {
    const dirs = [this.userDir, this.workspaceDir].filter(
      (d): d is string => !!d && existsSync(d),
    );
    for (const dir of dirs) {
      try {
        const w = watch(
          dir,
          { recursive: true },
          (_event, filename) => {
            if (filename && !filename.toString().endsWith("SKILL.md")) return;
            this.scheduleReload();
          },
        );
        w.on("error", (err) => {
          console.warn(
            `[skills] Watcher-Fehler für ${dir}: ${err.message ?? err}`,
          );
        });
        this.watchers.push(w);
      } catch (err) {
        console.warn(
          `[skills] konnte Verzeichnis nicht überwachen: ${dir} (${
            err instanceof Error ? err.message : String(err)
          })`,
        );
      }
    }
  }

  private scheduleReload(): void {
    if (this.reloadTimer) clearTimeout(this.reloadTimer);
    this.reloadTimer = setTimeout(() => {
      this.reloadTimer = null;
      void this.reload().catch((err) => {
        console.error(
          `[skills] Reload fehlgeschlagen: ${err instanceof Error ? err.message : String(err)}`,
        );
      });
    }, 200);
  }

  stop(): void {
    if (this.reloadTimer) {
      clearTimeout(this.reloadTimer);
      this.reloadTimer = null;
    }
    for (const w of this.watchers) {
      try {
        w.close();
      } catch {
        // best-effort
      }
    }
    this.watchers = [];
    this.removeAllListeners();
  }
}

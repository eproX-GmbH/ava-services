// S3 — Per-user skill enabled/disabled state.
//
// Stored in `<userData>/skills-prefs.json` as `{ disabled: string[] }`.
// Atomic write via temp + rename, mirroring the patterns in
// `agent/freshness-prefs-store.ts` and `agent/alert-prefs-store.ts`.
//
// The store knows nothing about the SkillStore; the orchestrator and
// the IPC layer compose them. Names not present in `disabled` are
// implicitly enabled (default true), so a freshly installed skill
// shows up as active without any extra wiring.

import { EventEmitter } from "node:events";
import {
  existsSync,
  mkdirSync,
  readFileSync,
  renameSync,
  writeFileSync,
} from "node:fs";
import { dirname, join } from "node:path";
import { app } from "electron";

export interface SkillsPrefs {
  disabled: string[];
}

const DEFAULT_PREFS: SkillsPrefs = { disabled: [] };

export interface SkillsPrefsStoreEvents {
  changed: (prefs: SkillsPrefs) => void;
}

export declare interface SkillsPrefsStore {
  on<K extends keyof SkillsPrefsStoreEvents>(
    event: K,
    listener: SkillsPrefsStoreEvents[K],
  ): this;
  emit<K extends keyof SkillsPrefsStoreEvents>(
    event: K,
    ...args: Parameters<SkillsPrefsStoreEvents[K]>
  ): boolean;
}

export class SkillsPrefsStore extends EventEmitter {
  readonly path: string;
  private readonly dir: string;
  private cache: SkillsPrefs | null = null;

  constructor(filePath?: string) {
    super();
    this.path =
      filePath ?? join(app.getPath("userData"), "skills-prefs.json");
    this.dir = dirname(this.path);
  }

  get(): SkillsPrefs {
    if (this.cache !== null) return clone(this.cache);
    if (!existsSync(this.path)) {
      this.cache = clone(DEFAULT_PREFS);
      return clone(this.cache);
    }
    try {
      const raw = readFileSync(this.path, "utf8");
      const parsed = JSON.parse(raw) as Partial<SkillsPrefs>;
      this.cache = this.normalise(parsed);
    } catch (err) {
      console.warn(
        "[skills-prefs] read failed; falling back to defaults:",
        err,
      );
      this.cache = clone(DEFAULT_PREFS);
    }
    return clone(this.cache);
  }

  /** True when the given skill name is enabled (i.e. NOT in disabled list). */
  isEnabled(name: string): boolean {
    return !this.get().disabled.includes(name);
  }

  setEnabled(name: string, enabled: boolean): SkillsPrefs {
    const current = this.get();
    const set = new Set(current.disabled);
    if (enabled) set.delete(name);
    else set.add(name);
    return this.write({ disabled: Array.from(set).sort() });
  }

  // ---- Internal -----------------------------------------------------------

  private write(prefs: SkillsPrefs): SkillsPrefs {
    const normalised = this.normalise(prefs);
    this.cache = normalised;
    try {
      if (!existsSync(this.dir)) mkdirSync(this.dir, { recursive: true });
      const tmp = `${this.path}.${process.pid}.tmp`;
      writeFileSync(tmp, JSON.stringify(normalised, null, 2), { mode: 0o600 });
      renameSync(tmp, this.path);
    } catch (err) {
      console.warn("[skills-prefs] write failed:", err);
    }
    this.emit("changed", clone(normalised));
    return clone(normalised);
  }

  private normalise(input: Partial<SkillsPrefs>): SkillsPrefs {
    const disabled = Array.isArray(input.disabled)
      ? Array.from(
          new Set(
            input.disabled.filter(
              (n): n is string => typeof n === "string" && n.length > 0,
            ),
          ),
        ).sort()
      : [];
    return { disabled };
  }
}

function clone<T>(v: T): T {
  return JSON.parse(JSON.stringify(v)) as T;
}

// S4 — Per-user trust store for skills.
//
// Persists `<userData>/skills-trust.json` as:
//   {
//     version: 2,
//     trusted: {
//       "<skillName>": {
//         hash: "<sha256 of SKILL.md>",
//         trustedAt: <unix millis>,
//         allowedTools: ["company_get", …]      // v2 (S4) — for modify-diff UI
//       }
//     }
//   }
//
// Why both name AND hash must match: the "no silent updates" rule
// (PLANS.md §2.4 rule 6). A teammate could overwrite a "safe" skill
// on disk to grant itself broader tools; matching only by name would
// let that slip past. Matching by hash forces re-confirmation on any
// content change.
//
// Atomic write via temp+rename mirrors `skills-prefs-store.ts`.

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

export interface TrustEntry {
  hash: string;
  trustedAt: number;
  /** S4 — list of allowedTools at the moment of trust. Stored so the
   *  trust dialog can diff a modified skill against what the user
   *  previously approved without re-running the loader against the
   *  old file content. Optional for forward-compat (v1 entries
   *  without this field are tolerated). */
  allowedTools?: string[];
}

export interface TrustState {
  /** File-format version. Bumps are forward-compatible (older entries
   *  without newer fields keep working). */
  version: number;
  trusted: Record<string, TrustEntry>;
}

const DEFAULT_STATE: TrustState = { version: 2, trusted: {} };

export interface TrustStoreEvents {
  changed: (state: TrustState) => void;
}

export declare interface SkillsTrustStore {
  on<K extends keyof TrustStoreEvents>(
    event: K,
    listener: TrustStoreEvents[K],
  ): this;
  emit<K extends keyof TrustStoreEvents>(
    event: K,
    ...args: Parameters<TrustStoreEvents[K]>
  ): boolean;
}

export class SkillsTrustStore extends EventEmitter {
  readonly path: string;
  private readonly dir: string;
  private cache: TrustState | null = null;

  constructor(filePath?: string) {
    super();
    this.path =
      filePath ?? join(app.getPath("userData"), "skills-trust.json");
    this.dir = dirname(this.path);
  }

  get(): TrustState {
    if (this.cache !== null) return clone(this.cache);
    if (!existsSync(this.path)) {
      this.cache = clone(DEFAULT_STATE);
      return clone(this.cache);
    }
    try {
      const raw = readFileSync(this.path, "utf8");
      const parsed = JSON.parse(raw) as Partial<TrustState>;
      this.cache = this.normalise(parsed);
    } catch (err) {
      console.warn(
        "[skills-trust] read failed; falling back to defaults:",
        err,
      );
      this.cache = clone(DEFAULT_STATE);
    }
    return clone(this.cache);
  }

  isTrusted(name: string, hash: string): boolean {
    const entry = this.get().trusted[name];
    if (!entry) return false;
    return entry.hash === hash;
  }

  getEntry(name: string): TrustEntry | null {
    const entry = this.get().trusted[name];
    return entry ? { ...entry } : null;
  }

  trust(
    name: string,
    hash: string,
    allowedTools: string[] = [],
  ): TrustState {
    const current = this.get();
    const next: TrustState = {
      version: 2,
      trusted: {
        ...current.trusted,
        [name]: {
          hash,
          trustedAt: Date.now(),
          allowedTools: allowedTools.slice(),
        },
      },
    };
    return this.write(next);
  }

  revoke(name: string): TrustState {
    const current = this.get();
    if (!(name in current.trusted)) return current;
    const trusted = { ...current.trusted };
    delete trusted[name];
    return this.write({ version: 2, trusted });
  }

  // ---- Internal -----------------------------------------------------------

  private write(state: TrustState): TrustState {
    const normalised = this.normalise(state);
    this.cache = normalised;
    try {
      if (!existsSync(this.dir)) mkdirSync(this.dir, { recursive: true });
      const tmp = `${this.path}.${process.pid}.tmp`;
      writeFileSync(tmp, JSON.stringify(normalised, null, 2), { mode: 0o600 });
      renameSync(tmp, this.path);
    } catch (err) {
      console.warn("[skills-trust] write failed:", err);
    }
    this.emit("changed", clone(normalised));
    return clone(normalised);
  }

  private normalise(input: Partial<TrustState>): TrustState {
    const trusted: Record<string, TrustEntry> = {};
    if (input.trusted && typeof input.trusted === "object") {
      for (const [k, v] of Object.entries(input.trusted)) {
        if (
          !v ||
          typeof v !== "object" ||
          typeof (v as TrustEntry).hash !== "string" ||
          typeof (v as TrustEntry).trustedAt !== "number"
        ) {
          continue;
        }
        const entry = v as TrustEntry;
        trusted[k] = {
          hash: entry.hash,
          trustedAt: entry.trustedAt,
          allowedTools: Array.isArray(entry.allowedTools)
            ? entry.allowedTools.filter(
                (t): t is string => typeof t === "string",
              )
            : [],
        };
      }
    }
    return { version: 2, trusted };
  }
}

function clone<T>(v: T): T {
  return JSON.parse(JSON.stringify(v)) as T;
}

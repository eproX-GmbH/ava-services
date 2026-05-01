import { EventEmitter } from "node:events";
import {
  existsSync,
  mkdirSync,
  readFileSync,
  renameSync,
  writeFileSync,
} from "node:fs";
import { join } from "node:path";
import { app } from "electron";
import type {
  UserProfile,
  UserProfileTone,
} from "../../shared/types";

// UserProfileStore (Phase 8.t1).
//
// Persists the per-tenant user profile to
// `userData/agent/user-profile.json`. Same atomic write-temp +
// rename pattern every other prefs / cursor store in the agent uses.
// In-memory cache after first read; emits `changed` on every successful
// `set` so subscribers can refresh (system-prompt builder, Settings
// panel, etc.).

const DEFAULT_PROFILE: UserProfile = {
  bio: "",
  role: null,
  industries: [],
  geographies: [],
  topics: [],
  tone: null,
  profileSkipped: false,
  updatedAt: null,
};

const TONE_VALUES: readonly UserProfileTone[] = [
  "neutral",
  "knapp",
  "ausführlich",
];

/** Hard cap on bio chars so token spend stays bounded — every turn
 *  weaves the bio into the system prompt verbatim. */
const BIO_CAP = 300;
/** Hard cap per structured-field array so a runaway agent can't write
 *  100 industries. */
const ARRAY_CAP = 12;

export interface UserProfileStoreEvents {
  changed: (profile: UserProfile) => void;
}

export declare interface UserProfileStore {
  on<K extends keyof UserProfileStoreEvents>(
    event: K,
    listener: UserProfileStoreEvents[K],
  ): this;
  emit<K extends keyof UserProfileStoreEvents>(
    event: K,
    ...args: Parameters<UserProfileStoreEvents[K]>
  ): boolean;
}

export class UserProfileStore extends EventEmitter {
  readonly path: string;
  private readonly dir: string;
  private cache: UserProfile | null = null;

  constructor(dir?: string) {
    super();
    this.dir = dir ?? join(app.getPath("userData"), "agent");
    this.path = join(this.dir, "user-profile.json");
  }

  /** Synchronous snapshot. Defaults applied on missing/corrupt file. */
  get(): UserProfile {
    if (this.cache !== null) return this.cache;
    if (!existsSync(this.path)) {
      this.cache = clone(DEFAULT_PROFILE);
      return this.cache;
    }
    try {
      const raw = readFileSync(this.path, "utf8");
      const parsed = JSON.parse(raw) as Partial<UserProfile>;
      this.cache = this.normalise(parsed);
    } catch (err) {
      console.warn(
        "[user-profile] read failed; falling back to defaults:",
        err,
      );
      this.cache = clone(DEFAULT_PROFILE);
    }
    return this.cache;
  }

  /**
   * Patch + persist. Unspecified fields keep their prior value.
   * Touches `updatedAt` only when the merge actually changes something
   * (so re-saving the same patch isn't visible as "freshly edited").
   */
  set(patch: Partial<UserProfile>): UserProfile {
    const current = this.get();
    const merged = this.normalise({
      bio: patch.bio !== undefined ? patch.bio : current.bio,
      role: patch.role !== undefined ? patch.role : current.role,
      industries: patch.industries ?? current.industries,
      geographies: patch.geographies ?? current.geographies,
      topics: patch.topics ?? current.topics,
      tone: patch.tone !== undefined ? patch.tone : current.tone,
      profileSkipped:
        patch.profileSkipped !== undefined
          ? patch.profileSkipped
          : current.profileSkipped,
      updatedAt: current.updatedAt,
    });
    if (didChange(current, merged)) {
      merged.updatedAt = new Date().toISOString();
    }
    this.cache = merged;
    this.persist();
    this.emit("changed", merged);
    return merged;
  }

  /** Wipe back to defaults. Used by `profile_clear` and Settings. */
  clear(): UserProfile {
    return this.set({
      bio: "",
      role: null,
      industries: [],
      geographies: [],
      topics: [],
      tone: null,
      profileSkipped: false,
    });
  }

  /**
   * Convenience: do we have meaningful content? Used by the system-
   * prompt builder to decide whether to inject the profile block AND
   * whether to surface the first-run nudge ("no content + not yet
   * skipped" → nudge; "no content + skipped" → silent).
   */
  isEmpty(): boolean {
    const p = this.get();
    return (
      p.bio.trim().length === 0 &&
      p.role === null &&
      p.industries.length === 0 &&
      p.geographies.length === 0 &&
      p.topics.length === 0 &&
      p.tone === null
    );
  }

  // ---- Internal -----------------------------------------------------------

  private persist(): void {
    if (this.cache === null) return;
    try {
      if (!existsSync(this.dir)) mkdirSync(this.dir, { recursive: true });
      const tmp = `${this.path}.${process.pid}.tmp`;
      writeFileSync(tmp, JSON.stringify(this.cache, null, 2), { mode: 0o600 });
      renameSync(tmp, this.path);
    } catch (err) {
      console.warn("[user-profile] write failed:", err);
    }
  }

  private normalise(input: Partial<UserProfile>): UserProfile {
    return {
      bio: trimToCap(input.bio ?? "", BIO_CAP),
      role: emptyToNull(input.role ?? null),
      industries: capArray(input.industries),
      geographies: capArray(input.geographies),
      topics: capArray(input.topics),
      tone:
        input.tone && TONE_VALUES.includes(input.tone as UserProfileTone)
          ? (input.tone as UserProfileTone)
          : null,
      profileSkipped: input.profileSkipped === true,
      updatedAt:
        typeof input.updatedAt === "string" ? input.updatedAt : null,
    };
  }
}

function trimToCap(s: string, cap: number): string {
  const trimmed = (s ?? "").trim();
  return trimmed.length > cap ? trimmed.slice(0, cap) : trimmed;
}

function emptyToNull(s: string | null): string | null {
  if (typeof s !== "string") return null;
  const trimmed = s.trim();
  return trimmed.length === 0 ? null : trimmed;
}

function capArray(input: unknown): string[] {
  if (!Array.isArray(input)) return [];
  const out: string[] = [];
  const seen = new Set<string>();
  for (const v of input) {
    if (typeof v !== "string") continue;
    const trimmed = v.trim();
    if (!trimmed) continue;
    if (seen.has(trimmed.toLowerCase())) continue;
    seen.add(trimmed.toLowerCase());
    out.push(trimmed);
    if (out.length >= ARRAY_CAP) break;
  }
  return out;
}

function didChange(a: UserProfile, b: UserProfile): boolean {
  if (a.bio !== b.bio) return true;
  if (a.role !== b.role) return true;
  if (a.tone !== b.tone) return true;
  if (a.profileSkipped !== b.profileSkipped) return true;
  if (!sameArray(a.industries, b.industries)) return true;
  if (!sameArray(a.geographies, b.geographies)) return true;
  if (!sameArray(a.topics, b.topics)) return true;
  return false;
}

function sameArray(a: string[], b: string[]): boolean {
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) return false;
  return true;
}

function clone<T>(v: T): T {
  return JSON.parse(JSON.stringify(v)) as T;
}

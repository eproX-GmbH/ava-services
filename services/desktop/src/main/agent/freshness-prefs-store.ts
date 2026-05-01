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
  FreshnessPrefs,
  FreshnessStage,
} from "../../shared/types";

// FreshnessPrefsStore (Phase 8.r1).
//
// Persists the freshness scheduler's user-configurable knobs to
// `userData/agent/freshness-prefs.json`. Same atomic write-temp +
// rename pattern as `alert-prefs-store.ts`.
//
// Defaults reflect the cadences anchored in §8.r:
//   - companyContact / companyProfile / website: 7 days
//     (personnel turnover, address drift, site edits — weekly catches
//     most of these without hammering producers).
//   - structuredContent: 30 days
//     (slow-changing aggregate; monthly is enough).
//   - companyEvaluation: 14 days
//     (LLM-derived view; refresh after the producers above stabilise).
//   - companyPublication: 75 days
//     (annual reports + filings cluster quarterly at most).
//
// Throttle defaults: 3 retries per stage per hour, 10 globally per
// hour, top-K-per-tick = 5.

const DEFAULT_PREFS: FreshnessPrefs = {
  enabled: true,
  cadenceDays: {
    structuredContent: 30,
    companyPublication: 75,
    website: 7,
    companyProfile: 7,
    companyContact: 7,
    companyEvaluation: 14,
  },
  throttle: {
    perStagePerHour: 3,
    globalPerHour: 10,
  },
  topKPerTick: 5,
  pinned: [],
};

const ALL_STAGES: readonly FreshnessStage[] = [
  "structuredContent",
  "companyPublication",
  "website",
  "companyProfile",
  "companyContact",
  "companyEvaluation",
];

export interface FreshnessPrefsStoreEvents {
  changed: (prefs: FreshnessPrefs) => void;
}

export declare interface FreshnessPrefsStore {
  on<K extends keyof FreshnessPrefsStoreEvents>(
    event: K,
    listener: FreshnessPrefsStoreEvents[K],
  ): this;
  emit<K extends keyof FreshnessPrefsStoreEvents>(
    event: K,
    ...args: Parameters<FreshnessPrefsStoreEvents[K]>
  ): boolean;
}

export class FreshnessPrefsStore extends EventEmitter {
  readonly path: string;
  private readonly dir: string;
  private cache: FreshnessPrefs | null = null;

  constructor(dir?: string) {
    super();
    this.dir = dir ?? join(app.getPath("userData"), "agent");
    this.path = join(this.dir, "freshness-prefs.json");
  }

  get(): FreshnessPrefs {
    if (this.cache !== null) return this.cache;
    if (!existsSync(this.path)) {
      this.cache = clone(DEFAULT_PREFS);
      return this.cache;
    }
    try {
      const raw = readFileSync(this.path, "utf8");
      const parsed = JSON.parse(raw) as Partial<FreshnessPrefs>;
      this.cache = this.normalise(parsed);
    } catch (err) {
      console.warn(
        "[freshness-prefs] read failed; falling back to defaults:",
        err,
      );
      this.cache = clone(DEFAULT_PREFS);
    }
    return this.cache;
  }

  set(patch: Partial<FreshnessPrefs>): FreshnessPrefs {
    const current = this.get();
    const merged = this.normalise({
      enabled: patch.enabled ?? current.enabled,
      cadenceDays: { ...current.cadenceDays, ...(patch.cadenceDays ?? {}) },
      throttle: { ...current.throttle, ...(patch.throttle ?? {}) },
      topKPerTick: patch.topKPerTick ?? current.topKPerTick,
      pinned: patch.pinned ?? current.pinned,
    });
    this.cache = merged;
    try {
      if (!existsSync(this.dir)) mkdirSync(this.dir, { recursive: true });
      const tmp = `${this.path}.${process.pid}.tmp`;
      writeFileSync(tmp, JSON.stringify(merged, null, 2), { mode: 0o600 });
      renameSync(tmp, this.path);
    } catch (err) {
      console.warn("[freshness-prefs] write failed:", err);
    }
    this.emit("changed", merged);
    return merged;
  }

  // ---- Internal -----------------------------------------------------------

  private normalise(input: Partial<FreshnessPrefs>): FreshnessPrefs {
    const cadenceIn = input.cadenceDays ?? {};
    const cadenceDays = {} as Record<FreshnessStage, number>;
    for (const stage of ALL_STAGES) {
      const v = (cadenceIn as Record<string, unknown>)[stage];
      cadenceDays[stage] =
        typeof v === "number" && Number.isFinite(v) && v >= 0
          ? Math.round(v)
          : DEFAULT_PREFS.cadenceDays[stage];
    }
    const throttleIn: Partial<FreshnessPrefs["throttle"]> =
      input.throttle ?? {};
    const perStagePerHour =
      typeof throttleIn.perStagePerHour === "number" &&
      throttleIn.perStagePerHour >= 0
        ? Math.round(throttleIn.perStagePerHour)
        : DEFAULT_PREFS.throttle.perStagePerHour;
    const globalPerHour =
      typeof throttleIn.globalPerHour === "number" &&
      throttleIn.globalPerHour >= 0
        ? Math.round(throttleIn.globalPerHour)
        : DEFAULT_PREFS.throttle.globalPerHour;
    const topKPerTick =
      typeof input.topKPerTick === "number" && input.topKPerTick >= 0
        ? Math.round(input.topKPerTick)
        : DEFAULT_PREFS.topKPerTick;
    const pinned = Array.isArray(input.pinned)
      ? Array.from(
          new Set(
            input.pinned.filter(
              (p): p is string => typeof p === "string" && p.length > 0,
            ),
          ),
        )
      : [];
    return {
      enabled: input.enabled !== false,
      cadenceDays,
      throttle: { perStagePerHour, globalPerHour },
      topKPerTick,
      pinned,
    };
  }
}

function clone<T>(v: T): T {
  return JSON.parse(JSON.stringify(v)) as T;
}

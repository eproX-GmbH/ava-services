import {
  existsSync,
  mkdirSync,
  readFileSync,
  renameSync,
  writeFileSync,
} from "node:fs";
import { join } from "node:path";
import { app } from "electron";
import type { FreshnessStage } from "../../shared/types";

// FreshnessCursorStore (Phase 8.r2).
//
// Persists throttle counters + per-company in-flight locks across
// process restarts so a relaunch right after a flurry of dispatches
// doesn't blow through the configured ceilings.
//
// File: `userData/agent/freshness-cursor.json`. Same atomic temp +
// rename pattern as the other stores. Read-on-first-use, written on
// every accept (`tryReserveSlot`) and on every in-flight sweep.
//
// Throttle logic:
//   - Hour buckets are ISO-truncated to the hour ("YYYY-MM-DDTHH:00:00Z").
//     A tick that crosses an hour boundary resets the count to zero
//     before incrementing — single-bucket window, not a sliding window.
//     Sliding windows would need every dispatch timestamp; the bucket
//     model is good enough for the rate-limit goal (don't blast the
//     producers) and trivially fits in a JSON struct.
//   - Per-company in-flight is timestamped; a sweep at the start of
//     each tick clears entries older than `inFlightTtlMs` so a
//     dispatch that failed silently (no SSE, no cell update) doesn't
//     pin the company forever.

export interface InFlightEntry {
  stage: FreshnessStage;
  dispatchedAt: string;
}

export interface FreshnessCursor {
  perStageHourlyDispatched: Partial<
    Record<FreshnessStage, { hour: string; count: number }>
  >;
  globalHourlyDispatched: { hour: string; count: number };
  inFlight: Record<string, InFlightEntry>;
}

const DEFAULT_CURSOR: FreshnessCursor = {
  perStageHourlyDispatched: {},
  globalHourlyDispatched: { hour: "", count: 0 },
  inFlight: {},
};

export class FreshnessCursorStore {
  readonly path: string;
  private readonly dir: string;
  private cache: FreshnessCursor | null = null;

  constructor(dir?: string) {
    this.dir = dir ?? join(app.getPath("userData"), "agent");
    this.path = join(this.dir, "freshness-cursor.json");
  }

  get(): FreshnessCursor {
    if (this.cache !== null) return this.cache;
    if (!existsSync(this.path)) {
      this.cache = clone(DEFAULT_CURSOR);
      return this.cache;
    }
    try {
      const raw = readFileSync(this.path, "utf8");
      const parsed = JSON.parse(raw) as Partial<FreshnessCursor>;
      this.cache = {
        perStageHourlyDispatched:
          parsed.perStageHourlyDispatched &&
          typeof parsed.perStageHourlyDispatched === "object"
            ? parsed.perStageHourlyDispatched
            : {},
        globalHourlyDispatched: parsed.globalHourlyDispatched ?? {
          hour: "",
          count: 0,
        },
        inFlight:
          parsed.inFlight && typeof parsed.inFlight === "object"
            ? (parsed.inFlight as Record<string, InFlightEntry>)
            : {},
      };
    } catch (err) {
      console.warn(
        "[freshness-cursor] read failed; falling back to defaults:",
        err,
      );
      this.cache = clone(DEFAULT_CURSOR);
    }
    return this.cache;
  }

  /**
   * Attempt to reserve a dispatch slot atomically (in-process):
   * checks per-stage hourly cap, global hourly cap, and per-company
   * in-flight lock. Returns true and persists the increment iff all
   * three pass; false otherwise (caller should move to the next
   * candidate).
   */
  tryReserveSlot(
    stage: FreshnessStage,
    companyId: string,
    now: Date,
    limits: { perStagePerHour: number; globalPerHour: number },
  ): boolean {
    const cursor = this.get();
    const hour = hourBucket(now);

    // Per-company in-flight check — exclusive even across stages so the
    // master-data → profile → contact upstream chain doesn't race on
    // the same row.
    if (cursor.inFlight[companyId]) return false;

    // Per-stage cap.
    const stageState = cursor.perStageHourlyDispatched[stage];
    const stageCount = stageState && stageState.hour === hour ? stageState.count : 0;
    if (stageCount >= limits.perStagePerHour) return false;

    // Global cap.
    const globalState = cursor.globalHourlyDispatched;
    const globalCount =
      globalState && globalState.hour === hour ? globalState.count : 0;
    if (globalCount >= limits.globalPerHour) return false;

    // All three pass — increment and persist.
    cursor.perStageHourlyDispatched[stage] = {
      hour,
      count: stageCount + 1,
    };
    cursor.globalHourlyDispatched = {
      hour,
      count: globalCount + 1,
    };
    cursor.inFlight[companyId] = {
      stage,
      dispatchedAt: now.toISOString(),
    };
    this.persist();
    return true;
  }

  /**
   * Roll back a reservation when the dispatch itself failed. Decrements
   * the counters and clears the in-flight entry so the candidate can
   * try again next tick.
   */
  releaseSlot(stage: FreshnessStage, companyId: string, now: Date): void {
    const cursor = this.get();
    const hour = hourBucket(now);

    const stageState = cursor.perStageHourlyDispatched[stage];
    if (stageState && stageState.hour === hour && stageState.count > 0) {
      cursor.perStageHourlyDispatched[stage] = {
        hour,
        count: stageState.count - 1,
      };
    }
    if (
      cursor.globalHourlyDispatched.hour === hour &&
      cursor.globalHourlyDispatched.count > 0
    ) {
      cursor.globalHourlyDispatched.count -= 1;
    }
    delete cursor.inFlight[companyId];
    this.persist();
  }

  /** Drop in-flight entries older than `ttlMs`. Called at the start of
   *  each tick; keeps the cursor file from growing unbounded if a
   *  dispatch silently never produces a follow-up state change. */
  sweepInFlight(now: Date, ttlMs: number): void {
    const cursor = this.get();
    const cutoff = now.getTime() - ttlMs;
    let touched = false;
    for (const [companyId, entry] of Object.entries(cursor.inFlight)) {
      const t = new Date(entry.dispatchedAt).getTime();
      if (!Number.isFinite(t) || t < cutoff) {
        delete cursor.inFlight[companyId];
        touched = true;
      }
    }
    if (touched) this.persist();
  }

  /** How many slots remain *right now*. Useful for the Settings UI
   *  + diagnostics so the user understands why a tick stalled. */
  remainingThisHour(
    now: Date,
    limits: { perStagePerHour: number; globalPerHour: number },
  ): { global: number; perStage: Record<string, number> } {
    const cursor = this.get();
    const hour = hourBucket(now);
    const perStage: Record<string, number> = {};
    for (const [stage, state] of Object.entries(
      cursor.perStageHourlyDispatched,
    )) {
      const used = state && state.hour === hour ? state.count : 0;
      perStage[stage] = Math.max(0, limits.perStagePerHour - used);
    }
    const globalUsed =
      cursor.globalHourlyDispatched.hour === hour
        ? cursor.globalHourlyDispatched.count
        : 0;
    return {
      global: Math.max(0, limits.globalPerHour - globalUsed),
      perStage,
    };
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
      console.warn("[freshness-cursor] write failed:", err);
    }
  }
}

function hourBucket(d: Date): string {
  // Truncate to the hour in UTC ISO. Fine: throttle is "per real hour"
  // not "per local-hour" — we want consistent rate-limiting regardless
  // of timezone shifts (DST, travelling user, etc.).
  const isoMinute = d.toISOString().slice(0, 13); // "YYYY-MM-DDTHH"
  return `${isoMinute}:00:00Z`;
}

function clone<T>(v: T): T {
  return JSON.parse(JSON.stringify(v)) as T;
}

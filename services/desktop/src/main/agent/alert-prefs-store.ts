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
  AlertCadenceMinutes,
  AlertPrefs,
  AlertSeverity,
} from "../../shared/types";

// AlertPrefsStore (Phase 8.f3).
//
// Persists user preferences for the heartbeat + native OS push to
// `userData/agent/alert-prefs.json`. Mirrors `ProviderConfigStore`'s
// atomic write-temp + rename pattern so a crash mid-write can't strand
// a zero-byte file.
//
// Defaults reflect the §8.f spec: 15 min cadence, push off (user has
// to opt in once — D7 privacy stance), info-and-up threshold so the
// toggle starts noisy but not redundant, quiet hours 19:00–07:00 +
// weekends silenced.
//
// Cadence and push are decoupled from each other on purpose: a user
// might want alerts collected silently in the bell while they sleep
// (cadence on, push off), or want push but pause heartbeat collection
// (push on, cadence 0 — manual triggers only).

const DEFAULT_PREFS: AlertPrefs = {
  cadenceMinutes: 15,
  pushEnabled: false,
  pushSeverityThreshold: "warn",
  quietHours: {
    enabled: true,
    startMinute: 19 * 60, // 19:00
    endMinute: 7 * 60, // 07:00 (next day)
    silenceWeekends: true,
  },
  // v0.1.118 — auto-retry is on by default. The user can flip it off
  // in Settings → Heartbeat if a producer chain is misbehaving and
  // they want to stop the retry loop while they investigate.
  autoRetryEnabled: true,
};

export interface AlertPrefsStoreEvents {
  changed: (prefs: AlertPrefs) => void;
}

export declare interface AlertPrefsStore {
  on<K extends keyof AlertPrefsStoreEvents>(
    event: K,
    listener: AlertPrefsStoreEvents[K],
  ): this;
  emit<K extends keyof AlertPrefsStoreEvents>(
    event: K,
    ...args: Parameters<AlertPrefsStoreEvents[K]>
  ): boolean;
}

export class AlertPrefsStore extends EventEmitter {
  readonly path: string;
  private readonly dir: string;
  private cache: AlertPrefs | null = null;

  constructor(dir?: string) {
    super();
    this.dir = dir ?? join(app.getPath("userData"), "agent");
    this.path = join(this.dir, "alert-prefs.json");
  }

  /** Returns the current prefs (cached after first read). */
  get(): AlertPrefs {
    if (this.cache !== null) return this.cache;
    if (!existsSync(this.path)) {
      this.cache = { ...DEFAULT_PREFS, quietHours: { ...DEFAULT_PREFS.quietHours } };
      return this.cache;
    }
    try {
      const raw = readFileSync(this.path, "utf8");
      const parsed = JSON.parse(raw) as Partial<AlertPrefs>;
      this.cache = this.normalise(parsed);
    } catch (err) {
      console.warn("[alert-prefs] read failed; falling back to defaults:", err);
      this.cache = { ...DEFAULT_PREFS, quietHours: { ...DEFAULT_PREFS.quietHours } };
    }
    return this.cache;
  }

  /**
   * Patch and persist. Unspecified fields keep their prior value.
   * Emits `changed` with the merged prefs on success.
   */
  set(patch: Partial<AlertPrefs>): AlertPrefs {
    const current = this.get();
    const merged: AlertPrefs = this.normalise({
      cadenceMinutes: patch.cadenceMinutes ?? current.cadenceMinutes,
      pushEnabled: patch.pushEnabled ?? current.pushEnabled,
      pushSeverityThreshold:
        patch.pushSeverityThreshold ?? current.pushSeverityThreshold,
      quietHours: { ...current.quietHours, ...(patch.quietHours ?? {}) },
      autoRetryEnabled:
        patch.autoRetryEnabled ?? current.autoRetryEnabled,
    });
    this.cache = merged;
    try {
      if (!existsSync(this.dir)) mkdirSync(this.dir, { recursive: true });
      const tmp = `${this.path}.${process.pid}.tmp`;
      writeFileSync(tmp, JSON.stringify(merged, null, 2), { mode: 0o600 });
      renameSync(tmp, this.path);
    } catch (err) {
      console.warn("[alert-prefs] write failed:", err);
    }
    this.emit("changed", merged);
    return merged;
  }

  // ---- Internal -----------------------------------------------------------

  private normalise(input: Partial<AlertPrefs>): AlertPrefs {
    const cadence = sanitiseCadence(input.cadenceMinutes);
    const severity = sanitiseSeverity(input.pushSeverityThreshold);
    const qhIn: Partial<AlertPrefs["quietHours"]> = input.quietHours ?? {};
    const startMinute = clampMinute(
      typeof qhIn.startMinute === "number"
        ? qhIn.startMinute
        : DEFAULT_PREFS.quietHours.startMinute,
    );
    const endMinute = clampMinute(
      typeof qhIn.endMinute === "number"
        ? qhIn.endMinute
        : DEFAULT_PREFS.quietHours.endMinute,
    );
    return {
      cadenceMinutes: cadence,
      pushEnabled: input.pushEnabled === true,
      pushSeverityThreshold: severity,
      quietHours: {
        enabled: qhIn.enabled !== false, // default on
        startMinute,
        endMinute,
        silenceWeekends: qhIn.silenceWeekends !== false,
      },
      // v0.1.118 — default true. Only treat an explicit `false` as off
      // so the existing prefs file (without this field) reads as on.
      autoRetryEnabled: input.autoRetryEnabled !== false,
    };
  }
}

function sanitiseCadence(v: unknown): AlertCadenceMinutes {
  if (v === 0 || v === 5 || v === 15 || v === 30 || v === 60) return v;
  return DEFAULT_PREFS.cadenceMinutes;
}

function sanitiseSeverity(v: unknown): AlertSeverity {
  if (v === "info" || v === "warn" || v === "urgent") return v;
  return DEFAULT_PREFS.pushSeverityThreshold;
}

function clampMinute(v: number): number {
  if (!Number.isFinite(v)) return 0;
  const n = Math.round(v);
  if (n < 0) return 0;
  if (n > 24 * 60 - 1) return 24 * 60 - 1;
  return n;
}

import { EventEmitter } from "node:events";
import {
  appendFileSync,
  existsSync,
  mkdirSync,
  readFileSync,
  renameSync,
  writeFileSync,
} from "node:fs";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import { app } from "electron";
import type {
  Watch,
  WatchCadence,
  WatchTrigger,
  WatchHit,
  AlertKind,
} from "../../shared/types";
import { WATCH_CAP_DEFAULT } from "../../shared/types";

// WatchStore (Phase 8.t2).
//
// Persists user-registered watches to `userData/agent/watches.jsonl`,
// mirroring AlertsStore's append-only + atomic-rewrite-on-mutation
// pattern. Cap of 20 active watches enforced at registration time
// (configurable in 8.t3 — for now pinned constant to keep the cost
// ceiling predictable).

export interface WatchCreateInput {
  prompt: string;
  trigger: WatchTrigger;
  cadence: WatchCadence;
}

export interface WatchStoreEvents {
  changed: (snapshot: Watch[]) => void;
}

export declare interface WatchStore {
  on<K extends keyof WatchStoreEvents>(
    event: K,
    listener: WatchStoreEvents[K],
  ): this;
  emit<K extends keyof WatchStoreEvents>(
    event: K,
    ...args: Parameters<WatchStoreEvents[K]>
  ): boolean;
}

export class WatchStore extends EventEmitter {
  readonly path: string;
  private readonly dir: string;
  private writable = false;
  private cache: Watch[] | null = null;

  constructor(dir?: string) {
    super();
    this.dir = dir ?? join(app.getPath("userData"), "agent");
    this.path = join(this.dir, "watches.jsonl");
  }

  probe(): { writable: boolean; reason?: string; path: string } {
    try {
      if (!existsSync(this.dir)) mkdirSync(this.dir, { recursive: true });
      if (!existsSync(this.path)) {
        writeFileSync(this.path, "", { mode: 0o600 });
      }
      this.writable = true;
      return { writable: true, path: this.path };
    } catch (err) {
      this.writable = false;
      return {
        writable: false,
        path: this.path,
        reason: err instanceof Error ? err.message : String(err),
      };
    }
  }

  /** Snapshot. Newest-first by createdAt. */
  list(): Watch[] {
    return this.loadCache()
      .slice()
      .sort((a, b) => (a.createdAt < b.createdAt ? 1 : -1));
  }

  /** Subset that the executor should consider on a tick. */
  enabled(): Watch[] {
    return this.loadCache().filter((w) => w.enabled);
  }

  /** How many watches are currently in the active bucket — drives the
   *  topbar chip's count + capacity colour. */
  activeCount(): number {
    return this.loadCache().filter((w) => w.enabled).length;
  }

  /** Cap currently in force. v1 always returns the constant. */
  cap(): number {
    return WATCH_CAP_DEFAULT;
  }

  /**
   * Insert a new watch. Throws if the active cap is hit so the tool
   * layer can surface the precise message verbatim.
   */
  add(input: WatchCreateInput): Watch {
    const all = this.loadCache();
    const active = all.filter((w) => w.enabled).length;
    if (active >= this.cap()) {
      throw new Error(
        `Maximal ${this.cap()} aktive Watches; bitte zuerst einen entfernen oder pausieren.`,
      );
    }
    const row: Watch = {
      id: randomUUID(),
      prompt: input.prompt.trim(),
      trigger: normaliseTrigger(input.trigger),
      cadence: input.cadence,
      createdAt: new Date().toISOString(),
      lastCheckedAt: null,
      hits: [],
      enabled: true,
    };
    if (this.writable) {
      try {
        appendFileSync(this.path, JSON.stringify(row) + "\n");
      } catch (err) {
        console.warn("[watches] append failed:", err);
      }
    }
    if (this.cache) this.cache.push(row);
    this.emit("changed", this.list());
    return row;
  }

  remove(id: string): boolean {
    return this.mutate((all) => {
      const idx = all.findIndex((w) => w.id === id);
      if (idx < 0) return null;
      all.splice(idx, 1);
      return all;
    });
  }

  setEnabled(id: string, enabled: boolean): boolean {
    return this.patch(id, { enabled });
  }

  markChecked(id: string, at: Date): boolean {
    return this.patch(id, { lastCheckedAt: at.toISOString() });
  }

  /**
   * Append a hit to the watch's history. Hits are capped at 20 most-
   * recent entries — the watch list view shows them inline; older hits
   * remain in the alerts store and stay reachable from the bell + /alerts.
   */
  recordHit(id: string, alertId: string, at: Date): boolean {
    const all = this.loadCache();
    const idx = all.findIndex((w) => w.id === id);
    if (idx < 0) return false;
    const next: WatchHit = { alertId, at: at.toISOString() };
    const hits = [next, ...all[idx]!.hits].slice(0, 20);
    all[idx] = { ...all[idx]!, hits, lastCheckedAt: at.toISOString() };
    return this.rewrite(all);
  }

  // ---- Internal -----------------------------------------------------------

  private patch(id: string, fields: Partial<Watch>): boolean {
    return this.mutate((all) => {
      const idx = all.findIndex((w) => w.id === id);
      if (idx < 0) return null;
      all[idx] = { ...all[idx]!, ...fields };
      return all;
    });
  }

  private mutate(fn: (all: Watch[]) => Watch[] | null): boolean {
    const all = this.loadCache();
    const next = fn(all.slice());
    if (next === null) return false;
    return this.rewrite(next);
  }

  private rewrite(all: Watch[]): boolean {
    this.cache = all;
    if (this.writable) {
      const tmp = `${this.path}.${process.pid}.tmp`;
      try {
        const body = all.map((w) => JSON.stringify(w)).join("\n");
        writeFileSync(tmp, body ? body + "\n" : "", { mode: 0o600 });
        renameSync(tmp, this.path);
      } catch (err) {
        console.warn("[watches] rewrite failed:", err);
        return false;
      }
    }
    this.emit("changed", this.list());
    return true;
  }

  private loadCache(): Watch[] {
    if (this.cache !== null) return this.cache;
    if (!existsSync(this.path)) {
      this.cache = [];
      return this.cache;
    }
    const out: Watch[] = [];
    try {
      const raw = readFileSync(this.path, "utf8");
      for (const line of raw.split(/\r?\n/)) {
        const trimmed = line.trim();
        if (!trimmed) continue;
        try {
          const parsed = JSON.parse(trimmed) as Partial<Watch>;
          if (isValidWatch(parsed)) out.push(parsed);
        } catch {
          // Tolerate manual edits / torn lines from a crashed write.
        }
      }
    } catch (err) {
      console.warn("[watches] read failed:", err);
    }
    this.cache = out;
    return this.cache;
  }
}

function isValidWatch(v: Partial<Watch>): v is Watch {
  return (
    typeof v.id === "string" &&
    typeof v.prompt === "string" &&
    typeof v.cadence === "string" &&
    typeof v.createdAt === "string" &&
    typeof v.enabled === "boolean" &&
    !!v.trigger &&
    typeof v.trigger.rubric === "string"
  );
}

function normaliseTrigger(t: WatchTrigger): WatchTrigger {
  const rubric = t.rubric.trim().slice(0, 500);
  const out: WatchTrigger = { rubric };
  if (Array.isArray(t.companyIds) && t.companyIds.length > 0) {
    out.companyIds = Array.from(
      new Set(
        t.companyIds.filter(
          (s): s is string => typeof s === "string" && s.length > 0,
        ),
      ),
    );
  }
  if (Array.isArray(t.topics) && t.topics.length > 0) {
    const allowed: AlertKind[] = [
      "publication",
      "financial-delta",
      "profile-change",
      "evaluation-flag",
    ];
    out.topics = Array.from(new Set(t.topics)).filter((k) =>
      allowed.includes(k),
    );
  }
  return out;
}

// v0.1.267 — ScheduledJobsSupervisor.
//
// Eine Instanz pro App. Hält Timer für alle "active"-Jobs in der DB
// und ruft beim Fälligkeitsschlag den registrierten Executor pro
// kind auf. Beim Boot werden alle Active-Jobs aus dem Store gelesen
// und timer reset (Persistenz übersteht Restart).
//
// Job-Lifecycle:
//   - active   → wird gepollt; nach Run wird nextRunAt += interval gesetzt
//   - paused   → kein Timer, manuell wieder aktivierbar (Settings-UI)
//   - expired  → expiresAt erreicht; auto-stop
//   - completed→ runsCap erreicht; auto-stop
//   - cancelled→ User hat Stop gesagt
//
// Pro Run wird ein Try-Catch ausgeführt; bei Fehler wird lastError
// in die DB geschrieben aber der Job läuft weiter (transienter
// Netzwerk-Fehler soll nicht den Loop killen). Wenn 5x in Folge
// Fehler → automatisch paused.

import { EventEmitter } from "node:events";
import type { ScheduledJob, ScheduledJobKind } from "../../shared/types";
import {
  ScheduledJobsStore,
  MAX_RUNS_CAP,
} from "./store";

/** Pro kind eine Function die den Job ausführt. Returnt void bei Erfolg,
 *  wirft bei Fehler. */
export type JobExecutor = (job: ScheduledJob) => Promise<void>;

const CONSECUTIVE_FAILURE_PAUSE_AT = 5;

export interface ScheduledJobsSupervisorEvents {
  changed: () => void;
}

export declare interface ScheduledJobsSupervisor {
  on<K extends keyof ScheduledJobsSupervisorEvents>(
    event: K,
    listener: ScheduledJobsSupervisorEvents[K],
  ): this;
  emit<K extends keyof ScheduledJobsSupervisorEvents>(
    event: K,
    ...args: Parameters<ScheduledJobsSupervisorEvents[K]>
  ): boolean;
}

export class ScheduledJobsSupervisor extends EventEmitter {
  private timers = new Map<string, NodeJS.Timeout>();
  private executors = new Map<ScheduledJobKind, JobExecutor>();
  /** Pro Job: wie viele Runs in Folge gefehlt haben. Reset bei Erfolg. */
  private consecutiveFailures = new Map<string, number>();
  private stopping = false;

  constructor(public readonly store: ScheduledJobsStore) {
    super();
    store.on("changed", () => this.emit("changed"));
  }

  registerExecutor(kind: ScheduledJobKind, executor: JobExecutor): void {
    this.executors.set(kind, executor);
  }

  /** Beim Boot vom main/index.ts aufgerufen. Re-armiert alle active-Jobs. */
  async start(): Promise<void> {
    await this.store.start();
    const active = await this.store.listActive();
    for (const job of active) {
      this.scheduleNextRun(job);
    }
  }

  async stop(): Promise<void> {
    this.stopping = true;
    for (const t of this.timers.values()) clearTimeout(t);
    this.timers.clear();
    await this.store.stop();
  }

  async createMailLoop(input: {
    label: string;
    payload: {
      to: string[];
      cc?: string[];
      subject: string;
      text: string;
    };
    intervalMinutes: number;
    firstRunImmediately: boolean;
    expiresAt: string;
    runsCap?: number;
    source: "agent" | "user";
  }): Promise<ScheduledJob> {
    const firstRunAt = input.firstRunImmediately
      ? new Date(Date.now() + 1000).toISOString() // 1s drift damit der Confirm noch sauber returnen kann
      : new Date(Date.now() + input.intervalMinutes * 60_000).toISOString();
    const job = await this.store.create({
      kind: "mail-send",
      label: input.label,
      payload: input.payload,
      intervalMinutes: input.intervalMinutes,
      firstRunAt,
      expiresAt: input.expiresAt,
      runsCap: input.runsCap,
      source: input.source,
    });
    this.scheduleNextRun(job);
    return job;
  }

  /**
   * v0.1.305 — Erinnerung anlegen. Einmalig (runsCap=1) oder
   * wiederkehrend (intervalMinutes>0 + runsCap>1).
   * `firstRunAt` = die ISO-Uhrzeit zu der der Reminder feuern soll.
   */
  async createReminder(input: {
    label: string;
    payload: {
      prompt: string;
      companyId?: string;
      companyName?: string;
    };
    firstRunAt: string;
    intervalMinutes: number;
    expiresAt: string;
    runsCap: number;
    source: "agent" | "user";
  }): Promise<ScheduledJob> {
    const job = await this.store.create({
      kind: "reminder",
      label: input.label,
      payload: input.payload,
      intervalMinutes: input.intervalMinutes,
      firstRunAt: input.firstRunAt,
      expiresAt: input.expiresAt,
      runsCap: input.runsCap,
      source: input.source,
    });
    this.scheduleNextRun(job);
    return job;
  }

  async cancel(id: string): Promise<void> {
    const t = this.timers.get(id);
    if (t) {
      clearTimeout(t);
      this.timers.delete(id);
    }
    this.consecutiveFailures.delete(id);
    await this.store.setStatus(id, "cancelled");
  }

  async pause(id: string): Promise<void> {
    const t = this.timers.get(id);
    if (t) {
      clearTimeout(t);
      this.timers.delete(id);
    }
    await this.store.setStatus(id, "paused");
  }

  async resume(id: string): Promise<void> {
    const job = await this.store.get(id);
    if (!job) return;
    if (job.status !== "paused") return;
    await this.store.setStatus(id, "active");
    const refreshed = await this.store.get(id);
    if (refreshed) this.scheduleNextRun(refreshed);
  }

  private scheduleNextRun(job: ScheduledJob): void {
    if (this.stopping) return;
    const existing = this.timers.get(job.id);
    if (existing) clearTimeout(existing);

    // Lifecycle-Checks
    if (job.status !== "active") return;
    const now = Date.now();
    const expiresAtMs = new Date(job.expiresAt).getTime();
    if (Number.isFinite(expiresAtMs) && expiresAtMs <= now) {
      void this.store.setStatus(job.id, "expired");
      return;
    }
    if (job.runsCompleted >= job.runsCap) {
      void this.store.setStatus(job.id, "completed");
      return;
    }

    const nextMs = new Date(job.nextRunAt).getTime();
    const delay = Math.max(1000, nextMs - now);
    // Cap auf 30 min — danach armieren wir neu (gegen setTimeout-Drift bei
    // langem Sleep/Wake).
    const cappedDelay = Math.min(delay, 30 * 60 * 1000);
    const timer = setTimeout(() => void this.fire(job.id), cappedDelay);
    this.timers.set(job.id, timer);
  }

  private async fire(id: string): Promise<void> {
    if (this.stopping) return;
    const job = await this.store.get(id);
    if (!job || job.status !== "active") return;

    const executor = this.executors.get(job.kind);
    if (!executor) {
      await this.store.recordRun(id, {
        nextRunAt: job.nextRunAt,
        runsCompleted: job.runsCompleted,
        lastError: `Kein Executor für kind=${job.kind} registriert.`,
        status: "paused",
      });
      return;
    }

    // Wenn die Fälligkeit noch nicht erreicht ist (z. B. wegen
    // delay-Cap), nur neu schedulen, nicht ausführen.
    const dueAt = new Date(job.nextRunAt).getTime();
    if (dueAt - Date.now() > 2_000) {
      this.scheduleNextRun(job);
      return;
    }

    let error: string | null = null;
    try {
      await executor(job);
    } catch (err) {
      error = err instanceof Error ? err.message : String(err);
    }

    const newRunsCompleted = job.runsCompleted + 1;
    const nextRunAt = new Date(
      Date.now() + job.intervalMinutes * 60_000,
    ).toISOString();

    let newStatus: ScheduledJob["status"] = job.status;
    if (error == null) {
      this.consecutiveFailures.delete(id);
    } else {
      const fails = (this.consecutiveFailures.get(id) ?? 0) + 1;
      this.consecutiveFailures.set(id, fails);
      if (fails >= CONSECUTIVE_FAILURE_PAUSE_AT) {
        newStatus = "paused";
      }
    }
    if (newRunsCompleted >= Math.min(job.runsCap, MAX_RUNS_CAP)) {
      newStatus = "completed";
    }
    const expiresAtMs = new Date(job.expiresAt).getTime();
    if (Number.isFinite(expiresAtMs) && new Date(nextRunAt).getTime() > expiresAtMs) {
      newStatus = "expired";
    }

    await this.store.recordRun(id, {
      nextRunAt,
      runsCompleted: newRunsCompleted,
      lastError: error,
      ...(newStatus !== job.status ? { status: newStatus } : {}),
    });

    if (newStatus === "active") {
      const refreshed = await this.store.get(id);
      if (refreshed) this.scheduleNextRun(refreshed);
    }
  }
}

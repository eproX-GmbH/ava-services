// v0.1.267 — Scheduled-Jobs Persistenz.
//
// PGlite-Tabelle scheduled_jobs. Eine Row pro Job. Übersteht App-
// Restart — Supervisor liest beim Boot alle "active"-Rows und armiert
// die Timer neu.
//
// Single-writer im main-process; Renderer liest via IPC-Snapshots.

import { EventEmitter } from "node:events";
import { mkdirSync } from "node:fs";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import { app } from "electron";
import type {
  ScheduledJob,
  ScheduledJobKind,
  ScheduledJobPayload,
  ScheduledJobStatus,
  ScheduledMailSendPayload,
} from "../../shared/types";

export const ACTIVE_JOB_CAP = 10;
export const MIN_INTERVAL_MINUTES = 1;
export const MAX_LIFETIME_MS = 7 * 24 * 60 * 60 * 1000;
export const DEFAULT_LIFETIME_MS = 24 * 60 * 60 * 1000;
export const MAX_RUNS_CAP = 1000;

interface PGliteInstance {
  query<T = unknown>(
    sql: string,
    params?: unknown[],
  ): Promise<{ rows: T[] }>;
  exec(sql: string): Promise<unknown>;
  close(): Promise<void>;
}

interface JobRow {
  id: string;
  kind: string;
  label: string;
  payload_json: string;
  interval_minutes: number | string;
  next_run_at: string;
  expires_at: string;
  runs_completed: number | string;
  runs_cap: number | string;
  status: string;
  created_at: string;
  last_error: string | null;
  source: string;
}

export interface ScheduledJobsStoreEvents {
  changed: () => void;
}

export declare interface ScheduledJobsStore {
  on<K extends keyof ScheduledJobsStoreEvents>(
    event: K,
    listener: ScheduledJobsStoreEvents[K],
  ): this;
  emit<K extends keyof ScheduledJobsStoreEvents>(
    event: K,
    ...args: Parameters<ScheduledJobsStoreEvents[K]>
  ): boolean;
}

export class ScheduledJobsStore extends EventEmitter {
  private pglite: PGliteInstance | null = null;
  private loading: Promise<void> | null = null;

  constructor(private readonly dataRoot = defaultDataRoot()) {
    super();
  }

  async start(): Promise<void> {
    if (this.pglite) return;
    if (this.loading) return this.loading;
    this.loading = (async () => {
      mkdirSync(this.dataRoot, { recursive: true });
      const mod = (await import("@electric-sql/pglite")) as unknown as {
        PGlite: new (path: string) => PGliteInstance;
      };
      this.pglite = new mod.PGlite(this.dataRoot);
      await this.applySchema();
    })();
    try {
      await this.loading;
    } finally {
      this.loading = null;
    }
  }

  async stop(): Promise<void> {
    if (!this.pglite) return;
    try {
      await this.pglite.close();
    } catch {
      /* shutdown */
    }
    this.pglite = null;
  }

  async create(input: {
    kind: ScheduledJobKind;
    label: string;
    /** v0.1.305 — Union-Payload (mail-send oder reminder). Persistiert
     *  als JSONB, Schema-Check erfolgt im jeweiligen Executor. */
    payload: ScheduledJobPayload;
    intervalMinutes: number;
    firstRunAt: string;
    expiresAt: string;
    runsCap?: number;
    source: "agent" | "user";
  }): Promise<ScheduledJob> {
    await this.start();
    const pg = this.requirePg();
    const active = await this.countActive();
    if (active >= ACTIVE_JOB_CAP) {
      throw new Error(
        `Maximal ${ACTIVE_JOB_CAP} parallel laufende Jobs erlaubt — bitte erst einen anderen stoppen.`,
      );
    }
    const job: ScheduledJob = {
      id: randomUUID(),
      kind: input.kind,
      label: input.label,
      payload: input.payload,
      intervalMinutes: input.intervalMinutes,
      nextRunAt: input.firstRunAt,
      expiresAt: input.expiresAt,
      runsCompleted: 0,
      runsCap: Math.min(input.runsCap ?? MAX_RUNS_CAP, MAX_RUNS_CAP),
      status: "active",
      createdAt: new Date().toISOString(),
      lastError: null,
      source: input.source,
    };
    await pg.query(
      `INSERT INTO scheduled_jobs
         (id, kind, label, payload_json, interval_minutes,
          next_run_at, expires_at, runs_completed, runs_cap,
          status, created_at, last_error, source)
       VALUES ($1, $2, $3, $4::jsonb, $5, $6, $7, $8, $9, $10, $11, $12, $13)`,
      [
        job.id,
        job.kind,
        job.label,
        JSON.stringify(job.payload),
        job.intervalMinutes,
        job.nextRunAt,
        job.expiresAt,
        job.runsCompleted,
        job.runsCap,
        job.status,
        job.createdAt,
        job.lastError,
        job.source,
      ],
    );
    this.emit("changed");
    return job;
  }

  async list(): Promise<ScheduledJob[]> {
    await this.start();
    const pg = this.requirePg();
    const res = await pg.query<JobRow>(
      `SELECT * FROM scheduled_jobs ORDER BY created_at DESC`,
    );
    return res.rows.map(rowToJob);
  }

  async countActive(): Promise<number> {
    await this.start();
    const pg = this.requirePg();
    const res = await pg.query<{ n: string | number }>(
      `SELECT COUNT(*)::text AS n FROM scheduled_jobs WHERE status = 'active'`,
    );
    const n = res.rows[0]?.n;
    return typeof n === "string" ? parseInt(n, 10) : Number(n ?? 0);
  }

  async listActive(): Promise<ScheduledJob[]> {
    await this.start();
    const pg = this.requirePg();
    const res = await pg.query<JobRow>(
      `SELECT * FROM scheduled_jobs WHERE status = 'active' ORDER BY next_run_at ASC`,
    );
    return res.rows.map(rowToJob);
  }

  async get(id: string): Promise<ScheduledJob | null> {
    await this.start();
    const pg = this.requirePg();
    const res = await pg.query<JobRow>(
      `SELECT * FROM scheduled_jobs WHERE id = $1`,
      [id],
    );
    const row = res.rows[0];
    return row ? rowToJob(row) : null;
  }

  async setStatus(id: string, status: ScheduledJobStatus): Promise<void> {
    await this.start();
    const pg = this.requirePg();
    await pg.query(`UPDATE scheduled_jobs SET status = $2 WHERE id = $1`, [
      id,
      status,
    ]);
    this.emit("changed");
  }

  async recordRun(
    id: string,
    update: {
      nextRunAt: string;
      runsCompleted: number;
      lastError: string | null;
      status?: ScheduledJobStatus;
    },
  ): Promise<void> {
    await this.start();
    const pg = this.requirePg();
    await pg.query(
      `UPDATE scheduled_jobs
          SET next_run_at = $2, runs_completed = $3, last_error = $4
            ${update.status ? ", status = $5" : ""}
        WHERE id = $1`,
      update.status
        ? [id, update.nextRunAt, update.runsCompleted, update.lastError, update.status]
        : [id, update.nextRunAt, update.runsCompleted, update.lastError],
    );
    this.emit("changed");
  }

  async delete(id: string): Promise<void> {
    await this.start();
    const pg = this.requirePg();
    await pg.query(`DELETE FROM scheduled_jobs WHERE id = $1`, [id]);
    this.emit("changed");
  }

  private requirePg(): PGliteInstance {
    if (!this.pglite) throw new Error("ScheduledJobsStore not started.");
    return this.pglite;
  }

  private async applySchema(): Promise<void> {
    const pg = this.requirePg();
    await pg.exec(`
      CREATE TABLE IF NOT EXISTS scheduled_jobs (
        id                TEXT PRIMARY KEY,
        kind              TEXT NOT NULL,
        label             TEXT NOT NULL,
        payload_json      JSONB NOT NULL,
        interval_minutes  INTEGER NOT NULL,
        next_run_at       TIMESTAMPTZ NOT NULL,
        expires_at        TIMESTAMPTZ NOT NULL,
        runs_completed    INTEGER NOT NULL DEFAULT 0,
        runs_cap          INTEGER NOT NULL DEFAULT 1000,
        status            TEXT NOT NULL DEFAULT 'active',
        created_at        TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        last_error        TEXT,
        source            TEXT NOT NULL DEFAULT 'agent'
      );
      CREATE INDEX IF NOT EXISTS scheduled_jobs_status_next_idx
        ON scheduled_jobs (status, next_run_at);
    `);
  }
}

function defaultDataRoot(): string {
  return join(app.getPath("userData"), "pglite", "scheduler");
}

function rowToJob(row: JobRow): ScheduledJob {
  const payloadRaw = row.payload_json as unknown;
  // v0.1.305 — Payload kann mail-send ODER reminder sein. Hier nur
  // strukturell zurückgeben; der jeweilige Executor narrowt anhand
  // von job.kind.
  const payload =
    typeof payloadRaw === "string"
      ? (JSON.parse(payloadRaw) as ScheduledJobPayload)
      : (payloadRaw as ScheduledJobPayload);
  return {
    id: row.id,
    kind: row.kind as ScheduledJobKind,
    label: row.label,
    payload,
    intervalMinutes: Number(row.interval_minutes),
    nextRunAt: row.next_run_at,
    expiresAt: row.expires_at,
    runsCompleted: Number(row.runs_completed),
    runsCap: Number(row.runs_cap),
    status: row.status as ScheduledJobStatus,
    createdAt: row.created_at,
    lastError: row.last_error,
    source: row.source === "user" ? "user" : "agent",
  };
}

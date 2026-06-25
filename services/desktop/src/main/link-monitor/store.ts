// LM1 — Link-Monitoring Persistenz.
//
// Zwei PGlite-Tabellen:
//   - link_monitors      : ein Row pro überwachtem Link (Config + Status)
//   - link_monitor_runs  : ein Row pro Durchlauf (Snapshot + Diff-Ergebnis)
//
// Übersteht App-Restart — der Supervisor liest beim Boot alle
// "active"-Monitore und armiert die Timer neu. Single-writer im
// main-process; der Renderer liest via IPC-Snapshots.
//
// Muster 1:1 von main/scheduler/store.ts übernommen.

import { EventEmitter } from "node:events";
import { mkdirSync } from "node:fs";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import { app } from "electron";
import {
  LINK_MONITOR_ACTIVE_CAP,
  LINK_MONITOR_DEFAULT_INTERVAL_MINUTES,
  LINK_MONITOR_MAX_INTERVAL_MINUTES,
  LINK_MONITOR_MIN_INTERVAL_MINUTES,
  type LinkMonitor,
  type LinkMonitorFrequencyPreset,
  type LinkMonitorRun,
  type LinkMonitorRunOutcome,
  type LinkMonitorStatus,
} from "../../shared/types";

interface PGliteInstance {
  query<T = unknown>(sql: string, params?: unknown[]): Promise<{ rows: T[] }>;
  exec(sql: string): Promise<unknown>;
  close(): Promise<void>;
}

interface MonitorRow {
  id: string;
  url: string;
  label: string;
  instructions: string;
  interval_minutes: number | string;
  frequency_preset: string;
  status: string;
  is_linkedin: boolean | string | number;
  created_at: string;
  last_checked_at: string | null;
  next_run_at: string;
  last_outcome: string | null;
  last_changed_at: string | null;
  last_change_summary: string | null;
  consecutive_failures: number | string;
  source: string;
}

interface RunRow {
  id: string;
  monitor_id: string;
  started_at: string;
  finished_at: string;
  outcome: string;
  content_hash: string;
  observations_json: string;
  change_summary: string | null;
  note: string | null;
}

export interface LinkMonitorStoreEvents {
  changed: () => void;
}

export declare interface LinkMonitorStore {
  on<K extends keyof LinkMonitorStoreEvents>(
    event: K,
    listener: LinkMonitorStoreEvents[K],
  ): this;
  emit<K extends keyof LinkMonitorStoreEvents>(
    event: K,
    ...args: Parameters<LinkMonitorStoreEvents[K]>
  ): boolean;
}

/** Clamp + Default für die Frequenz. */
export function clampInterval(minutes: number | undefined): number {
  if (!Number.isFinite(minutes) || minutes === undefined) {
    return LINK_MONITOR_DEFAULT_INTERVAL_MINUTES;
  }
  return Math.max(
    LINK_MONITOR_MIN_INTERVAL_MINUTES,
    Math.min(LINK_MONITOR_MAX_INTERVAL_MINUTES, Math.round(minutes)),
  );
}

export class LinkMonitorStore extends EventEmitter {
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

  /**
   * Legt einen Monitor an. Anlegen ist UNBEGRENZT erlaubt — aber nur
   * `LINK_MONITOR_ACTIVE_CAP` dürfen gleichzeitig "active" sein. Ist das
   * Limit erreicht, wird der neue Monitor "paused" angelegt (der Aufrufer
   * informiert den Nutzer). So geht nie ein Wunsch verloren.
   */
  async create(input: {
    url: string;
    label: string;
    instructions: string;
    intervalMinutes: number;
    frequencyPreset: LinkMonitorFrequencyPreset;
    isLinkedIn: boolean;
    source: "agent" | "user";
  }): Promise<LinkMonitor> {
    await this.start();
    const pg = this.requirePg();
    const active = await this.countActive();
    const status: LinkMonitorStatus =
      active < LINK_MONITOR_ACTIVE_CAP ? "active" : "paused";
    const now = new Date();
    const interval = clampInterval(input.intervalMinutes);
    const monitor: LinkMonitor = {
      id: randomUUID(),
      url: input.url,
      label: input.label,
      instructions: input.instructions,
      intervalMinutes: interval,
      frequencyPreset: input.frequencyPreset,
      status,
      isLinkedIn: input.isLinkedIn,
      createdAt: now.toISOString(),
      lastCheckedAt: null,
      // Erster Durchlauf: bei "active" sofort fällig, sonst Platzhalter.
      nextRunAt: now.toISOString(),
      lastOutcome: null,
      lastChangedAt: null,
      lastChangeSummary: null,
      consecutiveFailures: 0,
      source: input.source,
    };
    await pg.query(
      `INSERT INTO link_monitors
         (id, url, label, instructions, interval_minutes, frequency_preset,
          status, is_linkedin, created_at, last_checked_at, next_run_at,
          last_outcome, last_changed_at, last_change_summary,
          consecutive_failures, source)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16)`,
      [
        monitor.id,
        monitor.url,
        monitor.label,
        monitor.instructions,
        monitor.intervalMinutes,
        monitor.frequencyPreset,
        monitor.status,
        monitor.isLinkedIn,
        monitor.createdAt,
        monitor.lastCheckedAt,
        monitor.nextRunAt,
        monitor.lastOutcome,
        monitor.lastChangedAt,
        monitor.lastChangeSummary,
        monitor.consecutiveFailures,
        monitor.source,
      ],
    );
    this.emit("changed");
    return monitor;
  }

  async list(): Promise<LinkMonitor[]> {
    await this.start();
    const pg = this.requirePg();
    const res = await pg.query<MonitorRow>(
      `SELECT * FROM link_monitors ORDER BY created_at DESC`,
    );
    return res.rows.map(rowToMonitor);
  }

  async listActive(): Promise<LinkMonitor[]> {
    await this.start();
    const pg = this.requirePg();
    const res = await pg.query<MonitorRow>(
      `SELECT * FROM link_monitors WHERE status = 'active' ORDER BY next_run_at ASC`,
    );
    return res.rows.map(rowToMonitor);
  }

  async get(id: string): Promise<LinkMonitor | null> {
    await this.start();
    const pg = this.requirePg();
    const res = await pg.query<MonitorRow>(
      `SELECT * FROM link_monitors WHERE id = $1`,
      [id],
    );
    const row = res.rows[0];
    return row ? rowToMonitor(row) : null;
  }

  async countActive(): Promise<number> {
    await this.start();
    const pg = this.requirePg();
    const res = await pg.query<{ n: string | number }>(
      `SELECT COUNT(*)::text AS n FROM link_monitors WHERE status = 'active'`,
    );
    const n = res.rows[0]?.n;
    return typeof n === "string" ? parseInt(n, 10) : Number(n ?? 0);
  }

  /** Editierbare Felder aktualisieren. Frequenz wird geklemmt. */
  async update(
    id: string,
    patch: {
      url?: string;
      label?: string;
      instructions?: string;
      intervalMinutes?: number;
      frequencyPreset?: LinkMonitorFrequencyPreset;
      isLinkedIn?: boolean;
    },
  ): Promise<LinkMonitor | null> {
    await this.start();
    const pg = this.requirePg();
    const current = await this.get(id);
    if (!current) return null;
    const next: LinkMonitor = {
      ...current,
      url: patch.url ?? current.url,
      label: patch.label ?? current.label,
      instructions: patch.instructions ?? current.instructions,
      intervalMinutes:
        patch.intervalMinutes !== undefined
          ? clampInterval(patch.intervalMinutes)
          : current.intervalMinutes,
      frequencyPreset: patch.frequencyPreset ?? current.frequencyPreset,
      isLinkedIn: patch.isLinkedIn ?? current.isLinkedIn,
    };
    await pg.query(
      `UPDATE link_monitors
          SET url = $2, label = $3, instructions = $4,
              interval_minutes = $5, frequency_preset = $6, is_linkedin = $7
        WHERE id = $1`,
      [
        id,
        next.url,
        next.label,
        next.instructions,
        next.intervalMinutes,
        next.frequencyPreset,
        next.isLinkedIn,
      ],
    );
    this.emit("changed");
    return next;
  }

  /**
   * Status setzen. Beim Wechsel auf "active" wird der Active-Cap geprüft:
   * Sind bereits 5 aktiv, schlägt der Aufruf mit klarer Fehlermeldung fehl.
   * Optional kann `nextRunAt` mitgesetzt werden (z. B. beim Resume sofort
   * fällig stellen).
   */
  async setStatus(
    id: string,
    status: LinkMonitorStatus,
    opts: { nextRunAt?: string; resetFailures?: boolean } = {},
  ): Promise<void> {
    await this.start();
    const pg = this.requirePg();
    if (status === "active") {
      const current = await this.get(id);
      if (current && current.status !== "active") {
        const active = await this.countActive();
        if (active >= LINK_MONITOR_ACTIVE_CAP) {
          throw new Error(
            `Maximal ${LINK_MONITOR_ACTIVE_CAP} Überwachungen gleichzeitig aktiv — bitte erst eine andere pausieren.`,
          );
        }
      }
    }
    await pg.query(
      `UPDATE link_monitors
          SET status = $2,
              next_run_at = COALESCE($3, next_run_at),
              consecutive_failures = CASE WHEN $4 THEN 0 ELSE consecutive_failures END
        WHERE id = $1`,
      [id, status, opts.nextRunAt ?? null, opts.resetFailures ?? false],
    );
    this.emit("changed");
  }

  /**
   * Ergebnis eines Durchlaufs persistieren: Run-Row anlegen UND den
   * Monitor (nextRunAt, lastCheckedAt, lastOutcome, Failures, ggf. Status
   * und Change-Felder) aktualisieren — in einem Rutsch.
   */
  async recordRun(
    run: Omit<LinkMonitorRun, "id">,
    monitorUpdate: {
      nextRunAt: string;
      lastCheckedAt: string;
      lastOutcome: LinkMonitorRunOutcome;
      consecutiveFailures: number;
      status?: LinkMonitorStatus;
      lastChangedAt?: string | null;
      lastChangeSummary?: string | null;
    },
  ): Promise<LinkMonitorRun> {
    await this.start();
    const pg = this.requirePg();
    const row: LinkMonitorRun = { id: randomUUID(), ...run };
    await pg.query(
      `INSERT INTO link_monitor_runs
         (id, monitor_id, started_at, finished_at, outcome,
          content_hash, observations_json, change_summary, note)
       VALUES ($1,$2,$3,$4,$5,$6,$7::jsonb,$8,$9)`,
      [
        row.id,
        row.monitorId,
        row.startedAt,
        row.finishedAt,
        row.outcome,
        row.contentHash,
        JSON.stringify(row.observations ?? null),
        row.changeSummary,
        row.note,
      ],
    );
    await pg.query(
      `UPDATE link_monitors
          SET next_run_at = $2,
              last_checked_at = $3,
              last_outcome = $4,
              consecutive_failures = $5,
              status = COALESCE($6, status),
              last_changed_at = COALESCE($7, last_changed_at),
              last_change_summary = COALESCE($8, last_change_summary)
        WHERE id = $1`,
      [
        run.monitorId,
        monitorUpdate.nextRunAt,
        monitorUpdate.lastCheckedAt,
        monitorUpdate.lastOutcome,
        monitorUpdate.consecutiveFailures,
        monitorUpdate.status ?? null,
        monitorUpdate.lastChangedAt ?? null,
        monitorUpdate.lastChangeSummary ?? null,
      ],
    );
    this.emit("changed");
    return row;
  }

  /** Letzter erfolgreicher Durchlauf (ok|changed) als Diff-Basis. */
  async latestSuccessfulRun(monitorId: string): Promise<LinkMonitorRun | null> {
    await this.start();
    const pg = this.requirePg();
    const res = await pg.query<RunRow>(
      `SELECT * FROM link_monitor_runs
        WHERE monitor_id = $1 AND outcome IN ('ok','changed')
        ORDER BY finished_at DESC
        LIMIT 1`,
      [monitorId],
    );
    const row = res.rows[0];
    return row ? rowToRun(row) : null;
  }

  /** Jüngste Durchläufe (für die UI / Verlauf). */
  async listRuns(monitorId: string, limit = 20): Promise<LinkMonitorRun[]> {
    await this.start();
    const pg = this.requirePg();
    const res = await pg.query<RunRow>(
      `SELECT * FROM link_monitor_runs
        WHERE monitor_id = $1
        ORDER BY finished_at DESC
        LIMIT $2`,
      [monitorId, limit],
    );
    return res.rows.map(rowToRun);
  }

  /** Alte Run-Rows kappen — nur die jüngsten `keep` pro Monitor halten. */
  async pruneRuns(monitorId: string, keep = 50): Promise<void> {
    await this.start();
    const pg = this.requirePg();
    await pg.query(
      `DELETE FROM link_monitor_runs
        WHERE monitor_id = $1
          AND id NOT IN (
            SELECT id FROM link_monitor_runs
             WHERE monitor_id = $1
             ORDER BY finished_at DESC
             LIMIT $2
          )`,
      [monitorId, keep],
    );
  }

  async delete(id: string): Promise<void> {
    await this.start();
    const pg = this.requirePg();
    await pg.query(`DELETE FROM link_monitor_runs WHERE monitor_id = $1`, [id]);
    await pg.query(`DELETE FROM link_monitors WHERE id = $1`, [id]);
    this.emit("changed");
  }

  private requirePg(): PGliteInstance {
    if (!this.pglite) throw new Error("LinkMonitorStore not started.");
    return this.pglite;
  }

  private async applySchema(): Promise<void> {
    const pg = this.requirePg();
    await pg.exec(`
      CREATE TABLE IF NOT EXISTS link_monitors (
        id                    TEXT PRIMARY KEY,
        url                   TEXT NOT NULL,
        label                 TEXT NOT NULL DEFAULT '',
        instructions          TEXT NOT NULL DEFAULT '',
        interval_minutes      INTEGER NOT NULL,
        frequency_preset      TEXT NOT NULL DEFAULT 'daily',
        status                TEXT NOT NULL DEFAULT 'active',
        is_linkedin           BOOLEAN NOT NULL DEFAULT FALSE,
        created_at            TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        last_checked_at       TIMESTAMPTZ,
        next_run_at           TIMESTAMPTZ NOT NULL,
        last_outcome          TEXT,
        last_changed_at       TIMESTAMPTZ,
        last_change_summary   TEXT,
        consecutive_failures  INTEGER NOT NULL DEFAULT 0,
        source                TEXT NOT NULL DEFAULT 'user'
      );
      CREATE INDEX IF NOT EXISTS link_monitors_status_next_idx
        ON link_monitors (status, next_run_at);

      CREATE TABLE IF NOT EXISTS link_monitor_runs (
        id                TEXT PRIMARY KEY,
        monitor_id        TEXT NOT NULL,
        started_at        TIMESTAMPTZ NOT NULL,
        finished_at       TIMESTAMPTZ NOT NULL,
        outcome           TEXT NOT NULL,
        content_hash      TEXT NOT NULL DEFAULT '',
        observations_json JSONB,
        change_summary    TEXT,
        note              TEXT
      );
      CREATE INDEX IF NOT EXISTS link_monitor_runs_monitor_idx
        ON link_monitor_runs (monitor_id, finished_at DESC);
    `);
  }
}

function defaultDataRoot(): string {
  return join(app.getPath("userData"), "pglite", "link-monitor");
}

function toBool(v: boolean | string | number): boolean {
  if (typeof v === "boolean") return v;
  if (typeof v === "number") return v !== 0;
  return v === "t" || v === "true" || v === "1";
}

function rowToMonitor(row: MonitorRow): LinkMonitor {
  return {
    id: row.id,
    url: row.url,
    label: row.label,
    instructions: row.instructions,
    intervalMinutes: Number(row.interval_minutes),
    frequencyPreset: row.frequency_preset as LinkMonitorFrequencyPreset,
    status: row.status as LinkMonitorStatus,
    isLinkedIn: toBool(row.is_linkedin),
    createdAt: row.created_at,
    lastCheckedAt: row.last_checked_at,
    nextRunAt: row.next_run_at,
    lastOutcome: (row.last_outcome as LinkMonitorRunOutcome | null) ?? null,
    lastChangedAt: row.last_changed_at,
    lastChangeSummary: row.last_change_summary,
    consecutiveFailures: Number(row.consecutive_failures),
    source: row.source === "agent" ? "agent" : "user",
  };
}

function rowToRun(row: RunRow): LinkMonitorRun {
  const raw = row.observations_json as unknown;
  const observations =
    typeof raw === "string" ? safeJson(raw) : (raw ?? null);
  return {
    id: row.id,
    monitorId: row.monitor_id,
    startedAt: row.started_at,
    finishedAt: row.finished_at,
    outcome: row.outcome as LinkMonitorRunOutcome,
    contentHash: row.content_hash,
    observations,
    changeSummary: row.change_summary,
    note: row.note,
  };
}

function safeJson(s: string): unknown {
  try {
    return JSON.parse(s);
  } catch {
    return null;
  }
}

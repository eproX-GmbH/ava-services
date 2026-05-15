// v0.1.200 — local-first Audit-Trail store.
//
// Storage: an embedded PGlite instance under
//   `<userData>/pglite/audit/`
// Privacy-first: the audit log NEVER leaves the user's machine.
// Producer / gateway events that originate elsewhere are ferried in
// via the existing AMQP routing-keys and inserted by the local
// consumer in main/index.ts.
//
// Why a dedicated PGlite database (not a table in the producer DBs):
//   - Clean separation: audit data has different retention rules
//     than producer caches.
//   - Producer caches can be wiped without losing the trail.
//   - Schema migration is independent of the producer Prisma
//     migrations.
//
// Concurrency: PGlite is single-writer per process. We embed it
// directly in the main process (no pg-gateway / TCP roundtrip) so
// all inserts are in-process. Readers (IPC handlers) and the
// retention purge also run in-process. No external client ever
// touches this DB.

import { EventEmitter } from "node:events";
import { mkdirSync } from "node:fs";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import { app } from "electron";
import type {
  AuditEvent,
  AuditEventInput,
  AuditListQuery,
  AuditListResponse,
} from "./audit-types";

/** Default page size for audit:list. Mirrors the API conventions
 *  elsewhere in the app. */
const DEFAULT_PAGE_SIZE = 50;
const MAX_PAGE_SIZE = 200;

/** Retention policy: keep info-events for N days, warning/error for
 *  M days. Tunable here; the purge job runs daily on app start +
 *  every 24 h. v0.1.200 ships with conservative defaults. */
const RETENTION_DAYS_INFO = 90;
const RETENTION_DAYS_WARN_ERROR = 365;

interface PGliteInstance {
  query<T = unknown>(
    sql: string,
    params?: unknown[],
  ): Promise<{ rows: T[]; affectedRows?: number }>;
  exec(sql: string): Promise<unknown>;
  close(): Promise<void>;
}

/** Row shape returned from PGlite — snake_case columns. */
interface AuditRow {
  id: string;
  timestamp: string;
  actor_type: string;
  actor_id: string | null;
  category: string;
  action: string;
  severity: string;
  subject_type: string | null;
  subject_id: string | null;
  summary: string;
  metadata: Record<string, unknown> | string;
}

export interface AuditStoreEvents {
  /** Emitted after every successful insert. Renderer can subscribe
   *  via IPC to live-tail. Payload is the just-stored event. */
  inserted: (event: AuditEvent) => void;
}

export declare interface AuditStore {
  on<K extends keyof AuditStoreEvents>(
    event: K,
    listener: AuditStoreEvents[K],
  ): this;
  emit<K extends keyof AuditStoreEvents>(
    event: K,
    ...args: Parameters<AuditStoreEvents[K]>
  ): boolean;
}

export class AuditStore extends EventEmitter {
  private pglite: PGliteInstance | null = null;
  private loading: Promise<void> | null = null;

  constructor(private readonly dataRoot = defaultDataRoot()) {
    super();
  }

  /** Lazy-load PGlite + apply schema. Idempotent: re-callable, only
   *  the first invocation does work. */
  async start(): Promise<void> {
    if (this.pglite) return;
    if (this.loading) return this.loading;
    this.loading = (async () => {
      mkdirSync(this.dataRoot, { recursive: true });
      // PGlite is ESM-only; dynamic import keeps the CommonJS main
      // bundle valid (same trick the producer postgres-supervisor uses).
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
      /* swallow — shutdown path */
    }
    this.pglite = null;
  }

  /** Insert one event. Fills `id` + `timestamp` if not provided. */
  async append(input: AuditEventInput): Promise<AuditEvent> {
    await this.start();
    const pg = this.requirePg();
    const event: AuditEvent = {
      id: randomUUID(),
      timestamp: input.timestamp ?? new Date().toISOString(),
      actorType: input.actorType,
      actorId: input.actorId ?? null,
      category: input.category,
      action: input.action,
      severity: input.severity,
      subjectType: input.subjectType ?? null,
      subjectId: input.subjectId ?? null,
      summary: input.summary,
      metadata: input.metadata ?? {},
    };
    await pg.query(
      `INSERT INTO audit_log
         (id, timestamp, actor_type, actor_id, category, action,
          severity, subject_type, subject_id, summary, metadata)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11::jsonb)`,
      [
        event.id,
        event.timestamp,
        event.actorType,
        event.actorId,
        event.category,
        event.action,
        event.severity,
        event.subjectType,
        event.subjectId,
        event.summary,
        JSON.stringify(event.metadata),
      ],
    );
    this.emit("inserted", event);
    return event;
  }

  /** Cursor-paginated query. The cursor encodes the last seen
   *  (timestamp, id) so pagination is deterministic even when new
   *  events arrive between calls. */
  async list(query: AuditListQuery): Promise<AuditListResponse> {
    await this.start();
    const pg = this.requirePg();
    const pageSize = clamp(
      query.pageSize ?? DEFAULT_PAGE_SIZE,
      1,
      MAX_PAGE_SIZE,
    );

    const wheres: string[] = [];
    const params: unknown[] = [];
    const push = (clause: string, value: unknown): void => {
      params.push(value);
      wheres.push(clause.replace("?", `$${params.length}`));
    };

    if (query.since) push(`timestamp >= ?`, query.since);
    if (query.until) push(`timestamp <  ?`, query.until);
    if (query.categories && query.categories.length > 0)
      push(`category = ANY(?)`, query.categories);
    if (query.severities && query.severities.length > 0)
      push(`severity = ANY(?)`, query.severities);
    if (query.actorTypes && query.actorTypes.length > 0)
      push(`actor_type = ANY(?)`, query.actorTypes);
    if (query.subjectType !== undefined && query.subjectType !== null) {
      push(`subject_type = ?`, query.subjectType);
      if (query.subjectId) push(`subject_id = ?`, query.subjectId);
    }
    if (query.search && query.search.trim().length > 0) {
      const like = `%${query.search.trim()}%`;
      push(`(summary ILIKE ? OR action ILIKE ?)`, like);
      // The previous push only consumed one param; re-use the same
      // value for the second ILIKE by appending it manually.
      params.push(like);
      const lastIdx = wheres.length - 1;
      const lastClause = wheres[lastIdx];
      if (lastClause) {
        wheres[lastIdx] = lastClause.replace("?", `$${params.length}`);
      }
    }

    // Cursor handling. Pagination is (timestamp DESC, id DESC) so the
    // cursor stays stable even when two events share a timestamp.
    const cursor = decodeCursor(query.pageToken ?? null);
    if (cursor) {
      params.push(cursor.timestamp);
      params.push(cursor.timestamp);
      params.push(cursor.id);
      wheres.push(
        `(timestamp < $${params.length - 2}
          OR (timestamp = $${params.length - 1} AND id < $${params.length}))`,
      );
    }

    const whereSql = wheres.length > 0 ? `WHERE ${wheres.join(" AND ")}` : "";
    const sql = `
      SELECT id, timestamp, actor_type, actor_id, category, action,
             severity, subject_type, subject_id, summary, metadata
      FROM audit_log
      ${whereSql}
      ORDER BY timestamp DESC, id DESC
      LIMIT ${pageSize + 1}
    `;
    const res = await pg.query<AuditRow>(sql, params);
    const overflow = res.rows.length > pageSize;
    const rows = overflow ? res.rows.slice(0, pageSize) : res.rows;
    const events = rows.map(rowToEvent);

    const last = events.length > 0 ? events[events.length - 1] : null;
    const nextPageToken =
      overflow && last
        ? encodeCursor({ timestamp: last.timestamp, id: last.id })
        : null;

    // Cheap COUNT(*) only when no filter — full scan is cheap on
    // small datasets but quickly becomes expensive. Return -1 once
    // the table exceeds 10k rows; the UI displays it as "10k+" then.
    let totalEstimate = -1;
    if (wheres.length === 0) {
      const countRes = await pg.query<{ n: string | number }>(
        `SELECT COUNT(*) AS n FROM audit_log`,
      );
      const n = Number(countRes.rows[0]?.n ?? 0);
      totalEstimate = n < 10000 ? n : -1;
    }

    return { events, nextPageToken, totalEstimate };
  }

  /** Drop a single event by id. Currently only used by tests; the
   *  retention job uses a bulk DELETE instead. */
  async deleteById(id: string): Promise<void> {
    await this.start();
    const pg = this.requirePg();
    await pg.query(`DELETE FROM audit_log WHERE id = $1`, [id]);
  }

  /** Drop the entire log. Surfaced to the user via the Settings UI
   *  ("Audit-Trail leeren") for privacy / fresh-start scenarios.
   *  Returns the number of rows removed. */
  async purgeAll(): Promise<number> {
    await this.start();
    const pg = this.requirePg();
    const res = await pg.query<{ n: string | number }>(
      `WITH d AS (DELETE FROM audit_log RETURNING 1)
       SELECT COUNT(*)::text AS n FROM d`,
    );
    return Number(res.rows[0]?.n ?? 0);
  }

  /** Retention sweep — runs daily from main/index.ts. Removes:
   *   - info events older than RETENTION_DAYS_INFO
   *   - warning/error events older than RETENTION_DAYS_WARN_ERROR
   *  Returns the count removed across both passes.
   */
  async purgeExpired(): Promise<number> {
    await this.start();
    const pg = this.requirePg();
    const cutoffInfo = new Date(
      Date.now() - RETENTION_DAYS_INFO * 24 * 60 * 60 * 1000,
    ).toISOString();
    const cutoffWarn = new Date(
      Date.now() - RETENTION_DAYS_WARN_ERROR * 24 * 60 * 60 * 1000,
    ).toISOString();
    const a = await pg.query(
      `DELETE FROM audit_log WHERE severity = 'info' AND timestamp < $1`,
      [cutoffInfo],
    );
    const b = await pg.query(
      `DELETE FROM audit_log
       WHERE severity IN ('warning','error') AND timestamp < $1`,
      [cutoffWarn],
    );
    return (a.affectedRows ?? 0) + (b.affectedRows ?? 0);
  }

  private requirePg(): PGliteInstance {
    if (!this.pglite) throw new Error("AuditStore not started");
    return this.pglite;
  }

  private async applySchema(): Promise<void> {
    const pg = this.requirePg();
    // PGlite supports DO blocks but keep this plain CREATE-IF-NOT-EXISTS.
    await pg.exec(`
      CREATE TABLE IF NOT EXISTS audit_log (
        id           TEXT PRIMARY KEY,
        timestamp    TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        actor_type   TEXT NOT NULL,
        actor_id     TEXT,
        category     TEXT NOT NULL,
        action       TEXT NOT NULL,
        severity     TEXT NOT NULL DEFAULT 'info',
        subject_type TEXT,
        subject_id   TEXT,
        summary      TEXT NOT NULL,
        metadata     JSONB NOT NULL DEFAULT '{}'::jsonb
      );
      CREATE INDEX IF NOT EXISTS audit_log_timestamp_idx
        ON audit_log (timestamp DESC);
      CREATE INDEX IF NOT EXISTS audit_log_category_idx
        ON audit_log (category);
      CREATE INDEX IF NOT EXISTS audit_log_severity_idx
        ON audit_log (severity);
      CREATE INDEX IF NOT EXISTS audit_log_subject_idx
        ON audit_log (subject_type, subject_id);
    `);
  }
}

function defaultDataRoot(): string {
  // app.getPath("userData") gives us the per-tenant Electron
  // userData dir. We carve out a `pglite/audit/` subdir; PGlite
  // mounts a SQLite-like WAL file there.
  return join(app.getPath("userData"), "pglite", "audit");
}

function clamp(n: number, lo: number, hi: number): number {
  return Math.max(lo, Math.min(hi, n));
}

function rowToEvent(r: AuditRow): AuditEvent {
  return {
    id: r.id,
    timestamp:
      typeof r.timestamp === "string"
        ? r.timestamp
        : new Date(r.timestamp as unknown as number).toISOString(),
    actorType: r.actor_type as AuditEvent["actorType"],
    actorId: r.actor_id,
    category: r.category as AuditEvent["category"],
    action: r.action,
    severity: r.severity as AuditEvent["severity"],
    subjectType: r.subject_type as AuditEvent["subjectType"],
    subjectId: r.subject_id,
    summary: r.summary,
    metadata:
      typeof r.metadata === "string"
        ? safeJsonParse(r.metadata)
        : (r.metadata ?? {}),
  };
}

function safeJsonParse(s: string): Record<string, unknown> {
  try {
    const v = JSON.parse(s);
    return typeof v === "object" && v != null
      ? (v as Record<string, unknown>)
      : {};
  } catch {
    return {};
  }
}

interface Cursor {
  timestamp: string;
  id: string;
}

function encodeCursor(c: Cursor): string {
  return Buffer.from(JSON.stringify(c), "utf8").toString("base64url");
}

function decodeCursor(raw: string | null): Cursor | null {
  if (!raw) return null;
  try {
    const parsed = JSON.parse(
      Buffer.from(raw, "base64url").toString("utf8"),
    ) as Cursor;
    if (typeof parsed.timestamp === "string" && typeof parsed.id === "string")
      return parsed;
  } catch {
    /* fall through */
  }
  return null;
}

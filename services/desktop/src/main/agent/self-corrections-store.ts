// v0.1.284 — Self-Corrections-Store.
//
// AVA meldet via `report_self_correction`-Tool, wenn sie nach einem
// fehlgeschlagenen Tool-Call einen Workaround gefunden hat. Die Events
// liegen lokal in PGlite, verlassen die Maschine nicht — sie sind ein
// Feedback-Kanal vom Agenten zum Entwickler: wo gibt es wiederkehrende
// Tool-Probleme, die im Code gefixt werden sollten, statt dass jeder
// Nutzer sie einzeln umgehen muss.
//
// Datenpfad: <userData>/pglite/self-corrections/. Retention 90 Tage.

import { EventEmitter } from "node:events";
import { mkdirSync } from "node:fs";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import { app } from "electron";
import type {
  SelfCorrectionEvent,
  SelfCorrectionEventInput,
  SelfCorrectionListQuery,
  SelfCorrectionListResponse,
} from "../../shared/types";

const RETENTION_DAYS = 90;
const DEFAULT_PAGE_SIZE = 50;
const MAX_PAGE_SIZE = 200;

interface PGliteInstance {
  query<T = unknown>(
    sql: string,
    params?: unknown[],
  ): Promise<{ rows: T[]; affectedRows?: number }>;
  exec(sql: string): Promise<unknown>;
  close(): Promise<void>;
}

interface Row {
  id: string;
  timestamp: string;
  conversation_id: string | null;
  attempted_tool: string;
  failed_reason: string;
  workaround: string;
  suggested_code_fix: string | null;
  raw_error_preview: string | null;
}

export interface SelfCorrectionsStoreEvents {
  inserted: (event: SelfCorrectionEvent) => void;
}

export declare interface SelfCorrectionsStore {
  on<K extends keyof SelfCorrectionsStoreEvents>(
    event: K,
    listener: SelfCorrectionsStoreEvents[K],
  ): this;
  emit<K extends keyof SelfCorrectionsStoreEvents>(
    event: K,
    ...args: Parameters<SelfCorrectionsStoreEvents[K]>
  ): boolean;
}

export class SelfCorrectionsStore extends EventEmitter {
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

  async record(input: SelfCorrectionEventInput): Promise<SelfCorrectionEvent> {
    await this.start();
    const pg = this.requirePg();
    const event: SelfCorrectionEvent = {
      id: randomUUID(),
      timestamp: new Date().toISOString(),
      conversationId: input.conversationId ?? null,
      attemptedTool: input.attemptedTool,
      failedReason: input.failedReason,
      workaround: input.workaround,
      suggestedCodeFix: input.suggestedCodeFix ?? null,
      rawErrorPreview: input.rawErrorPreview ?? null,
    };
    await pg.query(
      `INSERT INTO self_corrections
         (id, timestamp, conversation_id, attempted_tool, failed_reason,
          workaround, suggested_code_fix, raw_error_preview)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8)`,
      [
        event.id,
        event.timestamp,
        event.conversationId,
        event.attemptedTool,
        event.failedReason,
        event.workaround,
        event.suggestedCodeFix,
        event.rawErrorPreview,
      ],
    );
    this.emit("inserted", event);
    return event;
  }

  async list(query: SelfCorrectionListQuery = {}): Promise<SelfCorrectionListResponse> {
    await this.start();
    const pg = this.requirePg();
    const pageSize = Math.min(query.pageSize ?? DEFAULT_PAGE_SIZE, MAX_PAGE_SIZE);
    const offset = ((query.page ?? 1) - 1) * pageSize;
    const wheres: string[] = [];
    const params: unknown[] = [];
    if (query.since) {
      params.push(query.since);
      wheres.push(`timestamp >= $${params.length}`);
    }
    if (query.attemptedTool) {
      params.push(query.attemptedTool);
      wheres.push(`attempted_tool = $${params.length}`);
    }
    const where = wheres.length > 0 ? `WHERE ${wheres.join(" AND ")}` : "";

    const countRes = await pg.query<{ n: string | number }>(
      `SELECT COUNT(*)::text AS n FROM self_corrections ${where}`,
      params,
    );
    const total = parseInt(String(countRes.rows[0]?.n ?? 0), 10);

    params.push(pageSize, offset);
    const res = await pg.query<Row>(
      `SELECT * FROM self_corrections
       ${where}
       ORDER BY timestamp DESC
       LIMIT $${params.length - 1} OFFSET $${params.length}`,
      params,
    );

    return {
      total,
      page: query.page ?? 1,
      pageSize,
      items: res.rows.map(rowToEvent),
    };
  }

  async deleteOne(id: string): Promise<void> {
    await this.start();
    const pg = this.requirePg();
    await pg.query(`DELETE FROM self_corrections WHERE id = $1`, [id]);
  }

  async deleteAll(): Promise<void> {
    await this.start();
    const pg = this.requirePg();
    await pg.exec(`DELETE FROM self_corrections`);
  }

  async purgeOlderThanRetention(): Promise<void> {
    await this.start();
    const pg = this.requirePg();
    const cutoff = new Date(Date.now() - RETENTION_DAYS * 86_400_000).toISOString();
    await pg.query(`DELETE FROM self_corrections WHERE timestamp < $1`, [cutoff]);
  }

  private requirePg(): PGliteInstance {
    if (!this.pglite) throw new Error("SelfCorrectionsStore nicht gestartet.");
    return this.pglite;
  }

  private async applySchema(): Promise<void> {
    const pg = this.requirePg();
    await pg.exec(`
      CREATE TABLE IF NOT EXISTS self_corrections (
        id                   TEXT PRIMARY KEY,
        timestamp            TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        conversation_id      TEXT,
        attempted_tool       TEXT NOT NULL,
        failed_reason        TEXT NOT NULL,
        workaround           TEXT NOT NULL,
        suggested_code_fix   TEXT,
        raw_error_preview    TEXT
      );
      CREATE INDEX IF NOT EXISTS self_corrections_timestamp_idx
        ON self_corrections (timestamp DESC);
      CREATE INDEX IF NOT EXISTS self_corrections_tool_idx
        ON self_corrections (attempted_tool);
    `);
  }
}

function defaultDataRoot(): string {
  return join(app.getPath("userData"), "pglite", "self-corrections");
}

function rowToEvent(row: Row): SelfCorrectionEvent {
  return {
    id: row.id,
    timestamp: row.timestamp,
    conversationId: row.conversation_id,
    attemptedTool: row.attempted_tool,
    failedReason: row.failed_reason,
    workaround: row.workaround,
    suggestedCodeFix: row.suggested_code_fix,
    rawErrorPreview: row.raw_error_preview,
  };
}

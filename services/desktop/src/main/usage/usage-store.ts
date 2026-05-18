// v0.1.210 — Lokaler Token-Verbrauchs-Store.
//
// Spiegelt den AuditStore-Pattern (PGlite, embedded, single-writer
// in-process). Daten verlassen die Maschine nicht — kein Upload zu
// Fly. Datenpfad: `<userData>/pglite/usage/`.
//
// Schema: eine Zeile pro LLM-Call.
//
// Retention: 12 Monate (entscheidung 2026-05-18). Daily-Purge
// fired auf App-Start + alle 24h via main/index.ts.
//
// Aggregation (`daily()`) erfolgt on-the-fly per SQL. Volumen ist
// klein genug (~5k Calls/Tag bei moderater Nutzung); falls nötig
// kann später eine materialisierte Tages-Tabelle eingezogen werden.

import { EventEmitter } from "node:events";
import { mkdirSync } from "node:fs";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import { app } from "electron";
import type {
  LlmProviderKind,
  UsageDailyBucket,
  UsageEvent,
  UsageEventInput,
  UsageListQuery,
  UsageListResponse,
  UsageSource,
} from "../../shared/types";

const DEFAULT_PAGE_SIZE = 50;
const MAX_PAGE_SIZE = 200;

/** 12 Monate Retention (User-Entscheidung 2026-05-18). */
const RETENTION_DAYS = 365;

interface PGliteInstance {
  query<T = unknown>(
    sql: string,
    params?: unknown[],
  ): Promise<{ rows: T[]; affectedRows?: number }>;
  exec(sql: string): Promise<unknown>;
  close(): Promise<void>;
}

interface UsageRow {
  id: string;
  timestamp: string;
  provider: string;
  model: string;
  source_kind: string;
  source_detail: string | null;
  input_tokens: number | string;
  output_tokens: number | string;
  cache_read_tokens: number | string;
  cache_write_tokens: number | string;
  estimated_usd: number | string | null;
  quota_snapshot: Record<string, unknown> | string | null;
  metadata: Record<string, unknown> | string | null;
}

export interface UsageStoreEvents {
  inserted: (event: UsageEvent) => void;
}

export declare interface UsageStore {
  on<K extends keyof UsageStoreEvents>(
    event: K,
    listener: UsageStoreEvents[K],
  ): this;
  emit<K extends keyof UsageStoreEvents>(
    event: K,
    ...args: Parameters<UsageStoreEvents[K]>
  ): boolean;
}

export class UsageStore extends EventEmitter {
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
      /* shutdown path */
    }
    this.pglite = null;
  }

  /** Einzelne UsageEvent anhängen. Setzt id + timestamp falls fehlen. */
  async record(input: UsageEventInput): Promise<UsageEvent> {
    await this.start();
    const pg = this.requirePg();
    const event: UsageEvent = {
      id: randomUUID(),
      timestamp: input.timestamp ?? new Date().toISOString(),
      provider: input.provider,
      model: input.model,
      source: input.source,
      inputTokens: input.inputTokens,
      outputTokens: input.outputTokens,
      cacheReadTokens: input.cacheReadTokens,
      cacheWriteTokens: input.cacheWriteTokens,
      estimatedUsd: input.estimatedUsd,
      ...(input.quotaSnapshot ? { quotaSnapshot: input.quotaSnapshot } : {}),
      ...(input.metadata ? { metadata: input.metadata } : {}),
    };
    const { sourceKind, sourceDetail } = serializeSource(event.source);
    await pg.query(
      `INSERT INTO usage_log
         (id, timestamp, provider, model, source_kind, source_detail,
          input_tokens, output_tokens, cache_read_tokens, cache_write_tokens,
          estimated_usd, quota_snapshot, metadata)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12::jsonb, $13::jsonb)`,
      [
        event.id,
        event.timestamp,
        event.provider,
        event.model,
        sourceKind,
        sourceDetail,
        event.inputTokens,
        event.outputTokens,
        event.cacheReadTokens,
        event.cacheWriteTokens,
        event.estimatedUsd,
        JSON.stringify(event.quotaSnapshot ?? null),
        JSON.stringify(event.metadata ?? null),
      ],
    );
    this.emit("inserted", event);
    return event;
  }

  /** Listing mit Cursor-Pagination — Verlauf/Drill-Down. */
  async list(query: UsageListQuery): Promise<UsageListResponse> {
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
    if (query.providers && query.providers.length > 0)
      push(`provider = ANY(?)`, query.providers);
    if (query.models && query.models.length > 0)
      push(`model = ANY(?)`, query.models);
    if (query.sourceKinds && query.sourceKinds.length > 0)
      push(`source_kind = ANY(?)`, query.sourceKinds);

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
      SELECT id, timestamp, provider, model, source_kind, source_detail,
             input_tokens, output_tokens, cache_read_tokens, cache_write_tokens,
             estimated_usd, quota_snapshot, metadata
      FROM usage_log
      ${whereSql}
      ORDER BY timestamp DESC, id DESC
      LIMIT ${pageSize + 1}
    `;
    const res = await pg.query<UsageRow>(sql, params);
    const overflow = res.rows.length > pageSize;
    const rows = overflow ? res.rows.slice(0, pageSize) : res.rows;
    const events = rows.map(rowToEvent);
    const last = events.length > 0 ? events[events.length - 1] : null;
    const nextPageToken =
      overflow && last
        ? encodeCursor({ timestamp: last.timestamp, id: last.id })
        : null;

    let totalEstimate = -1;
    if (wheres.length === 0) {
      const countRes = await pg.query<{ n: string | number }>(
        `SELECT COUNT(*) AS n FROM usage_log`,
      );
      const n = Number(countRes.rows[0]?.n ?? 0);
      totalEstimate = n < 100_000 ? n : -1;
    }
    return { events, nextPageToken, totalEstimate };
  }

  /**
   * Tages-Aggregat über die letzten `days` Tage (UTC). Zwei Achsen
   * gleichzeitig: pro Modell und pro Quelle. Renderer rendert dann
   * das gestapelte Tages-Diagramm + Source-Donut + Top-Modelle-Tabelle
   * aus diesem einen Result.
   */
  async daily(days: number): Promise<UsageDailyBucket[]> {
    await this.start();
    const pg = this.requirePg();
    const cutoff = new Date(
      Date.now() - days * 24 * 60 * 60 * 1000,
    ).toISOString();

    // Pro Tag × Modell.
    const modelRes = await pg.query<{
      day: string;
      provider: string;
      model: string;
      input_tokens: string | number;
      output_tokens: string | number;
      cache_read_tokens: string | number;
      cache_write_tokens: string | number;
      estimated_usd: string | number | null;
      calls: string | number;
    }>(
      `
      SELECT
        to_char(date_trunc('day', timestamp), 'YYYY-MM-DD') AS day,
        provider,
        model,
        SUM(input_tokens)::bigint       AS input_tokens,
        SUM(output_tokens)::bigint      AS output_tokens,
        SUM(cache_read_tokens)::bigint  AS cache_read_tokens,
        SUM(cache_write_tokens)::bigint AS cache_write_tokens,
        SUM(estimated_usd)              AS estimated_usd,
        COUNT(*)::bigint                AS calls
      FROM usage_log
      WHERE timestamp >= $1
      GROUP BY 1, 2, 3
      ORDER BY 1 ASC, 2 ASC, 3 ASC
      `,
      [cutoff],
    );

    // Pro Tag × Quelle (sourceKey = "chat" | "producer:profile" | …)
    const sourceRes = await pg.query<{
      day: string;
      source_kind: string;
      source_detail: string | null;
      input_tokens: string | number;
      output_tokens: string | number;
      cache_read_tokens: string | number;
      cache_write_tokens: string | number;
      estimated_usd: string | number | null;
      calls: string | number;
    }>(
      `
      SELECT
        to_char(date_trunc('day', timestamp), 'YYYY-MM-DD') AS day,
        source_kind,
        source_detail,
        SUM(input_tokens)::bigint       AS input_tokens,
        SUM(output_tokens)::bigint      AS output_tokens,
        SUM(cache_read_tokens)::bigint  AS cache_read_tokens,
        SUM(cache_write_tokens)::bigint AS cache_write_tokens,
        SUM(estimated_usd)              AS estimated_usd,
        COUNT(*)::bigint                AS calls
      FROM usage_log
      WHERE timestamp >= $1
      GROUP BY 1, 2, 3
      ORDER BY 1 ASC
      `,
      [cutoff],
    );

    // Zwei Maps zu UsageDailyBucket[] verbinden.
    const dayMap = new Map<string, UsageDailyBucket>();
    const ensureDay = (day: string): UsageDailyBucket => {
      let b = dayMap.get(day);
      if (!b) {
        b = { day, byModel: [], bySource: [] };
        dayMap.set(day, b);
      }
      return b;
    };
    for (const r of modelRes.rows) {
      const b = ensureDay(r.day);
      b.byModel.push({
        provider: r.provider as LlmProviderKind,
        model: r.model,
        inputTokens: Number(r.input_tokens),
        outputTokens: Number(r.output_tokens),
        cacheReadTokens: Number(r.cache_read_tokens),
        cacheWriteTokens: Number(r.cache_write_tokens),
        estimatedUsd: r.estimated_usd == null ? null : Number(r.estimated_usd),
        calls: Number(r.calls),
      });
    }
    for (const r of sourceRes.rows) {
      const b = ensureDay(r.day);
      const sourceKey = r.source_detail
        ? `${r.source_kind}:${r.source_detail}`
        : r.source_kind;
      b.bySource.push({
        sourceKey,
        inputTokens: Number(r.input_tokens),
        outputTokens: Number(r.output_tokens),
        cacheReadTokens: Number(r.cache_read_tokens),
        cacheWriteTokens: Number(r.cache_write_tokens),
        estimatedUsd: r.estimated_usd == null ? null : Number(r.estimated_usd),
        calls: Number(r.calls),
      });
    }

    return Array.from(dayMap.values()).sort((a, b) =>
      a.day.localeCompare(b.day),
    );
  }

  /** Reset-Knopf in Settings („Verbrauchsdaten löschen"). */
  async purgeAll(): Promise<number> {
    await this.start();
    const pg = this.requirePg();
    const res = await pg.query<{ n: string | number }>(
      `WITH d AS (DELETE FROM usage_log RETURNING 1)
       SELECT COUNT(*)::text AS n FROM d`,
    );
    return Number(res.rows[0]?.n ?? 0);
  }

  /** Retention-Purge: löscht Einträge älter als `RETENTION_DAYS`. */
  async purgeExpired(): Promise<number> {
    await this.start();
    const pg = this.requirePg();
    const cutoff = new Date(
      Date.now() - RETENTION_DAYS * 24 * 60 * 60 * 1000,
    ).toISOString();
    const res = await pg.query(
      `DELETE FROM usage_log WHERE timestamp < $1`,
      [cutoff],
    );
    return res.affectedRows ?? 0;
  }

  private requirePg(): PGliteInstance {
    if (!this.pglite) throw new Error("UsageStore not started");
    return this.pglite;
  }

  private async applySchema(): Promise<void> {
    const pg = this.requirePg();
    await pg.exec(`
      CREATE TABLE IF NOT EXISTS usage_log (
        id                  TEXT PRIMARY KEY,
        timestamp           TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        provider            TEXT NOT NULL,
        model               TEXT NOT NULL,
        source_kind         TEXT NOT NULL,
        source_detail       TEXT,
        input_tokens        BIGINT NOT NULL DEFAULT 0,
        output_tokens       BIGINT NOT NULL DEFAULT 0,
        cache_read_tokens   BIGINT NOT NULL DEFAULT 0,
        cache_write_tokens  BIGINT NOT NULL DEFAULT 0,
        estimated_usd       DOUBLE PRECISION,
        quota_snapshot      JSONB,
        metadata            JSONB
      );
      CREATE INDEX IF NOT EXISTS usage_log_timestamp_idx
        ON usage_log (timestamp DESC);
      CREATE INDEX IF NOT EXISTS usage_log_provider_model_idx
        ON usage_log (provider, model);
      CREATE INDEX IF NOT EXISTS usage_log_source_idx
        ON usage_log (source_kind, source_detail);
    `);
  }
}

function defaultDataRoot(): string {
  return join(app.getPath("userData"), "pglite", "usage");
}

function clamp(n: number, lo: number, hi: number): number {
  return Math.max(lo, Math.min(hi, n));
}

/** UsageSource → (kind, detail) für die DB-Spalten. */
function serializeSource(source: UsageSource): {
  sourceKind: string;
  sourceDetail: string | null;
} {
  switch (source.kind) {
    case "chat":
      return {
        sourceKind: "chat",
        sourceDetail: source.conversationId ?? null,
      };
    case "producer":
      return { sourceKind: "producer", sourceDetail: source.name };
    case "watch":
      return { sourceKind: "watch", sourceDetail: null };
    case "alert-judge":
      return { sourceKind: "alert-judge", sourceDetail: null };
    case "other":
      return { sourceKind: "other", sourceDetail: source.label };
  }
}

/** Spalten-Tupel zurück in eine getypte UsageSource. */
function deserializeSource(
  kind: string,
  detail: string | null,
): UsageSource {
  switch (kind) {
    case "chat":
      return { kind: "chat", conversationId: detail };
    case "producer":
      return { kind: "producer", name: detail ?? "" };
    case "watch":
      return { kind: "watch" };
    case "alert-judge":
      return { kind: "alert-judge" };
    case "other":
      return { kind: "other", label: detail ?? "" };
    default:
      return { kind: "other", label: kind };
  }
}

function rowToEvent(r: UsageRow): UsageEvent {
  const quotaSnapshot =
    typeof r.quota_snapshot === "string"
      ? safeJsonParse(r.quota_snapshot)
      : (r.quota_snapshot ?? null);
  const metadata =
    typeof r.metadata === "string"
      ? safeJsonParse(r.metadata)
      : (r.metadata ?? null);
  return {
    id: r.id,
    timestamp:
      typeof r.timestamp === "string"
        ? r.timestamp
        : new Date(r.timestamp as unknown as number).toISOString(),
    provider: r.provider as LlmProviderKind,
    model: r.model,
    source: deserializeSource(r.source_kind, r.source_detail),
    inputTokens: Number(r.input_tokens),
    outputTokens: Number(r.output_tokens),
    cacheReadTokens: Number(r.cache_read_tokens),
    cacheWriteTokens: Number(r.cache_write_tokens),
    estimatedUsd: r.estimated_usd == null ? null : Number(r.estimated_usd),
    ...(quotaSnapshot
      ? { quotaSnapshot: quotaSnapshot as UsageEvent["quotaSnapshot"] }
      : {}),
    ...(metadata
      ? { metadata: metadata as UsageEvent["metadata"] }
      : {}),
  };
}

function safeJsonParse(s: string): Record<string, unknown> | null {
  try {
    const v = JSON.parse(s);
    return typeof v === "object" && v != null
      ? (v as Record<string, unknown>)
      : null;
  } catch {
    return null;
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

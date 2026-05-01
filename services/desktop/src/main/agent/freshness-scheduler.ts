import { EventEmitter } from "node:events";
import { randomUUID } from "node:crypto";
import type { GatewayClient } from "./gateway-client";
import type { FreshnessPrefsStore } from "./freshness-prefs-store";
import type { FreshnessCursorStore } from "./freshness-cursor-store";
import type { InterestStore } from "./interest-store";
import type {
  FreshnessPrefs,
  FreshnessStage,
  FreshnessTickInfo,
  StalenessRow,
} from "../../shared/types";

// FreshnessScheduler (Phase 8.r1).
//
// Periodic background loop that walks the pipeline matrices for every
// recent transaction, scores each (companyId, stage) cell against its
// configured cadence, and surfaces the top-K most-overdue rows.
//
// 8.r1 is dry-run only: the loop logs candidates + emits `tick` events
// but never calls `retry_stage`. 8.r2 wires the dispatch path; the
// scoring + queueing logic stays unchanged.
//
// Why dry-run first: the scoring formula and throttle math are easy to
// get subtly wrong, and a wrong dispatch is much more expensive than a
// wrong log line. The Settings UI reads `getRecentTicks()` so the user
// (and reviewer) can watch the queue evolve before any retry calls go
// out.
//
// Scheduling: setInterval with ±15 % jitter, default 30 minutes.
// Single-flight lock so a slow gateway can't pile up ticks. Triggers:
//   - timer fires
//   - `triggerNow()` (called from the chat tool / Settings button in
//     8.r3; safe to call any time)

const DEFAULT_INTERVAL_MS = 30 * 60_000;
const JITTER = 0.15;
const MAX_HISTORY = 10;
const MAX_TRANSACTIONS = 25;
const NEVER_RUN_DAYS = 365 * 5; // synthetic large value for cells that never produced a timestamp
/**
 * Upper bound on how long we hold a per-company in-flight lock before
 * sweeping it as stale. Real pipeline stages finish in seconds-to-
 * minutes; 60 min is the defensive ceiling so a silently-failed dispatch
 * (gateway 5xx that never retried, producer crash) doesn't pin the
 * company forever. The pipeline matrix's `updatedAt` is the authoritative
 * "is this row fresh again" signal — the in-flight lock is just a
 * coarse don't-double-fire guard.
 */
const IN_FLIGHT_TTL_MS = 60 * 60_000;

const ALL_STAGES: readonly FreshnessStage[] = [
  "structuredContent",
  "companyPublication",
  "website",
  "companyProfile",
  "companyContact",
  "companyEvaluation",
];

export interface FreshnessSchedulerOptions {
  gateway: GatewayClient;
  prefs: FreshnessPrefsStore;
  /** Persistent throttle + per-company in-flight lock state (8.r2). */
  cursor: FreshnessCursorStore;
  /** Recent-interest signals from the renderer (8.r4). Optional — when
   *  absent the score formula falls back to its r2 shape (no boost). */
  interest?: InterestStore;
  /** Override the wall clock (test seam). */
  now?: () => Date;
  /** Override the cadence (test seam). 0 disables the timer. */
  intervalMs?: number;
  /**
   * Override the dispatcher (test seam). Defaults to the gateway-backed
   * `POST /v1/transactions/:tid/entities/:cid/retry` call wired below.
   */
  dispatch?: (row: StalenessRow, signal?: AbortSignal) => Promise<void>;
}

export interface FreshnessSchedulerEvents {
  tick: (info: FreshnessTickInfo) => void;
}

export declare interface FreshnessScheduler {
  on<K extends keyof FreshnessSchedulerEvents>(
    event: K,
    listener: FreshnessSchedulerEvents[K],
  ): this;
  emit<K extends keyof FreshnessSchedulerEvents>(
    event: K,
    ...args: Parameters<FreshnessSchedulerEvents[K]>
  ): boolean;
}

interface TxRow {
  id: string;
  createdAt?: string;
}

interface PipelineRow {
  companyId: string;
  cells: Record<string, { state?: string; updatedAt?: string | null }>;
}

interface PipelineResp {
  transactionId: string;
  rows?: PipelineRow[];
  unavailableStages?: string[];
}

export class FreshnessScheduler extends EventEmitter {
  private readonly gateway: GatewayClient;
  private readonly prefs: FreshnessPrefsStore;
  private readonly cursor: FreshnessCursorStore;
  private readonly interest: InterestStore | null;
  private readonly now: () => Date;
  private intervalMs: number;
  private readonly dispatch: (
    row: StalenessRow,
    signal?: AbortSignal,
  ) => Promise<void>;

  private timer: NodeJS.Timeout | null = null;
  private inflight = false;
  private stopped = false;
  private history: FreshnessTickInfo[] = [];

  constructor(opts: FreshnessSchedulerOptions) {
    super();
    this.gateway = opts.gateway;
    this.prefs = opts.prefs;
    this.cursor = opts.cursor;
    this.interest = opts.interest ?? null;
    this.now = opts.now ?? (() => new Date());
    this.intervalMs = opts.intervalMs ?? DEFAULT_INTERVAL_MS;
    // Default dispatcher: the same /retry endpoint the chat
    // `retry_stage` tool uses. Tests can swap in a no-op or counter to
    // observe queue behaviour without hitting the gateway.
    this.dispatch = opts.dispatch ?? this.defaultDispatch.bind(this);
  }

  start(): void {
    this.stopped = false;
    if (this.timer || this.intervalMs === 0) return;
    this.scheduleNext();
  }

  stop(): void {
    this.stopped = true;
    if (this.timer) {
      clearTimeout(this.timer);
      this.timer = null;
    }
  }

  /** Called when the cadence pref changes; cancels and reschedules. */
  setIntervalMs(intervalMs: number): void {
    this.intervalMs = intervalMs;
    if (this.timer) {
      clearTimeout(this.timer);
      this.timer = null;
    }
    if (!this.stopped && intervalMs > 0) this.scheduleNext();
  }

  /**
   * Force a tick now. Returns the tick info — same shape the timer-
   * driven `tick` event carries. Used by the Settings "Jetzt scannen"
   * button (8.r3) and tests.
   */
  async triggerNow(): Promise<FreshnessTickInfo> {
    if (this.inflight) {
      return new Promise((resolve) => {
        this.once("tick", resolve);
      });
    }
    return this.runTick();
  }

  /** Most-recent ticks, newest first. Capped at MAX_HISTORY. */
  getRecentTicks(): FreshnessTickInfo[] {
    return this.history.slice();
  }

  // ---- Internal -----------------------------------------------------------

  private scheduleNext(): void {
    if (this.stopped || this.intervalMs === 0) return;
    const jitter = 1 + (Math.random() * 2 - 1) * JITTER;
    const delay = Math.max(1_000, Math.round(this.intervalMs * jitter));
    this.timer = setTimeout(() => {
      this.timer = null;
      void this.runTick().finally(() => this.scheduleNext());
    }, delay);
  }

  private async runTick(): Promise<FreshnessTickInfo> {
    if (this.inflight) {
      const skipped: FreshnessTickInfo = {
        startedAt: this.now().toISOString(),
        finishedAt: this.now().toISOString(),
        skipped: true,
        reason: "previous tick still running",
        cellsInspected: 0,
        staleFound: 0,
        candidates: [],
        dispatched: [],
      };
      this.recordAndEmit(skipped);
      return skipped;
    }

    const prefs = this.prefs.get();
    const startedAt = this.now();

    if (!prefs.enabled) {
      const info: FreshnessTickInfo = {
        startedAt: startedAt.toISOString(),
        finishedAt: this.now().toISOString(),
        skipped: true,
        reason: "Auto-Aktualisierung deaktiviert",
        cellsInspected: 0,
        staleFound: 0,
        candidates: [],
        dispatched: [],
      };
      this.recordAndEmit(info);
      return info;
    }

    this.inflight = true;
    // Sweep stale in-flight locks BEFORE scoring so a previously-locked
    // company that's been silent for >TTL can become a candidate again.
    this.cursor.sweepInFlight(startedAt, IN_FLIGHT_TTL_MS);

    let cellsInspected = 0;
    let candidates: StalenessRow[] = [];
    try {
      candidates = await this.scan(prefs, startedAt, (n) => {
        cellsInspected += n;
      });
    } catch (err) {
      console.warn("[freshness] tick failed:", err);
    } finally {
      this.inflight = false;
    }

    const dispatched = await this.dispatchTopK(candidates, prefs, startedAt);

    if (candidates.length > 0) {
      const top = candidates.slice(0, prefs.topKPerTick);
      console.log(
        `[freshness] tick: ${candidates.length} stale cells (${cellsInspected} inspected); dispatched ${dispatched.length}/${top.length} top candidates`,
      );
      for (const r of top) {
        const days = Math.round(r.daysSinceLastRun);
        const cad = r.cadenceDays;
        const overdue = Math.max(0, days - cad);
        const dispatchedFlag = dispatched.find(
          (d) => d.companyId === r.companyId && d.stage === r.stage,
        )
          ? " · dispatched"
          : " · skipped (throttle/in-flight)";
        console.log(
          `  - [score ${r.score.toFixed(2)}] ${r.companyName ?? r.companyId.slice(0, 12) + "…"} · ${r.stage}: ${days}d / ${cad}d cadence (${overdue}d overdue)${r.pinned ? " · pinned" : ""}${dispatchedFlag}`,
        );
      }
    } else {
      console.log(
        `[freshness] tick: ${cellsInspected} cells inspected, none stale.`,
      );
    }

    const info: FreshnessTickInfo = {
      startedAt: startedAt.toISOString(),
      finishedAt: this.now().toISOString(),
      skipped: false,
      cellsInspected,
      staleFound: candidates.length,
      candidates: candidates.slice(0, prefs.topKPerTick),
      dispatched,
    };
    this.recordAndEmit(info);
    return info;
  }

  /**
   * Walk the sorted candidate list, try to reserve a throttle slot for
   * each, dispatch through the configured `dispatch` function, and
   * roll back the reservation on failure so the candidate is eligible
   * again next tick.
   *
   * Reservation is atomic in-process via `cursor.tryReserveSlot`:
   * either we get a per-stage slot AND a global slot AND the company
   * isn't already in-flight, or we move on. We stop as soon as we've
   * dispatched `topKPerTick` rows (a soft cap on top of the throttle).
   */
  private async dispatchTopK(
    candidates: StalenessRow[],
    prefs: FreshnessPrefs,
    now: Date,
  ): Promise<Array<{ companyId: string; stage: FreshnessStage }>> {
    const out: Array<{ companyId: string; stage: FreshnessStage }> = [];
    const limits = prefs.throttle;
    for (const row of candidates) {
      if (out.length >= prefs.topKPerTick) break;
      const reserved = this.cursor.tryReserveSlot(
        row.stage,
        row.companyId,
        now,
        limits,
      );
      if (!reserved) continue;
      try {
        await this.dispatch(row);
        out.push({ companyId: row.companyId, stage: row.stage });
      } catch (err) {
        // Roll back so the candidate can retry next tick. The pipeline
        // matrix's `updatedAt` remains unchanged (the producer never
        // ran), so the score will still be high — eventually the slot
        // opens up and the gateway is healthy again.
        console.warn(
          `[freshness] dispatch failed for ${row.companyId} / ${row.stage}:`,
          err instanceof Error ? err.message : err,
        );
        this.cursor.releaseSlot(row.stage, row.companyId, now);
      }
    }
    return out;
  }

  private async defaultDispatch(
    row: StalenessRow,
    signal?: AbortSignal,
  ): Promise<void> {
    // Same endpoint + body shape as the chat-driven `retry_stage` tool.
    // Sending a fresh idempotency key ensures the gateway doesn't dedupe
    // a real schedule-driven retry against a recent manual one.
    await this.gateway.request(
      `/v1/transactions/${encodeURIComponent(
        row.transactionId,
      )}/entities/${encodeURIComponent(row.companyId)}/retry`,
      {
        method: "POST",
        body: { stage: row.stage },
        idempotencyKey: randomUUID(),
        signal,
      },
    );
  }

  /** Walk recent transactions → pipeline matrices → score every cell. */
  private async scan(
    prefs: FreshnessPrefs,
    startedAt: Date,
    onInspected: (n: number) => void,
  ): Promise<StalenessRow[]> {
    const txList = await this.gateway.request<{ items?: TxRow[] }>(
      "/v1/transactions",
      { query: { page: 1, pageSize: MAX_TRANSACTIONS } },
    );
    const txs = (txList.items ?? []).slice(0, MAX_TRANSACTIONS);
    if (txs.length === 0) return [];

    const pinned = new Set(prefs.pinned);
    const startMs = startedAt.getTime();
    const inFlight = this.cursor.get().inFlight;
    /**
     * Per-(companyId, stage) the best (highest-scoring) row across all
     * transactions. A company can land in multiple imports — we want
     * the freshest cell to anchor the score, and the source
     * transactionId is recorded for the future retry call.
     */
    const best = new Map<string, StalenessRow>();
    const companyName = new Map<string, string | null>();

    // Pipeline fetches are independent — fan out with a small pool
    // (mirror real-candidate-source.ts; same gateway, same etiquette).
    await runWithConcurrency(txs, 5, async (tx) => {
      let pipeline: PipelineResp;
      try {
        pipeline = await this.gateway.request<PipelineResp>(
          `/v1/transactions/${encodeURIComponent(tx.id)}/pipeline`,
        );
      } catch (err) {
        console.warn(
          `[freshness] pipeline ${tx.id} failed:`,
          err instanceof Error ? err.message : err,
        );
        return;
      }
      const rows = pipeline.rows ?? [];
      for (const row of rows) {
        if (!row.companyId) continue;
        // A company already mid-retry is skipped at the scoring stage —
        // dispatch reservation would refuse it anyway, but suppressing
        // it here keeps the candidate list (which the Settings panel
        // shows) free of rows the user can't act on this tick.
        if (inFlight[row.companyId]) continue;
        if (!companyName.has(row.companyId)) {
          // Pipeline doesn't carry the name; we leave null and let
          // the Settings panel resolve it via a lookup the same way
          // TransactionDetail does. Keeps the scheduler dependency-
          // free of the master-data endpoint.
          companyName.set(row.companyId, null);
        }
        for (const stage of ALL_STAGES) {
          const cad = prefs.cadenceDays[stage] ?? 0;
          if (cad <= 0) continue; // user opted this stage out

          const cell = row.cells?.[stage];
          if (!cell) continue;

          // `pending` cells haven't run; treat them as never-run only
          // if they're orphaned in a transaction old enough that we'd
          // expect them done by now. For 8.r1 we always count pending
          // as never-run — gives the scheduler something to log even
          // on a fresh import. 8.r2 will refine if it produces noise.
          const lastUpdatedAt = cell.updatedAt ?? null;
          const days = lastUpdatedAt
            ? Math.max(
                0,
                (startMs - new Date(lastUpdatedAt).getTime()) / 86_400_000,
              )
            : NEVER_RUN_DAYS;
          onInspected(1);
          if (days <= cad) continue;

          const overdue = days - cad;
          const stageWeight = 1 / cad; // weekly stages move fastest
          const isPinned = pinned.has(row.companyId);
          // Recent-interest boost (8.r4): 0..1, decaying linearly from
          // a fresh CompanyDetail mount or chat company-link click.
          // Doubles a touched-today company's score (×2 at boost=1)
          // without overpowering an explicit pin (×10).
          const interestBoost = this.interest
            ? this.interest.getBoost(row.companyId, startedAt)
            : 0;
          const score =
            overdue *
            stageWeight *
            (isPinned ? 10 : 1) *
            (1 + interestBoost);

          const key = `${row.companyId}::${stage}`;
          const candidate: StalenessRow = {
            companyId: row.companyId,
            companyName: companyName.get(row.companyId) ?? null,
            transactionId: tx.id,
            stage,
            lastUpdatedAt,
            daysSinceLastRun: days,
            cadenceDays: cad,
            score,
            pinned: isPinned,
          };
          const prev = best.get(key);
          if (!prev || score > prev.score) {
            best.set(key, candidate);
          }
        }
      }
    });

    return Array.from(best.values()).sort((a, b) => b.score - a.score);
  }

  private recordAndEmit(info: FreshnessTickInfo): void {
    this.history.unshift(info);
    if (this.history.length > MAX_HISTORY) {
      this.history.length = MAX_HISTORY;
    }
    this.emit("tick", info);
  }
}

// Tiny concurrency-limited map — same shape as in real-candidate-source.ts;
// kept local to avoid cross-module wiring.
async function runWithConcurrency<T>(
  items: T[],
  limit: number,
  fn: (item: T) => Promise<void>,
): Promise<void> {
  let cursor = 0;
  const workers: Promise<void>[] = [];
  for (let i = 0; i < Math.min(limit, items.length); i++) {
    workers.push(
      (async () => {
        while (cursor < items.length) {
          const idx = cursor++;
          await fn(items[idx]!);
        }
      })(),
    );
  }
  await Promise.all(workers);
}

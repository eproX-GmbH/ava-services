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
/** Firmenmatrix seitenweise; 50 Seiten à 200 = 10.000 Firmen je Nutzer. */
const MATRIX_SEITE = 200;
const MAX_MATRIX_SEITEN = 50;
/** Schlug ein Retry fehl (z. B. "keine Website, Profil nicht moeglich"), Zelle 24 h ruhen lassen. */
const FEHLVERSUCH_PAUSE_MS = 24 * 60 * 60_000;
const STAGE_ZU_PRODUCER: Record<FreshnessStage, string> = {
  structuredContent: "structured-content",
  companyPublication: "company-publication",
  website: "website",
  companyProfile: "company-profile",
  companyContact: "company-contact",
  companyEvaluation: "company-evaluation",
};
interface MatrixZeile {
  companyId: string;
  name?: string | null;
  held?: boolean;
  registerStatus?: string;
  stages?: Record<string, { state?: string; updatedAt?: string | null; transactionId?: string | null } | undefined>;
}
/**
 * Relevanz als Verstaerker (Nutzerwunsch 2026-10-04: alter Zeitstempel +
 * wie heiss die Firma ist). Rang-Stufen wie im Alarmweg (relevanz/alarmweg.ts):
 * ab 9 sehr heiss ×3, ab 7 heiss ×2, ab 4 lauwarm ×1,5, sonst ×1.
 */
export function relevanzFaktor(rang: number | null | undefined): number {
  if (rang == null) return 1;
  if (rang >= 9) return 3;
  if (rang >= 7) return 2;
  if (rang >= 4) return 1.5;
  return 1;
}
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
  /** 2026-10-04: Relevanz-Rang (0-10) je Firma, hoechstens 200 Ids je Aufruf. */
  relevanz?: (companyIds: string[]) => Promise<Map<string, number>>;
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


interface PipelineRow {
  companyId: string;
  cells: Record<string, { state?: string; updatedAt?: string | null }>;
}


export class FreshnessScheduler extends EventEmitter {
  private readonly gateway: GatewayClient;
  private readonly prefs: FreshnessPrefsStore;
  private readonly cursor: FreshnessCursorStore;
  private readonly interest: InterestStore | null;
  private readonly relevanz: ((companyIds: string[]) => Promise<Map<string, number>>) | null;
  /** Zuletzt fehlgeschlagener Retry je Firma::Stufe (ms), siehe FEHLVERSUCH_PAUSE_MS. */
  private readonly fehlversuche = new Map<string, number>();
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
    this.relevanz = opts.relevanz ?? null;
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
        // Nicht laufbare Zelle (z. B. Profil ohne Website) nicht jeden Takt
        // erneut versuchen und damit die Spitze blockieren.
        this.fehlversuche.set(`${row.companyId}::${row.stage}`, now.getTime());
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

  /**
   * 2026-10-04 (docs/PLAN_AUFFRISCHUNG.md): Kandidaten aus der GANZEN
   * Firmenliste des Nutzers (/v1/companies/matrix), nicht mehr aus den 25
   * neuesten Transaktionen. Befund: Bei 70 Transaktionen sah der Planer nur
   * 11 von 43 Firmen; 32 wurden nie automatisch aufgefrischt.
   *
   * Prioritaet = Ueberfaelligkeit (in Takten) × Relevanz × Merkliste/Interesse.
   * Die Ueberfaelligkeit waechst mit jedem Tag, deshalb kommen auch kalte
   * Firmen sicher dran; heisse Firmen (Relevanz-Rang) nur frueher.
   */
  private async scan(
    prefs: FreshnessPrefs,
    startedAt: Date,
    onInspected: (n: number) => void,
  ): Promise<StalenessRow[]> {
    const pinned = new Set(prefs.pinned);
    const startMs = startedAt.getTime();
    const inFlight = this.cursor.get().inFlight;
    const zeilen: MatrixZeile[] = [];
    for (let seite = 1; seite <= MAX_MATRIX_SEITEN; seite++) {
      const r = await this.gateway.request<{ companies?: MatrixZeile[]; count?: number }>(
        "/v1/companies/matrix",
        { query: { pageNumber: seite, pageSize: MATRIX_SEITE } },
      );
      const teil = r.companies ?? [];
      zeilen.push(...teil);
      if (teil.length < MATRIX_SEITE) break;
    }
    if (zeilen.length === 0) return [];
    const rangJeFirma = await this.relevanzRaenge(zeilen.map((z) => z.companyId));
    const jetzt = startMs;
    const out: StalenessRow[] = [];
    for (const z of zeilen) {
      if (!z.companyId || z.held) continue;
      // Geschlossene Firmen (Register) nicht mehr auffrischen.
      if (z.registerStatus === "CLOSED") continue;
      if (inFlight[z.companyId]) continue;
      // Fuer den Retry braucht es eine Transaktion; jede der Firma genuegt.
      const irgendeineTx = Object.values(z.stages ?? {}).find((c) => c?.transactionId)?.transactionId ?? null;
      const rang = rangJeFirma.get(z.companyId) ?? null;
      for (const stage of ALL_STAGES) {
        // 2026-10-05: Die Bewertung wird aus den Vorstufen abgeleitet und
        // laeuft mit, sobald eine Vorstufe neu laeuft. Ein eigener Anstoss
        // setzt nur "laeuft", das nie abgeschlossen wird (Zeitwaechter →
        // failed, 29 Faelle an einem Tag). Nie einzeln auffrischen.
        if (stage === "companyEvaluation") continue;
        const cad = prefs.cadenceDays[stage] ?? 0;
        if (cad <= 0) continue;
        const cell = z.stages?.[STAGE_ZU_PRODUCER[stage]];
        if (!cell) continue;
        const sperre = this.fehlversuche.get(`${z.companyId}::${stage}`);
        if (sperre && jetzt - sperre < FEHLVERSUCH_PAUSE_MS) continue;
        const tx = cell.transactionId ?? irgendeineTx;
        if (!tx) continue;
        const lastUpdatedAt = cell.updatedAt ?? null;
        const days = lastUpdatedAt
          ? Math.max(0, (startMs - new Date(lastUpdatedAt).getTime()) / 86_400_000)
          : NEVER_RUN_DAYS;
        onInspected(1);
        if (days <= cad) continue;
        // Nie gelaufene Stufen nicht unendlich hoch werten (sonst blockieren
        // dauerhaft nicht laufbare Zellen die Spitze): wie 3 Takte ueberfaellig.
        const takteUeber = lastUpdatedAt ? (days - cad) / cad : 3;
        const isPinned = pinned.has(z.companyId);
        const interestBoost = this.interest ? this.interest.getBoost(z.companyId, startedAt) : 0;
        const score = takteUeber * relevanzFaktor(rang) * (isPinned ? 10 : 1) * (1 + interestBoost);
        out.push({
          companyId: z.companyId,
          companyName: z.name ?? null,
          transactionId: tx,
          stage,
          lastUpdatedAt,
          daysSinceLastRun: days,
          cadenceDays: cad,
          score,
          pinned: isPinned,
          rang,
        });
      }
    }
    return out.sort((a, b) => b.score - a.score);
  }

  /** Relevanz-Rang je Firma (0-10); ohne Relevanz-Erfassung leer. */
  private async relevanzRaenge(ids: string[]): Promise<Map<string, number>> {
    const m = new Map<string, number>();
    if (!this.relevanz) return m;
    for (let i = 0; i < ids.length; i += 200) {
      try {
        const w = await this.relevanz(ids.slice(i, i + 200));
        for (const [id, rang] of w) m.set(id, rang);
      } catch {
        /* Relevanz ist ein Verstaerker, kein Muss */
      }
    }
    return m;
  }

  private recordAndEmit(info: FreshnessTickInfo): void {
    this.history.unshift(info);
    if (this.history.length > MAX_HISTORY) {
      this.history.length = MAX_HISTORY;
    }
    this.emit("tick", info);
  }
}

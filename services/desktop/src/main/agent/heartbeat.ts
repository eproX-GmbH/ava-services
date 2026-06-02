import { EventEmitter } from "node:events";
import type { AlertsStore, AlertCreateInput } from "./alerts-store";
import { JudgeProviderUnavailable } from "./alert-judge";
import type {
  Alert,
  AlertCandidateDecision,
  AlertDecisionOutcome,
  AlertTickInfo,
} from "../../shared/types";

// Heartbeat scheduler (Phase 8.f1).
//
// Runs every `intervalMs` (default 15 min, ±20 % jitter), pulls fresh
// "candidate" signals from the gateway, asks a per-tick judge whether
// each candidate is alert-worthy, and persists the survivors via the
// AlertsStore.
//
// 8.f1 ships the wiring with stub collaborators:
//   - `defaultStubCandidates()` returns a tiny demo list of plausible
//     candidates ONCE per process so a fresh-install user can see the
//     `/alerts` UI populate without a populated gateway. This goes away
//     in 8.f2 in favour of `GET /v1/alerts/candidates?since=…`.
//   - `defaultJudge()` is "always alert" — the LLM-driven judge with the
//     tight German prompt + yup-validated structured output lands in
//     8.f2.
//
// What is real in 8.f1:
//   - The interval / jitter / single-flight / sleep-wake catch-up logic
//     (so once we drop in real collaborators, the timing is already
//     solid).
//   - Append-only persistence with `sourceRef` dedup.
//   - The `triggerNow()` hook — both as a dev-affordance for the
//     forthcoming "Jetzt auslösen" button and as the easy seam tests
//     can call to drive the system without waiting on wall-clock time.
//
// Single-flight: while a tick is running, additional ticks are dropped
// (not queued). 15 min is the natural debounce window; if it stretches
// past that we'd rather skip than pile up.
//
// Sleep/wake: on wake, the next interval fires immediately (because the
// timer was paused). We DON'T fire one-per-missed-window — a single
// catch-up tick is the right amount. JavaScript's `setInterval` already
// behaves this way on macOS/Windows event loops, but we don't lean on
// it; `lastTickAt` is the source of truth.

export interface HeartbeatCandidate {
  /** Maps onto `Alert.kind`; the same taxonomy. */
  kind: AlertCreateInput["kind"];
  companyId: string;
  companyName: string;
  /** Stable across runs — used as the dedup key. */
  sourceRef: string;
  /** ISO-8601 of the underlying event ("when did this happen?"). */
  occurredAt: string;
  /** Free-form payload for the judge to summarise. */
  payload: Record<string, unknown>;
  /** Pre-formatted one-liner, used by the stub judge in 8.f1. */
  summary: string;
}

export interface JudgeVerdict {
  worthAlerting: boolean;
  severity: AlertCreateInput["severity"];
  headline: string;
  rationale: string;
}

export type CandidateSource = (since: Date | null) => Promise<HeartbeatCandidate[]>;
export type Judge = (
  candidate: HeartbeatCandidate,
  now: Date,
) => Promise<JudgeVerdict>;

export interface HeartbeatOptions {
  store: AlertsStore;
  /** Polling cadence in ms; default 15 min. Set to 0 to disable the timer
   *  (callers can still drive ticks with `triggerNow`). */
  intervalMs?: number;
  /** Source of new candidates. Defaults to a one-shot demo source. */
  source?: CandidateSource;
  /** Judge that maps a candidate → alert-worthiness. Defaults to
   *  "always alert" — the real LLM judge lands in 8.f2. */
  judge?: Judge;
  /** Cap LLM calls per tick. Excess candidates roll over to the next tick
   *  (not implemented in 8.f1; we just drop the tail). Default 20. */
  maxPerTick?: number;
  /** Hook for telemetry / dev logging — fires on every tick boundary. */
  onTick?: (info: TickInfo) => void;
  /** Phase 8.t2 — fires AFTER the primary alert judge has run, with
   *  the same candidate set. Used by `WatchExecutor` to evaluate
   *  user-registered rubrics against fresh data without scheduling a
   *  separate timer. Errors here are logged but never abort the tick. */
  postCandidateHook?: (
    candidates: HeartbeatCandidate[],
    now: Date,
  ) => Promise<void>;
}

// `DecisionOutcome`, `CandidateDecision`, and `TickInfo` live in
// `src/shared/types.ts` (8.f3 transparency add-on) so the preload
// bridge and renderer can consume them. We re-export here as the
// names main-side modules use historically.
export type DecisionOutcome = AlertDecisionOutcome;
export type CandidateDecision = AlertCandidateDecision;
export type TickInfo = AlertTickInfo;

const DEFAULT_INTERVAL_MS = 15 * 60_000;
const JITTER = 0.2; // ±20 %
/** v0.1.160 — delay before the FIRST tick after `start()`. Short enough
 *  that the user sees activity within seconds of opening the app,
 *  long enough that the LLM provider + producers + AMQP have settled
 *  past their own cold-start. Without this, the next tick was 15 min
 *  out from app boot — users frequently restarted (OTAs etc.) and
 *  never saw a sweep before quitting. */
const INITIAL_TICK_DELAY_MS = 10_000;
/** Cap on the per-tick decision history kept in memory. ~10 ticks worth
 *  of context is plenty for the user to inspect why nothing came
 *  through; older ticks fall off. */
const MAX_HISTORY = 10;
/** Cap on rationale length stored in the decision log. The judge can
 *  return up to 500 chars; for the diagnostic surface a tighter cap
 *  keeps the IPC payload + UI lines reasonable. */
const RATIONALE_TRUNC = 280;

export class Heartbeat extends EventEmitter {
  private readonly store: AlertsStore;
  private intervalMs: number;
  private readonly source: CandidateSource;
  private readonly judge: Judge;
  private readonly maxPerTick: number;
  private readonly onTick?: (info: TickInfo) => void;
  private readonly postCandidateHook:
    | ((candidates: HeartbeatCandidate[], now: Date) => Promise<void>)
    | null;
  private timer: NodeJS.Timeout | null = null;
  private inflight = false;
  private lastTickAt: Date | null = null;
  private stopped = false;
  /** v0.1.160 — wallclock at which the currently-scheduled timer is set
   *  to fire. Exposed via getStatus() so the UI can render
   *  "nächster Sweep planmäßig HH:MM" even when no history exists yet
   *  (e.g. immediately after app start, before the first tick). null
   *  while paused (intervalMs=0) or stopped. */
  private nextScheduledAt: Date | null = null;
  /** Most-recent ticks with full per-candidate decisions, newest first.
   *  Capped at MAX_HISTORY so a long-running session doesn't grow this
   *  array unbounded. Lives in memory only — restart-loss is fine
   *  because this is purely a diagnostic surface. */
  private history: TickInfo[] = [];

  constructor(options: HeartbeatOptions) {
    super();
    this.store = options.store;
    this.intervalMs = options.intervalMs ?? DEFAULT_INTERVAL_MS;
    this.source = options.source ?? defaultStubSource();
    this.judge = options.judge ?? defaultStubJudge;
    this.maxPerTick = options.maxPerTick ?? 20;
    this.postCandidateHook = options.postCandidateHook ?? null;
    this.onTick = options.onTick;
  }

  /** Begin the periodic loop. Idempotent.
   *  v0.1.160: fires an initial tick after INITIAL_TICK_DELAY_MS
   *  (10 s) instead of waiting a full interval. Without this, a user
   *  who restarts AVA never sees a sweep before quitting again. */
  start(): void {
    this.stopped = false;
    if (this.timer || this.intervalMs === 0) return;
    this.scheduleInitialTick();
  }

  stop(): void {
    this.stopped = true;
    if (this.timer) {
      clearTimeout(this.timer);
      this.timer = null;
    }
    this.nextScheduledAt = null;
  }

  /**
   * Swap the cadence at runtime. Cancels any in-flight timer and
   * reschedules with the new interval. Pass `0` to pause the timer
   * (manual `triggerNow()` still works).
   */
  setIntervalMs(intervalMs: number): void {
    this.intervalMs = intervalMs;
    if (this.timer) {
      clearTimeout(this.timer);
      this.timer = null;
    }
    this.nextScheduledAt = null;
    if (!this.stopped && intervalMs > 0) this.scheduleNext();
  }

  /**
   * Force a tick now, regardless of cadence. Returns the tick info for
   * UI ("17 Kandidaten · 3 neue Meldungen"). If a tick is already in
   * flight, waits for it instead of doubling up.
   */
  async triggerNow(): Promise<TickInfo> {
    if (this.inflight) {
      // Wait for the current tick to finish — caller gets the in-flight
      // tick's outcome instead of a parallel race.
      return new Promise((resolve) => {
        this.once("tick", resolve);
      });
    }
    return this.runTick();
  }

  // ---- Internal -----------------------------------------------------------

  private scheduleNext(): void {
    if (this.stopped || this.intervalMs === 0) {
      this.nextScheduledAt = null;
      return;
    }
    const jitter = 1 + (Math.random() * 2 - 1) * JITTER;
    const delay = Math.max(1_000, Math.round(this.intervalMs * jitter));
    this.nextScheduledAt = new Date(Date.now() + delay);
    this.timer = setTimeout(() => {
      this.timer = null;
      this.nextScheduledAt = null;
      void this.runTick().finally(() => this.scheduleNext());
    }, delay);
  }

  /** v0.1.160 — short-delay first tick so the UI shows activity within
   *  seconds of app start. After the initial tick lands, the normal
   *  cadence kicks in via `scheduleNext()` in the .finally below. */
  private scheduleInitialTick(): void {
    if (this.stopped || this.intervalMs === 0) {
      this.nextScheduledAt = null;
      return;
    }
    this.nextScheduledAt = new Date(Date.now() + INITIAL_TICK_DELAY_MS);
    this.timer = setTimeout(() => {
      this.timer = null;
      this.nextScheduledAt = null;
      void this.runTick().finally(() => this.scheduleNext());
    }, INITIAL_TICK_DELAY_MS);
  }

  private async runTick(): Promise<TickInfo> {
    if (this.inflight) {
      const skipped: TickInfo = {
        startedAt: new Date().toISOString(),
        finishedAt: new Date().toISOString(),
        candidatesSeen: 0,
        alertsCreated: 0,
        duplicates: 0,
        skipped: true,
        reason: "previous tick still running",
        decisions: [],
      };
      this.emit("tick", skipped);
      this.onTick?.(skipped);
      return skipped;
    }
    this.inflight = true;
    const startedAt = new Date();
    let candidatesSeen = 0;
    let alertsCreated = 0;
    let duplicates = 0;
    const created: Alert[] = [];
    const decisions: CandidateDecision[] = [];
    let providerUnavailable = false;
    let candidatesForHook: HeartbeatCandidate[] = [];
    try {
      const candidates = await this.source(this.lastTickAt);
      candidatesForHook = candidates;
      candidatesSeen = candidates.length;
      for (const c of candidates.slice(0, this.maxPerTick)) {
        // Dedup first — cheap and avoids burning an LLM call to re-decide
        // a candidate we've already alerted on.
        if (this.store.hasSourceRef(c.sourceRef)) {
          duplicates += 1;
          decisions.push(decisionFor(c, "duplicate", "Bereits gemeldet."));
          continue;
        }
        let verdict;
        try {
          verdict = await this.judge(c, startedAt);
        } catch (err) {
          if (err instanceof JudgeProviderUnavailable) {
            // No LLM ready — abandon the rest of the tick rather than
            // burning the dedup slot for every queued candidate. They'll
            // re-appear on the next tick once a provider comes online.
            providerUnavailable = true;
            break;
          }
          // Non-recoverable judge failures (network blip, garbled
          // response, …) are recorded so the user can see *which*
          // candidate misbehaved instead of just a tick-level error.
          const message = err instanceof Error ? err.message : String(err);
          decisions.push(decisionFor(c, "judge-error", `Fehler: ${message}`));
          continue;
        }
        if (!verdict.worthAlerting) {
          decisions.push(
            decisionFor(
              c,
              "not-worth",
              verdict.rationale || "Kein Grund vom Modell gemeldet.",
            ),
          );
          continue;
        }
        const row = this.store.add({
          tenantId: null,
          companyId: c.companyId,
          companyName: c.companyName,
          kind: c.kind,
          severity: verdict.severity,
          headline: verdict.headline,
          rationale: verdict.rationale,
          sourceRef: c.sourceRef,
          // v0.1.369 — externe Quell-URL durchreichen (z. B. der
          // LinkedIn-Permalink aus dem Kandidaten-Payload), damit die
          // Meldung „Beitrag öffnen" verlinken kann — wichtig für Firmen
          // ohne interne Detailseite.
          url:
            typeof c.payload?.permalink === "string"
              ? (c.payload.permalink as string)
              : typeof c.payload?.url === "string"
                ? (c.payload.url as string)
                : null,
        });
        if (row) {
          alertsCreated += 1;
          created.push(row);
          decisions.push({
            ...decisionFor(c, "alerted", verdict.rationale),
            severity: verdict.severity,
          });
        } else {
          // Add returned null because of a sourceRef collision detected
          // *after* the cache check (race-y at worst, but worth surfacing
          // separately from a clean "duplicate" outcome).
          duplicates += 1;
          decisions.push(
            decisionFor(c, "duplicate", "Bereits in alerts.jsonl vorhanden."),
          );
        }
      }
    } catch (err) {
      console.warn("[heartbeat] tick failed:", err);
    } finally {
      this.inflight = false;
      // On provider-unavailable we DON'T advance lastTickAt — next tick
      // re-asks the source for the same window so nothing gets lost.
      if (!providerUnavailable) this.lastTickAt = startedAt;
    }

    // 8.t2 — post-candidate hook (WatchExecutor). Runs AFTER the
    // primary alert judge so any alerts the judge created are already
    // in the store; the watch executor's own dedup uses
    // `watch:{id}:{sourceRef}` keys which won't collide with the
    // judge's. Errors here are swallowed — they shouldn't abort the
    // tick info / event emission below.
    if (
      this.postCandidateHook &&
      !providerUnavailable &&
      candidatesForHook.length > 0
    ) {
      try {
        await this.postCandidateHook(candidatesForHook, startedAt);
      } catch (err) {
        console.warn("[heartbeat] postCandidateHook failed:", err);
      }
    }
    const info: TickInfo = {
      startedAt: startedAt.toISOString(),
      finishedAt: new Date().toISOString(),
      candidatesSeen,
      alertsCreated,
      duplicates,
      skipped: providerUnavailable,
      ...(providerUnavailable
        ? { reason: "kein LLM-Provider bereit" }
        : {}),
      decisions,
    };
    this.history.unshift(info);
    if (this.history.length > MAX_HISTORY) {
      this.history.length = MAX_HISTORY;
    }
    if (created.length > 0) this.emit("alerts", created);
    this.emit("tick", info);
    this.onTick?.(info);
    return info;
  }

  /**
   * Most-recent ticks (newest first), capped at MAX_HISTORY. Used by
   * the Settings → Meldungen panel to show recent transparency rows
   * without forcing the user to manually trigger a tick to see why
   * nothing came through.
   */
  getRecentTicks(): TickInfo[] {
    return this.history.slice();
  }

  /** v0.1.160 — scheduling snapshot for the Settings panel. Lets the
   *  UI render "nächster Sweep planmäßig 14:32 · Sweep läuft alle 15 min"
   *  even when the history is empty (fresh app boot before the first
   *  tick has fired). Restart-loss of history is intentional; this
   *  status restores enough context for the user to know the scheduler
   *  IS running. */
  getStatus(): {
    running: boolean;
    intervalMs: number;
    nextScheduledAt: string | null;
    lastTickAt: string | null;
    inflight: boolean;
    historyCount: number;
  } {
    return {
      running: !this.stopped && this.intervalMs > 0,
      intervalMs: this.intervalMs,
      nextScheduledAt: this.nextScheduledAt
        ? this.nextScheduledAt.toISOString()
        : null,
      lastTickAt: this.lastTickAt ? this.lastTickAt.toISOString() : null,
      inflight: this.inflight,
      historyCount: this.history.length,
    };
  }
}

function decisionFor(
  c: HeartbeatCandidate,
  outcome: DecisionOutcome,
  rationale: string,
): CandidateDecision {
  const trimmed = rationale.trim();
  return {
    kind: c.kind,
    companyId: c.companyId,
    companyName: c.companyName,
    sourceRef: c.sourceRef,
    occurredAt: c.occurredAt,
    summary: c.summary,
    outcome,
    rationale:
      trimmed.length > RATIONALE_TRUNC
        ? trimmed.slice(0, RATIONALE_TRUNC - 1) + "…"
        : trimmed,
  };
}

// ---- Stubs (8.f1) ----------------------------------------------------------
//
// Placeholders so the renderer surface has something to render on a fresh
// install. Replaced in 8.f2 by the gateway endpoint + LLM judge.

function defaultStubSource(): CandidateSource {
  let fired = false;
  return async () => {
    if (fired) return [];
    fired = true;
    const now = new Date();
    const recent = (daysAgo: number): string =>
      new Date(now.getTime() - daysAgo * 86_400_000).toISOString();
    return [
      {
        kind: "publication",
        companyId: "DEMO_KANNEGIESSER",
        companyName: "Herbert Kannegiesser GmbH",
        sourceRef: "demo:publication:kannegiesser:expansion-2026",
        occurredAt: recent(2),
        summary:
          "Pressemitteilung zur Eröffnung eines neuen Werks in Polen mit 120 zusätzlichen Stellen.",
        payload: { topic: "expansion" },
      },
      {
        kind: "financial-delta",
        companyId: "DEMO_HETTICH",
        companyName: "Paul Hettich GmbH & Co. KG",
        sourceRef: "demo:financial-delta:hettich:fy2025",
        occurredAt: recent(14),
        summary:
          "Geschäftsbericht 2025: Umsatz +18 % gegenüber 2024 (€ 1,42 Mrd.), Operatives Ergebnis +24 %.",
        payload: { metric: "revenue", deltaPct: 18 },
      },
      {
        kind: "evaluation-flag",
        companyId: "DEMO_MIELE",
        companyName: "Miele & Cie. KG",
        sourceRef: "demo:evaluation-flag:miele:leadership-2026",
        occurredAt: recent(5),
        summary:
          "Vorstandswechsel: Reinhard Zinkann gibt operativen Vorsitz ab; Nachfolge intern bestätigt.",
        payload: { topic: "leadership" },
      },
    ];
  };
}

const defaultStubJudge: Judge = async (candidate) => {
  // 8.f1 placeholder: every demo candidate is alert-worthy, with a
  // severity heuristic just plausible enough to exercise the
  // info / warn / urgent rendering paths.
  const severity: AlertCreateInput["severity"] =
    candidate.kind === "financial-delta"
      ? "warn"
      : candidate.kind === "evaluation-flag"
        ? "urgent"
        : "info";
  return {
    worthAlerting: true,
    severity,
    headline: candidate.summary.slice(0, 120),
    rationale:
      "(Demo-Eintrag, der echte LLM-Judge mit deutschem Prompt landet in 8.f2.)",
  };
};

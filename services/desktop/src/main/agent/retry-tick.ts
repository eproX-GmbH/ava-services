// Heartbeat-driven auto-retry tick (v0.1.118).
//
// Every `intervalMs` (default 10 min, ±20 % jitter) polls the gateway
// for failed producer cells whose `nextRetryAt` has matured, then
// fires the existing per-stage retry endpoint for each. Priority order
// (fewer-attempts-first, oldest-failure-first) is enforced by the
// gateway query — we just walk the returned list and dispatch.
//
// Why a separate ticker rather than folding into Heartbeat:
//   - The alert judge tick is LLM-driven and slow; this one is a thin
//     HTTP fanout. Keeping the timers independent means a stuck judge
//     can't starve auto-retry, and vice versa.
//   - This tick has no per-tick history / transparency surface — it's
//     a quiet background process. Heartbeat's UI affordances (tick log
//     panel, severity buckets) don't apply.
//
// Gating: the tick is silently a no-op when EITHER
//   - `alertPrefs.cadenceMinutes === 0` (the user paused the whole
//     heartbeat subsystem), OR
//   - `alertPrefs.autoRetryEnabled === false`.
// Both are read live from the prefs store on every tick boundary so a
// Settings change takes effect without a restart.
//
// Staggered dispatches: each retry is fired after a 200–400 ms jitter
// from the previous one. With limit=10 that adds up to ~2–4 s of
// fanout — well under the 10-min cadence — and keeps us from hammering
// a producer queue with five simultaneous retries that all then race
// for the same captcha.

import type { GatewayClient } from "./gateway-client";
import type { AlertPrefsStore } from "./alert-prefs-store";

const DEFAULT_INTERVAL_MS = 10 * 60_000;
const JITTER = 0.2;
const STAGGER_MIN_MS = 200;
const STAGGER_MAX_MS = 400;
const DEFAULT_LIMIT = 10;

interface RetryQueueItem {
  transactionId: string;
  companyId: string;
  producer: string;
  attempts: number;
  firstFailureAt: string | null;
  lastFailureAt: string | null;
}

interface RetryQueueResponse {
  items: RetryQueueItem[];
}

/** Map kebab-case producer name (EntityProgress.producer) → matrix
 *  stage id (the camelCase value the retry endpoint accepts). Keep in
 *  lockstep with the renderer's SERVICE_TO_STAGE map. */
const SERVICE_TO_STAGE: Record<string, string> = {
  "structured-content": "structuredContent",
  "company-publication": "companyPublication",
  website: "website",
  "company-profile": "companyProfile",
  "company-contact": "companyContact",
  "company-evaluation": "companyEvaluation",
};

export interface RetryTickOptions {
  gateway: GatewayClient;
  alertPrefs: AlertPrefsStore;
  intervalMs?: number;
  /** Cap on rows per tick. Default 10. */
  maxPerTick?: number;
  /** Optional log sink — defaults to console.info. */
  log?: (msg: string, ctx?: Record<string, unknown>) => void;
}

export class RetryTicker {
  private readonly gateway: GatewayClient;
  private readonly alertPrefs: AlertPrefsStore;
  private intervalMs: number;
  private readonly maxPerTick: number;
  private readonly log: (msg: string, ctx?: Record<string, unknown>) => void;
  private timer: NodeJS.Timeout | null = null;
  private inflight = false;
  private stopped = false;

  constructor(options: RetryTickOptions) {
    this.gateway = options.gateway;
    this.alertPrefs = options.alertPrefs;
    this.intervalMs = options.intervalMs ?? DEFAULT_INTERVAL_MS;
    this.maxPerTick = options.maxPerTick ?? DEFAULT_LIMIT;
    this.log =
      options.log ??
      ((msg, ctx) => {
        if (ctx) console.info(`[retry-tick] ${msg}`, ctx);
        else console.info(`[retry-tick] ${msg}`);
      });
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

  setIntervalMs(intervalMs: number): void {
    this.intervalMs = intervalMs;
    if (this.timer) {
      clearTimeout(this.timer);
      this.timer = null;
    }
    if (!this.stopped && intervalMs > 0) this.scheduleNext();
  }

  /** Force a tick now. If one is in flight, this is a no-op. */
  async triggerNow(): Promise<{ picked: number; dispatched: number }> {
    if (this.inflight) return { picked: 0, dispatched: 0 };
    return this.runTick();
  }

  // ---- Internal ----------------------------------------------------------

  private scheduleNext(): void {
    if (this.stopped || this.intervalMs === 0) return;
    const jitter = 1 + (Math.random() * 2 - 1) * JITTER;
    const delay = Math.max(1_000, Math.round(this.intervalMs * jitter));
    this.timer = setTimeout(() => {
      this.timer = null;
      void this.runTick().finally(() => this.scheduleNext());
    }, delay);
  }

  private async runTick(): Promise<{ picked: number; dispatched: number }> {
    const prefs = this.alertPrefs.get();
    if (!prefs.autoRetryEnabled || prefs.cadenceMinutes === 0) {
      return { picked: 0, dispatched: 0 };
    }
    if (this.inflight) return { picked: 0, dispatched: 0 };
    this.inflight = true;
    let picked = 0;
    let dispatched = 0;
    try {
      const res = await this.gateway.request<RetryQueueResponse>(
        `/v1/transactions/retry-queue/pending?limit=${this.maxPerTick}`,
      );
      const items = res.items ?? [];
      picked = items.length;
      if (picked === 0) return { picked, dispatched };
      this.log(`picked ${picked} row(s) due for retry`);
      for (const item of items) {
        const stage = SERVICE_TO_STAGE[item.producer];
        if (!stage) {
          this.log(`skip — unknown producer ${item.producer}`);
          continue;
        }
        try {
          await this.gateway.request(
            `/v1/transactions/${encodeURIComponent(item.transactionId)}` +
              `/entities/${encodeURIComponent(item.companyId)}/retry`,
            {
              method: "POST",
              body: { stage },
            },
          );
          dispatched += 1;
        } catch (err) {
          this.log("retry dispatch failed", {
            transactionId: item.transactionId,
            companyId: item.companyId,
            producer: item.producer,
            error: err instanceof Error ? err.message : String(err),
          });
        }
        // Staggered jitter between dispatches — keeps us from spiking
        // five simultaneous producer queue claims on the same captcha.
        const jit =
          STAGGER_MIN_MS +
          Math.round(Math.random() * (STAGGER_MAX_MS - STAGGER_MIN_MS));
        await new Promise((resolve) => setTimeout(resolve, jit));
      }
    } catch (err) {
      this.log("tick failed", {
        error: err instanceof Error ? err.message : String(err),
      });
    } finally {
      this.inflight = false;
    }
    return { picked, dispatched };
  }
}

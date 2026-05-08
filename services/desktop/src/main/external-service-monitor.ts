// v0.1.52 — periodic reachability probe for upstream Selenium targets.
//
// Today: only unternehmensregister.de matters. structured-content +
// company-publication both scrape it; if it's down, every job fails
// at session-creation or page-load, burning Selenium / chromedriver
// cycles for nothing and littering the matrix with red cells.
//
// Behavior:
//   - HEAD probe every PROBE_INTERVAL_MS (default 60s).
//   - State is one of:
//       "unknown"     — process just started, never probed
//       "reachable"   — last probe succeeded
//       "unreachable" — last probe failed
//   - Emits a "status" event whenever the state changes (NOT on every
//     probe — listeners only fire on transitions). Renderer banner
//     subscribes; main/index.ts also subscribes to gate producer
//     supervisors for the affected services.
//
// Design notes:
//   - Probe runs from each desktop, not the gateway. The desktop is
//     where the actual scrape happens, so its vantage point is what
//     matters: regional outages or the user's local network state
//     would be invisible from a gateway probe.
//   - HEAD is enough: GET would download the homepage on every cycle.
//     When the site is misconfigured to reject HEAD we'll see 405 and
//     treat that as reachable too (anything < 500 = "site is up").
//   - Soft state on startup: don't pause producers immediately on
//     unknown → unreachable; give the first probe a chance to succeed
//     before disrupting an already-started supervisor.

import { EventEmitter } from "node:events";

export type ExternalServiceState = "unknown" | "reachable" | "unreachable";

export interface ExternalServiceStatus {
  /** Stable id; matches the renderer's banner copy + IPC channel. */
  service: "unternehmensregister";
  state: ExternalServiceState;
  /** Probe url (informational; surfaced in Settings if we add a panel). */
  url: string;
  /** Wallclock ms of the most recent probe attempt. */
  lastCheckedAt: number | null;
  /** Wallclock ms of the most recent successful probe. Sticks across
   *  failures so the renderer can show "last reachable: 3 min ago". */
  lastReachableAt: number | null;
  /** Round-trip ms of the last successful probe. null on failure. */
  latencyMs: number | null;
  /** Last error message — only set when state="unreachable". */
  errorMessage: string | null;
}

const PROBE_URL = "https://www.unternehmensregister.de/";
// v0.1.56 — relaxed cadence. Hourly-ish probes are plenty; producers
// that actually hit the upstream report ECONNRESET-class failures via
// `reportUnreachable()` directly, which flips the state without waiting
// for the next tick. Frequent HEAD probes used to be the only signal,
// so 60s made sense. Now they're a fallback / recovery detector.
const PROBE_INTERVAL_MS = 15 * 60_000;
const PROBE_TIMEOUT_MS = 10_000;

/** Connection-level error patterns producers surface when the upstream
 *  is degraded mid-Selenium. Used by the log-buffer hook in main/index.ts
 *  to flip the monitor immediately instead of waiting for the next
 *  scheduled probe. */
export const UPSTREAM_FAILURE_PATTERNS: RegExp[] = [
  /\bECONNRESET\b/,
  /\bECONNREFUSED\b/,
  /\bETIMEDOUT\b/,
  /\bENOTFOUND\b/,
  /\bEAI_AGAIN\b/,
  /\bEPIPE\b/,
  /\bUND_ERR_CONNECT_TIMEOUT\b/,
  /net::ERR_NAME_NOT_RESOLVED/i,
  /net::ERR_CONNECTION_RESET/i,
  /net::ERR_CONNECTION_REFUSED/i,
  /net::ERR_CONNECTION_TIMED_OUT/i,
  /unable to connect to renderer/i,
];

export class ExternalServiceMonitor extends EventEmitter {
  private status: ExternalServiceStatus = {
    service: "unternehmensregister",
    state: "unknown",
    url: PROBE_URL,
    lastCheckedAt: null,
    lastReachableAt: null,
    latencyMs: null,
    errorMessage: null,
  };
  private timer: NodeJS.Timeout | null = null;
  private probeInFlight = false;

  /** Idempotent. Kicks off an immediate probe + sets up the recurring
   *  timer. Call once at app boot from main/index.ts. */
  start(): void {
    if (this.timer) return;
    void this.probe();
    this.timer = setInterval(() => {
      void this.probe();
    }, PROBE_INTERVAL_MS);
    // Don't keep the event loop alive just for this; if everything else
    // is shutting down, the interval shouldn't block exit.
    this.timer.unref?.();
  }

  /** Stop the recurring probe. Called on app quit. */
  stop(): void {
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = null;
    }
  }

  getStatus(): ExternalServiceStatus {
    return { ...this.status };
  }

  /** Force a probe without waiting for the next tick. Useful when the
   *  user clicks a "Retry now" button in the banner (future). */
  async probeNow(): Promise<ExternalServiceStatus> {
    await this.probe();
    return this.getStatus();
  }

  /**
   * v0.1.56 — fast-path failure flag. Producers that hit an
   * ECONNRESET-class error mid-scrape call this (via the log-buffer
   * hook in main/index.ts) so the banner + auto-pause flip
   * immediately, instead of waiting up to 15 minutes for the next
   * scheduled probe. The next probe will eventually verify recovery
   * and flip the state back to "reachable" on its own.
   *
   * Idempotent — repeated calls while already-unreachable are no-ops
   * (no event emitted, since update() only emits on transition).
   */
  reportUnreachable(reason: string): void {
    this.update({
      service: "unternehmensregister",
      state: "unreachable",
      url: PROBE_URL,
      lastCheckedAt: Date.now(),
      lastReachableAt: this.status.lastReachableAt,
      latencyMs: null,
      errorMessage: reason,
    });
  }

  private async probe(): Promise<void> {
    if (this.probeInFlight) return;
    this.probeInFlight = true;
    const startedAt = Date.now();
    try {
      const controller = new AbortController();
      const timeout = setTimeout(
        () => controller.abort(),
        PROBE_TIMEOUT_MS,
      );
      let res: Response;
      try {
        res = await fetch(PROBE_URL, {
          method: "HEAD",
          signal: controller.signal,
          // Don't follow redirects — a 3xx is fine evidence the host
          // is up; chasing them just adds latency.
          redirect: "manual",
        });
      } finally {
        clearTimeout(timeout);
      }
      const latencyMs = Date.now() - startedAt;
      // Treat anything < 500 as "site is up". 401/403/404 still mean
      // their server answered. 5xx means their backend is sick.
      const isUp = res.status > 0 && res.status < 500;
      this.update({
        service: "unternehmensregister",
        state: isUp ? "reachable" : "unreachable",
        url: PROBE_URL,
        lastCheckedAt: Date.now(),
        lastReachableAt: isUp ? Date.now() : this.status.lastReachableAt,
        latencyMs: isUp ? latencyMs : null,
        errorMessage: isUp ? null : `HTTP ${res.status}`,
      });
    } catch (err) {
      this.update({
        service: "unternehmensregister",
        state: "unreachable",
        url: PROBE_URL,
        lastCheckedAt: Date.now(),
        lastReachableAt: this.status.lastReachableAt,
        latencyMs: null,
        errorMessage: err instanceof Error ? err.message : String(err),
      });
    } finally {
      this.probeInFlight = false;
    }
  }

  private update(next: ExternalServiceStatus): void {
    const stateChanged = next.state !== this.status.state;
    this.status = next;
    if (stateChanged) {
      this.emit("status", { ...next });
    }
  }
}

/**
 * Producers whose work depends on unternehmensregister.de being up.
 * Auto-paused when the monitor reports unreachable; auto-resumed
 * when it flips back to reachable. Exported for use in main/index.ts
 * to gate ProducerSupervisor lifecycle.
 */
export const UNTERNEHMENSREGISTER_DEPENDENT_PRODUCERS: ReadonlySet<string> =
  new Set(["structured-content", "company-publication"]);

// v0.1.52 — periodic reachability probe for upstream Selenium targets.
// v0.1.105 — multi-source variant (Session A of feat/multi-source-reachability).
//
// Today: structured-content + company-publication scrape
// unternehmensregister.de. We're adding handelsregister.de as a
// fallback source for structured-content; the picker in
// `./structured-content-source.ts` will eventually flip to it when
// unternehmensregister is down. To make that decision well, we need
// reachability signals for BOTH hosts, which is what this module now
// provides.
//
// Shape change:
//   - Each probed service has its own ExternalServiceStatus record
//     (state, lastCheckedAt, lastReachableAt, latencyMs, ...).
//   - A single ExternalServicesStatus aggregate carries the per-service
//     map plus convenience flags (anyReachable / allReachable) for
//     consumers that previously cared about a single boolean.
//   - The status event now broadcasts the aggregate; `getStatus()` /
//     `probeNow()` return the aggregate too.
//
// All other behavior is preserved per service:
//   - HEAD probe every PROBE_INTERVAL_MS.
//   - 405 / opaque-redirect tolerated as "site is up".
//   - FAILED_PROBES_THRESHOLD = 2 hysteresis before flipping to
//     unreachable; recovery is instant on the first good probe.
//   - FAST_PATH_COOLDOWN_MS suppresses producer-driven
//     reportUnreachable() while a recent probe still says we're fine.
//   - PROBE_TIMEOUT_MS = 120s — unternehmensregister.de in particular
//     is genuinely slow on bad days.

import { EventEmitter } from "node:events";

export type ExternalServiceState = "unknown" | "reachable" | "unreachable";

/** Stable ids the rest of the system uses to address a probed service.
 *  Keep these stable: the producer-pause sets and the renderer's banner
 *  copy + DiagnosticsPanel labels reference them. */
export type ExternalServiceId = "unternehmensregister" | "handelsregister";

export interface ExternalServiceStatus {
  service: ExternalServiceId;
  state: ExternalServiceState;
  /** Probe url (informational). */
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
  /** v0.1.105 — running counter exposed for diagnostics + tests. */
  consecutiveFailures: number;
}

/** Aggregate broadcast shape. Keyed map of per-service status plus
 *  convenience booleans for any consumer that just wants "is the
 *  upstream layer broadly OK". */
export interface ExternalServicesStatus {
  services: Record<ExternalServiceId, ExternalServiceStatus>;
  /** True if at least one probed service is reachable. */
  anyReachable: boolean;
  /** True if every probed service is reachable. */
  allReachable: boolean;
}

interface ProbedService {
  id: ExternalServiceId;
  url: string;
}

const PROBED_SERVICES: ReadonlyArray<ProbedService> = [
  { id: "unternehmensregister", url: "https://www.unternehmensregister.de/" },
  { id: "handelsregister", url: "https://www.handelsregister.de/" },
];

// v0.1.56 — relaxed cadence. Hourly-ish probes are plenty; producers
// that actually hit the upstream report ECONNRESET-class failures via
// `reportUnreachable()` directly, which flips the state without waiting
// for the next tick.
const PROBE_INTERVAL_MS = 15 * 60_000;
// v0.1.82 / v0.1.102 — 120s aligns with Chrome's user-perceived
// "this page is taking forever" threshold so a one-off slow render
// never flips us to unreachable.
const PROBE_TIMEOUT_MS = 120_000;
// v0.1.102 — hysteresis. One bad probe doesn't flip; we need
// FAILED_PROBES_THRESHOLD consecutive failures. Recovery is still
// instant (a single 200 flips back to reachable). Counter resets
// on every successful probe.
const FAILED_PROBES_THRESHOLD = 2;
// v0.1.102 — cooldown for producer fast-path errors.
const FAST_PATH_COOLDOWN_MS = 5 * 60_000;

/** Connection-level error patterns producers surface when an upstream
 *  is degraded mid-Selenium. Used by the log-buffer hook in
 *  main/index.ts to flip the monitor immediately instead of waiting
 *  for the next scheduled probe. */
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

function emptyStatus(svc: ProbedService): ExternalServiceStatus {
  return {
    service: svc.id,
    state: "unknown",
    url: svc.url,
    lastCheckedAt: null,
    lastReachableAt: null,
    latencyMs: null,
    errorMessage: null,
    consecutiveFailures: 0,
  };
}

export class ExternalServiceMonitor extends EventEmitter {
  private statuses: Record<ExternalServiceId, ExternalServiceStatus>;
  private timer: NodeJS.Timeout | null = null;
  private probesInFlight: Partial<Record<ExternalServiceId, boolean>> = {};

  constructor() {
    super();
    const init = {} as Record<ExternalServiceId, ExternalServiceStatus>;
    for (const svc of PROBED_SERVICES) {
      init[svc.id] = emptyStatus(svc);
    }
    this.statuses = init;
  }

  /** Idempotent. Kicks off an immediate probe for each service + sets
   *  up the recurring timer. Call once at app boot from main/index.ts. */
  start(): void {
    if (this.timer) return;
    for (const svc of PROBED_SERVICES) void this.probe(svc);
    this.timer = setInterval(() => {
      for (const svc of PROBED_SERVICES) void this.probe(svc);
    }, PROBE_INTERVAL_MS);
    this.timer.unref?.();
  }

  /** Stop the recurring probe. Called on app quit. */
  stop(): void {
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = null;
    }
  }

  getStatus(): ExternalServicesStatus {
    return this.snapshot();
  }

  /** Convenience accessor for a single service. */
  getServiceStatus(id: ExternalServiceId): ExternalServiceStatus {
    return { ...this.statuses[id] };
  }

  /** Force a probe of every service without waiting for the next tick.
   *  Useful for the banner's "Retry now" button. */
  async probeNow(): Promise<ExternalServicesStatus> {
    await Promise.all(PROBED_SERVICES.map((svc) => this.probe(svc)));
    return this.snapshot();
  }

  /**
   * v0.1.56 — fast-path failure flag. Producers that hit an
   * ECONNRESET-class error mid-scrape call this so the banner +
   * auto-pause flip immediately. v0.1.105 takes a service id since
   * we now track multiple upstreams; previously this was implicitly
   * unternehmensregister-only.
   *
   * Idempotent — repeated calls while already-unreachable just
   * refresh lastCheckedAt + errorMessage.
   */
  reportUnreachable(id: ExternalServiceId, reason: string): void {
    const cur = this.statuses[id];
    if (!cur) return;
    // v0.1.102 — fast-path cooldown. If we successfully probed
    // recently, a single Selenium tick error is much more likely a
    // transient hiccup than a real outage.
    if (
      cur.state === "reachable" &&
      cur.lastReachableAt !== null &&
      Date.now() - cur.lastReachableAt < FAST_PATH_COOLDOWN_MS
    ) {
      return;
    }
    this.update(id, {
      ...cur,
      state: "unreachable",
      lastCheckedAt: Date.now(),
      latencyMs: null,
      errorMessage: reason,
      // We're flipping based on a producer-observed failure rather
      // than a probe — surface that as a saturated counter so the
      // diagnostics view reflects "we're confident this is down".
      consecutiveFailures: Math.max(
        cur.consecutiveFailures,
        FAILED_PROBES_THRESHOLD,
      ),
    });
  }

  private async probe(svc: ProbedService): Promise<void> {
    if (this.probesInFlight[svc.id]) return;
    this.probesInFlight[svc.id] = true;
    const startedAt = Date.now();
    try {
      const controller = new AbortController();
      const timeout = setTimeout(
        () => controller.abort(),
        PROBE_TIMEOUT_MS,
      );
      let res: Response;
      try {
        res = await fetch(svc.url, {
          method: "HEAD",
          signal: controller.signal,
          redirect: "manual",
        });
      } finally {
        clearTimeout(timeout);
      }
      const latencyMs = Date.now() - startedAt;
      // v0.1.102 — anything < 500 means the server answered: site is up.
      // 405 (Method Not Allowed) shows up when CDNs reject HEAD; that's
      // also a clear "site is up" signal. status === 0 happens for
      // opaque redirects we asked not to follow with `redirect: "manual"`.
      const isUp = res.status === 0 || (res.status > 0 && res.status < 500);
      if (isUp) {
        this.update(svc.id, {
          service: svc.id,
          state: "reachable",
          url: svc.url,
          lastCheckedAt: Date.now(),
          lastReachableAt: Date.now(),
          latencyMs,
          errorMessage: null,
          consecutiveFailures: 0,
        });
      } else {
        this.handleFailure(svc, `HTTP ${res.status}`);
      }
    } catch (err) {
      this.handleFailure(svc, err instanceof Error ? err.message : String(err));
    } finally {
      this.probesInFlight[svc.id] = false;
    }
  }

  /** Hysteresis. Don't flip to unreachable until we've seen
   *  FAILED_PROBES_THRESHOLD consecutive failures. */
  private handleFailure(svc: ProbedService, reason: string): void {
    const cur = this.statuses[svc.id];
    const consecutive = cur.consecutiveFailures + 1;
    const flip = consecutive >= FAILED_PROBES_THRESHOLD;
    this.update(svc.id, {
      service: svc.id,
      state: flip ? "unreachable" : cur.state,
      url: svc.url,
      lastCheckedAt: Date.now(),
      lastReachableAt: cur.lastReachableAt,
      latencyMs: null,
      errorMessage: flip
        ? reason
        : `${reason} (Versuch ${consecutive}/${FAILED_PROBES_THRESHOLD}, kein Banner)`,
      consecutiveFailures: consecutive,
    });
  }

  private update(id: ExternalServiceId, next: ExternalServiceStatus): void {
    this.statuses[id] = next;
    // Emit on every probe completion, not only on state transitions.
    // The renderer's dismissable banner uses lastCheckedAt to decide
    // whether to re-surface a previously-dismissed warning.
    this.emit("status", this.snapshot());
  }

  private snapshot(): ExternalServicesStatus {
    const services = {} as Record<ExternalServiceId, ExternalServiceStatus>;
    let anyReachable = false;
    let allReachable = true;
    for (const svc of PROBED_SERVICES) {
      const s = { ...this.statuses[svc.id] };
      services[svc.id] = s;
      if (s.state === "reachable") anyReachable = true;
      if (s.state !== "reachable") allReachable = false;
    }
    return { services, anyReachable, allReachable };
  }
}

/**
 * Producers whose work depends on unternehmensregister.de being up.
 * Auto-paused when the monitor reports unreachable; auto-resumed
 * when it flips back to reachable.
 *
 * Note: even after Session B flips structured-content to prefer
 * handelsregister.de when available, this set remains correct for
 * the "everything is down" case — the auto-pause logic in
 * main/index.ts checks anyReachable across both sources before
 * pausing structured-content.
 */
export const UNTERNEHMENSREGISTER_DEPENDENT_PRODUCERS: ReadonlySet<string> =
  new Set(["structured-content", "company-publication"]);

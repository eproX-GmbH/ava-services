// Stuck-progress reaper (v0.1.378).
//
// Problem it solves: a producer step flips its EntityProgress row to
// `in_progress` at receive-time ("läuft", yellow in the UI) and is
// expected to follow up with a terminal event (`completed`/`failed`/
// `skipped`). If the worker dies in between — crash, OOM, killed,
// machine offline, an older bundle that requeues without emitting
// `failed`, or an upstream that's hard-down — no terminal event ever
// arrives. The cell then stays yellow FOREVER and the whole pipeline
// looks frozen, even though the step has effectively failed. Users see
// "läuft" on every step and "FEHLER (0)" and assume AVA hung.
//
// This periodic job flips any row stuck in `in_progress` past a timeout
// to `failed` with a clear reason, so the pipeline shows RED ("ein
// Schritt ist fehlgeschlagen") instead of a frozen yellow.
//
// Safety / self-healing:
//   - Only touches `in_progress` rows older than the timeout. The
//     timeout (default 30 min, env STUCK_PROGRESS_TIMEOUT_MINUTES) is
//     set WELL above the slowest legitimate single producer run
//     (Selenium scraping), so a step that's genuinely still working is
//     never reaped mid-run.
//   - A later real `completed` event still wins: the event-bus guard
//     allows terminal-over-terminal when newer, and the matrix ordering
//     prefers `completed` over `failed`. So when the producer eventually
//     succeeds (e.g. ValueSERP recovers, machine back online, re-import),
//     the cell flips green automatically.
//   - We do NOT set `nextRetryAt`/`giveUpAt` — re-runs are driven by the
//     normal dispatch/redelivery paths, not the gateway retry heartbeat.

import { getGatewayPool } from "./producer-pools";
import { loadEnv } from "./env";
import { logger } from "./logger";

const REAP_REASON =
  "Zeitüberschreitung: Dieser Schritt hat über längere Zeit kein " +
  "Lebenszeichen mehr gesendet und gilt als fehlgeschlagen (Worker " +
  "abgestürzt/offline oder ein Dienst war nicht erreichbar). Beim " +
  "nächsten erfolgreichen Lauf wird er automatisch wieder grün.";

/** Periodic reaper. Runs every 5 min, staggered 60 s after boot so it
 *  doesn't pile onto the boot storm. No-op when the timeout is 0. */
export function startStuckProgressReaperCron(): void {
  const timeoutMin = loadEnv().STUCK_PROGRESS_TIMEOUT_MINUTES;
  if (!timeoutMin || timeoutMin <= 0) {
    logger.info("[stuck-reaper] disabled (STUCK_PROGRESS_TIMEOUT_MINUTES=0)");
    return;
  }
  const INTERVAL_MS = 5 * 60_000;
  setTimeout(() => {
    void reapTick(timeoutMin);
    setInterval(() => {
      void reapTick(timeoutMin);
    }, INTERVAL_MS);
  }, 60_000);
  logger.info(
    { intervalMs: INTERVAL_MS, timeoutMin },
    "[stuck-reaper] cron scheduled",
  );
}

async function reapTick(timeoutMin: number): Promise<void> {
  try {
    const res = await getGatewayPool().query(
      `UPDATE "EntityProgress"
          SET state = 'failed',
              "errorMessage" = $1,
              "updatedAt" = NOW(),
              "lastFailureAt" = NOW(),
              "firstFailureAt" = COALESCE("firstFailureAt", NOW())
        WHERE state = 'in_progress'
          AND "updatedAt" < NOW() - ($2::int * INTERVAL '1 minute')`,
      [REAP_REASON, timeoutMin],
    );
    if (res.rowCount && res.rowCount > 0) {
      logger.warn(
        { reaped: res.rowCount, timeoutMin },
        "[stuck-reaper] flipped stuck in_progress rows to failed",
      );
    }
  } catch (err) {
    logger.error(
      { err: err instanceof Error ? err.message : String(err) },
      "[stuck-reaper] tick failed",
    );
  }
}

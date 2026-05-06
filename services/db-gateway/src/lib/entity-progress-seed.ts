// §8.v3 — seed EntityProgress with pending rows right after the
// Excel/single-row import returns a transactionId.
//
// Why this exists:
//   The desktop pipeline matrix (companies × producers) reads from
//   the gateway's `EntityProgress` table. Producer completions write
//   rows there via `lib/persist-bus.ts`. With local compute that can
//   take several minutes per company (captcha-gated scrapes), so the
//   matrix would be empty for the first long stretch after import —
//   the user sees a blank transaction page and assumes the pipeline
//   is broken.
//
//   Plan A (chosen over an AMQP fanout subscriber): right after
//   master-data accepts the import and returns the transactionId, the
//   gateway calls `GET /api/v1/transactions/:id/companies` to read
//   the companyId list master-data resolved at dispatch time, then
//   bulk-inserts `(transactionId, companyId, producer, "pending")`
//   for each (companyId × producer) into EntityProgress.
//
//   Producer completions later overwrite via the existing persist-bus
//   ON CONFLICT path. The persist-bus's last-write-wins guard is
//   `WHERE EXCLUDED."updatedAt" > "EntityProgress"."updatedAt"`, so
//   pending rows seeded at NOW() are correctly superseded by terminal
//   states whose NOW() arrives later.
//
//   ON CONFLICT DO NOTHING here, not DO UPDATE — if a producer
//   somehow finished a company before this seed ran (e.g. a slow
//   master-data round-trip vs a fast scrape that completed during the
//   seed call), we don't want to clobber the terminal state with
//   `pending`.

import type { Context } from "hono";
import { callUpstream } from "./upstream";
import { getGatewayPool } from "./producer-pools";
import { PRODUCER_NAMES } from "./db-urls";
import { logger as baseLogger } from "./logger";

const logger = baseLogger.child({ component: "entity-progress-seed" });

interface CompaniesResponse {
  companyIds: string[];
}

/**
 * Best-effort seed. Failures are logged + swallowed — the import
 * itself already succeeded upstream and the user has the
 * transactionId. The matrix will simply stay empty until the first
 * producer completes (the pre-seed behaviour). Don't 502 over
 * cosmetics.
 */
export async function seedEntityProgressForTransaction(
  c: Context,
  transactionId: string,
): Promise<void> {
  let companyIds: string[] = [];
  try {
    const res = await callUpstream<CompaniesResponse>(
      c,
      "masterData",
      `/api/v1/transactions/${encodeURIComponent(transactionId)}/companies`,
    );
    companyIds = res?.companyIds ?? [];
  } catch (err) {
    logger.warn(
      {
        err: err instanceof Error ? err.message : String(err),
        transactionId,
      },
      "seed: failed to fetch companyIds upstream; skipping seed",
    );
    return;
  }

  if (companyIds.length === 0) {
    // Pre-§8.v3 transaction or genuinely empty import. Either way
    // there's nothing to seed.
    logger.debug(
      { transactionId },
      "seed: no companyIds for transaction; skipping",
    );
    return;
  }

  // Build a single multi-row INSERT. Unnest pattern keeps the param
  // count to two arrays regardless of (companies × producers) — well
  // within Postgres' 65535 parameter ceiling even at thousand-company
  // imports.
  const producers = PRODUCER_NAMES;
  const companyParams: string[] = [];
  const producerParams: string[] = [];
  for (const companyId of companyIds) {
    for (const producer of producers) {
      companyParams.push(companyId);
      producerParams.push(producer);
    }
  }

  try {
    const pool = getGatewayPool();
    await pool.query(
      `INSERT INTO "EntityProgress"
         ("transactionId", "companyId", producer, state, "errorMessage",
          "updatedAt", "createdAt")
       SELECT $1, c, p, 'pending', NULL, NOW(), NOW()
       FROM unnest($2::text[], $3::text[]) AS t(c, p)
       ON CONFLICT ("transactionId", "companyId", producer) DO NOTHING`,
      [transactionId, companyParams, producerParams],
    );
    logger.info(
      {
        transactionId,
        companies: companyIds.length,
        producers: producers.length,
        rows: companyParams.length,
      },
      "seed: EntityProgress seeded with pending rows",
    );
  } catch (err) {
    logger.warn(
      {
        err: err instanceof Error ? err.message : String(err),
        transactionId,
      },
      "seed: bulk insert failed; matrix will populate as producers finish",
    );
  }
}

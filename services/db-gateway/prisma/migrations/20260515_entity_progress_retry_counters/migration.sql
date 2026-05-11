-- v0.1.118 — heartbeat-driven auto-retry counters on EntityProgress.
--
-- Five new columns:
--   attempts        — cumulative failed-state hits since the last success
--   firstFailureAt  — wall-clock of the first failure in the current run
--   lastFailureAt   — wall-clock of the most recent failure
--   nextRetryAt     — earliest moment the heartbeat may re-pick this row
--   giveUpAt        — non-null once attempts >= MAX AND run age > 24h
--
-- All columns default to safe "no-retry-state" values (0 / NULL) so
-- existing rows continue to behave like before until a fresh failure
-- transitions them.
--
-- The partial index covers the heartbeat's pick query exactly:
--   WHERE state='failed' AND "giveUpAt" IS NULL AND "nextRetryAt" <= NOW()
--   ORDER BY attempts ASC, "lastFailureAt" ASC

ALTER TABLE "EntityProgress"
  ADD COLUMN IF NOT EXISTS "attempts"       INTEGER     NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS "firstFailureAt" TIMESTAMP   NULL,
  ADD COLUMN IF NOT EXISTS "lastFailureAt"  TIMESTAMP   NULL,
  ADD COLUMN IF NOT EXISTS "nextRetryAt"    TIMESTAMP   NULL,
  ADD COLUMN IF NOT EXISTS "giveUpAt"       TIMESTAMP   NULL;

CREATE INDEX IF NOT EXISTS "EntityProgress_retry_queue_idx"
  ON "EntityProgress" ("nextRetryAt", "attempts")
  WHERE state = 'failed' AND "giveUpAt" IS NULL;

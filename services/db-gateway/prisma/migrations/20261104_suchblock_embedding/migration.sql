-- docs/PLAN_BESTANDSSUCHE.md S3 — Embeddings lokal gerechnet (Desktop, embeddinggemma), hier nur abgelegt.
ALTER TABLE "SuchBlock" ADD COLUMN IF NOT EXISTS "embeddingModell" TEXT;
CREATE INDEX IF NOT EXISTS "SuchBlock_offen_idx" ON "SuchBlock" ("companyId") WHERE "embedding" IS NULL;

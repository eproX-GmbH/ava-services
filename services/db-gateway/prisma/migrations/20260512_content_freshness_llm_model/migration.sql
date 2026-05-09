-- v0.1.65 — record exact LLM model alongside tier on ContentFreshness.
--
-- Tier (1..4) is the reliability bucket; the model id is the audit
-- trail surfaced on CompanyDetail tooltips and to the agent's
-- company-context tool. Backfill = NULL — no historical inference;
-- existing rows fade in to "unbekannt" until the next compute cycle
-- writes the cell.

ALTER TABLE "ContentFreshness" ADD COLUMN "llmModel" TEXT;

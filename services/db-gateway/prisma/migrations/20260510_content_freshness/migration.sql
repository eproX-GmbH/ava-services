-- v0.1.62 — tier-aware persist freshness tracking.

CREATE TABLE "ContentFreshness" (
    "companyId" TEXT         NOT NULL,
    "stage"     TEXT         NOT NULL,
    "llmTier"   INTEGER,
    "updatedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "ContentFreshness_pkey" PRIMARY KEY ("companyId", "stage")
);

CREATE INDEX "ContentFreshness_companyId_idx" ON "ContentFreshness" ("companyId");

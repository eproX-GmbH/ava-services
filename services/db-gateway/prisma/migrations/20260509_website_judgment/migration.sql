-- v0.1.60 — LLM-judge audit row.
-- One row per company; persist-bus upserts on each website persist.

CREATE TABLE "WebsiteJudgment" (
    "companyId"            TEXT         NOT NULL,
    "matchIndex"           INTEGER,
    "confidence"           TEXT,
    "reasoning"            TEXT,
    "candidatesConsidered" INTEGER      NOT NULL,
    "judgedAt"             TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt"            TIMESTAMP(3) NOT NULL,
    CONSTRAINT "WebsiteJudgment_pkey" PRIMARY KEY ("companyId")
);

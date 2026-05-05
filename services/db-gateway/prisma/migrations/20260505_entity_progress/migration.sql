-- §8.v3 — per-company processing state in the gateway's audit DB.
-- Persist-bus writes one row per producer per company on every
-- `tenant.persist.<producer>.v1` event. Reads back via
-- `/v1/transactions/:id/entities`.

CREATE TABLE "EntityProgress" (
    "transactionId" TEXT NOT NULL,
    "companyId" TEXT NOT NULL,
    "producer" TEXT NOT NULL,
    "state" TEXT NOT NULL,
    "errorMessage" TEXT,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "EntityProgress_pkey" PRIMARY KEY ("transactionId", "companyId", "producer")
);

-- Hot read path is by transactionId — the chat tool fetches all
-- companies in one go.
CREATE INDEX "EntityProgress_transactionId_idx" ON "EntityProgress"("transactionId");

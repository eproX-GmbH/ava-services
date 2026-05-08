-- M1 of monetization plan (v0.1.59).
-- Per-tenant billing state + per-(tenant, period, company) usage credits.

CREATE TABLE "TenantBilling" (
    "tenantId"             TEXT         NOT NULL,
    "tier"                 TEXT         NOT NULL DEFAULT 'free',
    "quotaLimit"           INTEGER      NOT NULL DEFAULT 25,
    "stripeCustomerId"     TEXT,
    "stripeSubscriptionId" TEXT,
    "periodEnd"            TIMESTAMP(3),
    "updatedAt"            TIMESTAMP(3) NOT NULL,
    "createdAt"            TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "TenantBilling_pkey" PRIMARY KEY ("tenantId")
);

CREATE TABLE "UsageEntry" (
    "tenantId"  TEXT         NOT NULL,
    "periodKey" TEXT         NOT NULL,
    "companyId" TEXT         NOT NULL,
    "source"    TEXT         NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "UsageEntry_pkey" PRIMARY KEY ("tenantId", "periodKey", "companyId")
);

-- Counter window: SELECT COUNT(*) FROM "UsageEntry" WHERE "tenantId"=$1 AND "periodKey"=$2
CREATE INDEX "UsageEntry_tenantId_periodKey_idx" ON "UsageEntry" ("tenantId", "periodKey");

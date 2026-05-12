-- Q-track v0.1.137 — Deferred-processing quota.
--
-- Tenant-scoped park-state for companies that landed via an import but
-- can't fire their per-company producer triggers yet because the
-- tenant's quota is exhausted. The resume-worker (Stripe webhook +
-- 5-min cron) replays these in batches once headroom appears.
--
-- Master-data's `GermanCompany` table is global; placing per-tenant
-- park state there would break the compute-locality invariant. The
-- gateway already hosts every other tenant-scoped table (TenantBilling,
-- UsageEntry, EntityProgress), so this is the right home.

CREATE TABLE "ParkedCompany" (
  "tenantId"        TEXT NOT NULL,
  "germanCompanyId" TEXT NOT NULL,
  "transactionId"   TEXT,
  "parkedAt"        TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

  CONSTRAINT "ParkedCompany_pkey" PRIMARY KEY ("tenantId", "germanCompanyId")
);

CREATE INDEX "ParkedCompany_tenantId_parkedAt_idx"
  ON "ParkedCompany" ("tenantId", "parkedAt");

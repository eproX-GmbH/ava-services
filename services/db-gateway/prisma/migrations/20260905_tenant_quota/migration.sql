-- O6 (docs/PLAN_ORGANISATIONEN.md) — Limits fuer Stellvertreter-Aufrufe.
CREATE TABLE "TenantQuota" (
  "tenantId"        TEXT NOT NULL,
  "mode"            TEXT NOT NULL DEFAULT 'off',
  "orgMonthlyCents" INTEGER,
  "userDailyCents"  INTEGER,
  "hardStop"        BOOLEAN NOT NULL DEFAULT true,
  "updatedAt"       TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedBy"       TEXT,
  CONSTRAINT "TenantQuota_pkey" PRIMARY KEY ("tenantId"),
  CONSTRAINT "TenantQuota_tenantId_fkey" FOREIGN KEY ("tenantId")
    REFERENCES "Tenant"("id") ON DELETE CASCADE ON UPDATE CASCADE
);

-- Workstream C — link AVA master-data companies to their CRM-side
-- counterparts. Two tables + two enums.
--
-- CompanyCrmLink — confirmed bindings. Last-write-wins on
-- (tenantId, companyId, crmType): re-importing or re-confirming a
-- company under the same CRM replaces the external id + display name.
-- The chat agent's company_crm_summary tool joins via this table.
--
-- CompanyCrmCache — opportunistic JSON cache for the enriched
-- payload pulled from the CRM (contacts, deals, notes). TTL is
-- enforced in the read path (default 6h); refresh=true forces a fresh
-- fetch. Single row per (tenantId, companyId, crmType); last value
-- wins on conflict.

CREATE TYPE "CrmType" AS ENUM ('HUBSPOT', 'SALESFORCE', 'DYNAMICS');

CREATE TYPE "ConfirmedSource" AS ENUM (
  'EXACT_MATCH',
  'USER_CONFIRMED',
  'MANUAL_LINK',
  'SINGLE_IMPORT'
);

CREATE TABLE "CompanyCrmLink" (
  "id" TEXT PRIMARY KEY,
  "tenantId" TEXT NOT NULL,
  "companyId" TEXT NOT NULL,
  "crmType" "CrmType" NOT NULL,
  "crmExternalId" TEXT NOT NULL,
  "crmDisplayName" TEXT,
  "confirmedAt" TIMESTAMP(3) NOT NULL DEFAULT NOW(),
  "confirmedSource" "ConfirmedSource" NOT NULL,
  "lastSyncedAt" TIMESTAMP(3),
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT NOW(),
  "updatedAt" TIMESTAMP(3) NOT NULL DEFAULT NOW()
);

CREATE UNIQUE INDEX "CompanyCrmLink_tenant_company_crm_unique"
  ON "CompanyCrmLink" ("tenantId", "companyId", "crmType");

CREATE INDEX "CompanyCrmLink_tenant_crm_external"
  ON "CompanyCrmLink" ("tenantId", "crmType", "crmExternalId");

CREATE TABLE "CompanyCrmCache" (
  "id" TEXT PRIMARY KEY,
  "tenantId" TEXT NOT NULL,
  "companyId" TEXT NOT NULL,
  "crmType" "CrmType" NOT NULL,
  "payload" JSONB NOT NULL,
  "fetchedAt" TIMESTAMP(3) NOT NULL DEFAULT NOW()
);

CREATE UNIQUE INDEX "CompanyCrmCache_tenant_company_crm_unique"
  ON "CompanyCrmCache" ("tenantId", "companyId", "crmType");

CREATE INDEX "CompanyCrmCache_fetchedAt"
  ON "CompanyCrmCache" ("fetchedAt");

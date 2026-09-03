-- T4 (docs/PLAN_TENANT_MULTI_ACCOUNT.md) — Tenant + TenantMember.
--
-- Bisher: Tenant = User (Auth-Middleware faellt ohne Claim auf `sub`
-- zurueck). Alle tenant-gebundenen Tabellen sind deshalb mit der
-- User-UUID geschluesselt. Diese Migration macht daraus echte Tenants
-- MIT DERSELBEN ID — keine Umschluesselung, keine Datenaenderung.

CREATE TABLE "Tenant" (
  "id"        TEXT NOT NULL,
  "name"      TEXT,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "Tenant_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "TenantMember" (
  "tenantId" TEXT NOT NULL,
  "actorId"  TEXT NOT NULL,
  "role"     TEXT NOT NULL DEFAULT 'member',
  "joinedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "TenantMember_pkey" PRIMARY KEY ("tenantId", "actorId"),
  CONSTRAINT "TenantMember_tenantId_fkey" FOREIGN KEY ("tenantId")
    REFERENCES "Tenant"("id") ON DELETE CASCADE ON UPDATE CASCADE
);
CREATE UNIQUE INDEX "TenantMember_actorId_key" ON "TenantMember"("actorId");
CREATE INDEX "TenantMember_tenantId_idx" ON "TenantMember"("tenantId");

-- Kompatibilitaet: jede heute bekannte tenantId wird ein Tenant …
INSERT INTO "Tenant" ("id")
SELECT DISTINCT t."tenantId" FROM (
  SELECT "tenantId" FROM "TenantBilling"
  UNION SELECT "tenantId" FROM "UsageEntry"
  UNION SELECT "tenantId" FROM "ParkedCompany"
  UNION SELECT "tenantId" FROM "CompanyCrmLink"
  UNION SELECT "tenantId" FROM "ProxyQuotaOverride"
  UNION SELECT "tenantId" FROM "AuditLog"
) t
WHERE t."tenantId" IS NOT NULL AND t."tenantId" <> ''
ON CONFLICT ("id") DO NOTHING;

-- … und der gleichnamige User (Tenant = sub) sein Owner.
INSERT INTO "TenantMember" ("tenantId", "actorId", "role")
SELECT "id", "id", 'owner' FROM "Tenant"
ON CONFLICT DO NOTHING;

-- O1 (docs/PLAN_ORGANISATIONEN.md) — Organisationen: Tenant-Art,
-- Einladungs-Token, Beitrittsanfragen, Vorgaben.
-- Bestehende Tenants sind persoenlich (Tenant = User) — Default "personal".

ALTER TABLE "Tenant" ADD COLUMN "kind" TEXT NOT NULL DEFAULT 'personal';
ALTER TABLE "Tenant" ADD COLUMN "inviteToken" TEXT;
CREATE UNIQUE INDEX "Tenant_inviteToken_key" ON "Tenant"("inviteToken");

CREATE TABLE "TenantJoinRequest" (
  "id"          TEXT NOT NULL,
  "tenantId"    TEXT NOT NULL,
  "actorId"     TEXT NOT NULL,
  "email"       TEXT,
  "name"        TEXT,
  "status"      TEXT NOT NULL DEFAULT 'open',
  "requestedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "decidedAt"   TIMESTAMP(3),
  "decidedBy"   TEXT,
  CONSTRAINT "TenantJoinRequest_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "TenantJoinRequest_tenantId_fkey" FOREIGN KEY ("tenantId")
    REFERENCES "Tenant"("id") ON DELETE CASCADE ON UPDATE CASCADE
);
CREATE INDEX "TenantJoinRequest_tenantId_status_idx" ON "TenantJoinRequest"("tenantId", "status");
CREATE INDEX "TenantJoinRequest_actorId_status_idx" ON "TenantJoinRequest"("actorId", "status");

CREATE TABLE "TenantPolicy" (
  "tenantId"      TEXT NOT NULL,
  "features"      JSONB NOT NULL DEFAULT '{}',
  "providerLock"  BOOLEAN NOT NULL DEFAULT false,
  "chatModel"     TEXT,
  "producerModel" TEXT,
  "promptAudit"   BOOLEAN NOT NULL DEFAULT false,
  "updatedAt"     TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedBy"     TEXT,
  CONSTRAINT "TenantPolicy_pkey" PRIMARY KEY ("tenantId"),
  CONSTRAINT "TenantPolicy_tenantId_fkey" FOREIGN KEY ("tenantId")
    REFERENCES "Tenant"("id") ON DELETE CASCADE ON UPDATE CASCADE
);

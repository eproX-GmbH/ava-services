-- W7 (2026-09-09) — Mit der Organisation geteilte Workflows (Kopien der
-- lokalen Definitionen; Mitglieder uebernehmen sie in ihren Bestand).
CREATE TABLE IF NOT EXISTS "TenantWorkflow" (
  "id" TEXT PRIMARY KEY,
  "tenantId" TEXT NOT NULL REFERENCES "Tenant"("id") ON DELETE CASCADE,
  "sourceId" TEXT NOT NULL,
  "name" TEXT NOT NULL,
  "description" TEXT NOT NULL DEFAULT '',
  "definition" JSONB NOT NULL,
  "version" INTEGER NOT NULL DEFAULT 1,
  "sharedBy" TEXT NOT NULL,
  "sharedAt" TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  "updatedAt" TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  "revokedAt" TIMESTAMPTZ
);
CREATE UNIQUE INDEX IF NOT EXISTS "TenantWorkflow_tenant_source" ON "TenantWorkflow"("tenantId", "sourceId");
CREATE INDEX IF NOT EXISTS "TenantWorkflow_tenant_shared" ON "TenantWorkflow"("tenantId", "sharedAt");

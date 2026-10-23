-- C1/C2 (docs/PLAN_COPILOT_MCP.md): Anmeldung mit Microsoft-Konto je Organisation
-- (Geheimnis nur in Keycloak) und Gespraechsprotokolle/Hinweise je Firma.
CREATE TABLE IF NOT EXISTS "TenantSso" (
  "tenantId"        TEXT PRIMARY KEY,
  "anbieter"        TEXT NOT NULL DEFAULT 'entra',
  "entraTenantId"   TEXT NOT NULL,
  "clientId"        TEXT NOT NULL,
  "idpAlias"        TEXT NOT NULL,
  "aktiv"           BOOLEAN NOT NULL DEFAULT TRUE,
  "zuletztGeprueft" TIMESTAMP(3),
  "fehler"          TEXT,
  "erstelltVon"     TEXT NOT NULL,
  "createdAt"       TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt"       TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP
);
CREATE INDEX IF NOT EXISTS "TenantSso_entraTenantId_idx" ON "TenantSso" ("entraTenantId");

CREATE TABLE IF NOT EXISTS "CompanyNotiz" (
  "id"        TEXT PRIMARY KEY,
  "tenantId"  TEXT NOT NULL,
  "actorId"   TEXT NOT NULL,
  "companyId" TEXT NOT NULL,
  "personId"  TEXT,
  "text"      TEXT NOT NULL,
  "quelle"    TEXT NOT NULL,
  "datum"     TIMESTAMP(3),
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP
);
CREATE INDEX IF NOT EXISTS "CompanyNotiz_tenant_company_idx" ON "CompanyNotiz" ("tenantId", "companyId", "createdAt");

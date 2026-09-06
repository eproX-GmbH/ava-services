-- C1 (docs/PLAN_COMPLIANCE_ENTERPRISE.md) — Aufbewahrung je Tenant.
ALTER TABLE "TenantPolicy" ADD COLUMN "personRetentionDays" INTEGER;

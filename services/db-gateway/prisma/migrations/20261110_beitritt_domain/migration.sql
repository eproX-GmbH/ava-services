-- Onboarding O11 (docs/PLAN_ONBOARDING.md): automatische Zuordnung zur Organisation
-- der eigenen Firma ueber die E-Mail-Domain. Admins koennen es je Organisation abschalten.
ALTER TABLE "Tenant" ADD COLUMN IF NOT EXISTS "domainBeitritt" BOOLEAN NOT NULL DEFAULT TRUE;
-- Herkunft einer Beitrittsanfrage: 'link' (Einladungslink) oder 'domain' (automatisch/Vorschlag).
ALTER TABLE "TenantJoinRequest" ADD COLUMN IF NOT EXISTS "quelle" TEXT;

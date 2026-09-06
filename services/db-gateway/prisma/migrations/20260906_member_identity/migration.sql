-- Mitglieder-Anzeige: E-Mail und Name aus dem Token an der Mitgliedschaft
-- speichern (bisher nur aus der Beitrittsanfrage → Owner erschien als ID).
ALTER TABLE "TenantMember" ADD COLUMN IF NOT EXISTS "email" TEXT;
ALTER TABLE "TenantMember" ADD COLUMN IF NOT EXISTS "name" TEXT;

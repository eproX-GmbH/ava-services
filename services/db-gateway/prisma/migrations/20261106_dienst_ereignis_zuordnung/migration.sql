-- docs/PLAN_CLOSE_MCP.md C4 — Ereignis fremder Dienste einer Person und Firma des Bestands zuordnen (ueber die LinkedIn-Adresse).
ALTER TABLE "DienstEreignis" ADD COLUMN IF NOT EXISTS "personId" TEXT;
ALTER TABLE "DienstEreignis" ADD COLUMN IF NOT EXISTS "companyId" TEXT;
ALTER TABLE "DienstEreignis" ADD COLUMN IF NOT EXISTS "linkedinSlug" TEXT;

-- Organisationsvorgabe: Deep-Research-Modell (OpenAI, Responses-API).
ALTER TABLE "TenantPolicy" ADD COLUMN IF NOT EXISTS "researchModel" TEXT;

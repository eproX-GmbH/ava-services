-- Azure OpenAI als Organisationsschluessel (desktop/src/shared/azure-openai.ts):
-- Endpunkt der Azure-Ressource und Zuordnung Katalog-Modell → Deployment.
-- Nur fuer kind 'openai' belegt; NULL = OpenAI direkt (bisheriges Verhalten).
ALTER TABLE "TenantProvider" ADD COLUMN IF NOT EXISTS "endpoint" TEXT;
ALTER TABLE "TenantProvider" ADD COLUMN IF NOT EXISTS "deployments" JSONB;

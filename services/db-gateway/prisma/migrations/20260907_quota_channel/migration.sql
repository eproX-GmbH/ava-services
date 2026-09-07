-- O6b (2026-09-07) — Getrennte Limits fuer Chat und Hintergrund-Verarbeitung.
-- Jeder Stellvertreter-Aufruf traegt einen Kanal (Header x-ava-llm-channel:
-- chat | background; fehlt er, gilt background — aeltere Desktop-Versionen
-- und alle Producer senden ihn nicht). Bei split=true zaehlt der Chat gegen
-- chat*Cents, der Hintergrund gegen die bisherigen Felder.
ALTER TABLE "LlmUsage" ADD COLUMN "channel" TEXT NOT NULL DEFAULT 'background';
CREATE INDEX "LlmUsage_tenantId_channel_createdAt_idx" ON "LlmUsage"("tenantId", "channel", "createdAt");

ALTER TABLE "TenantQuota" ADD COLUMN "split" BOOLEAN NOT NULL DEFAULT false;
ALTER TABLE "TenantQuota" ADD COLUMN "chatOrgMonthlyCents" INTEGER;
ALTER TABLE "TenantQuota" ADD COLUMN "chatUserDailyCents" INTEGER;

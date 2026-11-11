-- Betreiber-Konsole „Aktive Nutzer“ (2026-11-11): Nutzung durch einen Menschen
-- (Chat, MCP, App, Handlung in der App) getrennt von reiner Hintergrundarbeit.
ALTER TABLE "NutzerAktivitaet" ADD COLUMN IF NOT EXISTS "genutztAt" TIMESTAMPTZ;
ALTER TABLE "NutzerAktivitaet" ADD COLUMN IF NOT EXISTS "genutztArt" TEXT;
ALTER TABLE "NutzerAktivitaet" ADD COLUMN IF NOT EXISTS "nutzungMinuten" INTEGER NOT NULL DEFAULT 0;
CREATE INDEX IF NOT EXISTS "NutzerAktivitaet_genutzt_idx" ON "NutzerAktivitaet" ("genutztAt" DESC);
-- Sperre durch das AVA-Team: KontoStatus.art = 'gesperrt' (aufhebbar), "von" = wer gesperrt hat.
ALTER TABLE "KontoStatus" ADD COLUMN IF NOT EXISTS "von" TEXT;

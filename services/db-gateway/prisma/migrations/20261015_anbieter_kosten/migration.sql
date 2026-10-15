-- Tatsaechliche Anbieterkosten (OpenAI Admin-API, Apify je Lauf und Konto, Valueserp
-- Konto) statt Annahmen. Valueserp: je Abfrage der geltende Tarif und Preis;
-- Apify: Lauf-Kennung je Aufruf, echte Kosten in costMicroUsd.
ALTER TABLE "ProxyAudit" ADD COLUMN IF NOT EXISTS "tarif" TEXT;
ALTER TABLE "ProxyAudit" ADD COLUMN IF NOT EXISTS "kostenMicroUsd" INTEGER;
ALTER TABLE "LlmUsage" ADD COLUMN IF NOT EXISTS "ref" TEXT;
CREATE TABLE IF NOT EXISTS "AnbieterKosten" (
  "id" BIGSERIAL PRIMARY KEY,
  "quelle" TEXT NOT NULL,
  "tag" DATE NOT NULL,
  "kennung" TEXT NOT NULL,
  "betragMicroUsd" BIGINT NOT NULL DEFAULT 0,
  "menge" BIGINT NOT NULL DEFAULT 0,
  "details" JSONB,
  "abgerufenAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "AnbieterKosten_quelle_tag_kennung_key" UNIQUE ("quelle", "tag", "kennung")
);

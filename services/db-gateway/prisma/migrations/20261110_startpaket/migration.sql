-- Onboarding O4 (docs/PLAN_ONBOARDING.md): Startpaket. Die bis zu 10 Firmen des
-- Start-Workflows zaehlen nicht aufs Kontingent (Free: 25 lebenslang; bezahlt:
-- Monat der Aufnahme). Einmal je Abrechnungskonto. recordUsage bucht sie unter
-- periodKey 'startpaket', den keine Kontingent- oder Rechnungsabfrage zaehlt.
CREATE TABLE IF NOT EXISTS "StartpaketFirma" (
  "billingAccountId" TEXT NOT NULL,
  "companyId"        TEXT NOT NULL,
  "transactionId"    TEXT NOT NULL,
  "createdAt"        TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  PRIMARY KEY ("billingAccountId", "companyId")
);

-- Organisationen werden nie hart geloescht (Firmen, Kontakte, Vorgaben bleiben).
-- Verlaesst das letzte Mitglied eine Organisation, wird sie als geloescht markiert
-- und ihr Einladungslink entwertet.
ALTER TABLE "Tenant" ADD COLUMN IF NOT EXISTS "deletedAt" TIMESTAMP(3);
-- Enterprise-Vertrag: ausgehandelter Fixpreis je Monat (Cent, netto), vom Betreiber gesetzt.
ALTER TABLE "TenantBilling" ADD COLUMN IF NOT EXISTS "enterprisePreisCents" INTEGER;

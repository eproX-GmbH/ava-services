-- Betreiber-Monatslimit fuer die Hintergrundverarbeitung (Cent, zu Stufenpreisen
-- gerechnet), vom Betreiber je Abrechnungskonto gesetzt. Gedacht fuer Enterprise-
-- Vertraege mit Fixpreis; NULL = kein Limit.
ALTER TABLE "TenantBilling" ADD COLUMN IF NOT EXISTS "betreiberLimitCents" INTEGER;

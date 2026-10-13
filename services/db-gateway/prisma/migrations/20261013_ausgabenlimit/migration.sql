-- docs/PLAN_ABRECHNUNG_ZUGANG.md (Z7): Ein bezahlter Plan (Pro) mit Pay-as-you-go je
-- Aufnahme; der Kunde setzt sich ein monatliches Ausgabenlimit in Cent (NULL = keins).
ALTER TABLE "TenantBilling" ADD COLUMN IF NOT EXISTS "ausgabenLimitCents" INTEGER;

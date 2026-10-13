-- docs/PLAN_ABRECHNUNG_ZUGANG.md (Z3): Stufe je aufgenommener Firma nach dem Lauf
-- (klein | mittel | gross) mit Preis und geschaetzten Direktkosten in Cent.
ALTER TABLE "UsageEntry" ADD COLUMN IF NOT EXISTS "stufe" TEXT;
ALTER TABLE "UsageEntry" ADD COLUMN IF NOT EXISTS "preisCents" INTEGER;
ALTER TABLE "UsageEntry" ADD COLUMN IF NOT EXISTS "direktkostenCents" INTEGER;
ALTER TABLE "UsageEntry" ADD COLUMN IF NOT EXISTS "grund" TEXT;
ALTER TABLE "UsageEntry" ADD COLUMN IF NOT EXISTS "zugeordnetAm" TIMESTAMPTZ;

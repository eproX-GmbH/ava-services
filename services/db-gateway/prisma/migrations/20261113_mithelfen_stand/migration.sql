-- Burggraben-Punkt 4 (docs/PLAN_BURGGRABEN.md 5.3): Mithelfen als Standard bei bezahlten
-- Sitzen. Der Desktop meldet seine Einstellung (an/aus, Standard oder Nutzerentscheidung),
-- damit der Betreiber die Opt-out-Quote sieht. Additiv, keine Datenaenderung.
ALTER TABLE "RegisterWorker" ADD COLUMN IF NOT EXISTS "einstellungAktiv" BOOLEAN;
ALTER TABLE "RegisterWorker" ADD COLUMN IF NOT EXISTS "einstellungQuelle" TEXT;
ALTER TABLE "RegisterWorker" ADD COLUMN IF NOT EXISTS "einstellungAt" TIMESTAMPTZ;

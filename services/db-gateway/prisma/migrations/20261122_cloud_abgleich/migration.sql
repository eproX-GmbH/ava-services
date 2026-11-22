-- AVA Cloud Z2 (docs/PLAN_CLOUD_SELBSTBEDIENUNG.md §3.4): Wunsch (Admin/Betreiber) getrennt vom
-- Soll (Wunsch UND Zahlung UND Konto in Ordnung), das der Abgleicher ermittelt; letzter erfolgreicher
-- Health-Check. Additiv.
ALTER TABLE "CloudInstanz" ADD COLUMN IF NOT EXISTS "gewuenscht" TEXT NOT NULL DEFAULT 'laufen';
ALTER TABLE "CloudInstanz" ADD COLUMN IF NOT EXISTS "gesundAt" TIMESTAMPTZ;

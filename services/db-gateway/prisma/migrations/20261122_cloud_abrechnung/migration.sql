-- AVA Cloud Z3 (docs/PLAN_CLOUD_SELBSTBEDIENUNG.md §3.7/§10.5): Abbestellen zum Zyklusende.
-- Neuer Zustand "zahlung_offen" (TEXT, keine Schemaänderung). Additiv.
ALTER TABLE "CloudInstanz" ADD COLUMN IF NOT EXISTS "abbestelltZum" TIMESTAMPTZ;

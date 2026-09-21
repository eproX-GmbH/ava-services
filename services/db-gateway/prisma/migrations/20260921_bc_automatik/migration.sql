-- Buying Center: Auto-Modus (2026-09-21). Ist er an, werden offene
-- AVA-Vorschlaege sofort uebernommen statt in der Seitenleiste zu warten.
-- Opt-in je Buying Center, nur der Eigentuemer schaltet.
ALTER TABLE "BuyingCenter" ADD COLUMN IF NOT EXISTS "automatik" BOOLEAN NOT NULL DEFAULT FALSE;

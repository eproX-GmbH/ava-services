-- Buying Center, BC5 (docs/PLAN_BUYING_CENTER.md, Abschnitt 9): Ein Buying
-- Center veraltet nicht leise. Einmal im Monat fragt AVA nach, ob es noch
-- stimmt; wann zuletzt gefragt wurde, steht hier — sonst fragt jeder
-- Heartbeat-Durchgang erneut.
ALTER TABLE "BuyingCenter" ADD COLUMN IF NOT EXISTS "nachgefragtAt" TIMESTAMP(3);

-- Vorgangsnamen der Nutzer (bisher Datei /app/.gateway-data, im Container schreibgeschuetzt).
CREATE TABLE IF NOT EXISTS "TransaktionsName" (
  "transactionId" TEXT PRIMARY KEY,
  "name"          TEXT NOT NULL,
  "updatedAt"     TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

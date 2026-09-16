-- Firmen-Verflechtungen: manueller Start hebt die 30-Tage-Sperre fuer die
-- Gesellschafterliste auf (wie bei allen Producern). Gesetzt vom manuellen
-- Retry der Registerstufe und vom "Tiefer verfolgen"; der Producer fragt
-- /v1/verflechtungen/faellig ab und verbraucht den Eintrag.
CREATE TABLE IF NOT EXISTS "VerflechtungErzwungen" (
  "companyId" TEXT PRIMARY KEY,
  "bis" TIMESTAMPTZ NOT NULL
);

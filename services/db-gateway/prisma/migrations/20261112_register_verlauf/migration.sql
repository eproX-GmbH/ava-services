-- Burggraben 1 (docs/PLAN_BURGGRABEN.md): Register-Verlauf. Vor jedem Ueberschreiben
-- eines Registerstands (StructuredContent + Geschaeftsfuehrung) bleibt der ALTE Stand
-- vollstaendig als Zeile liegen, sobald sich irgendein Feld geaendert hat. Nie loeschen.
CREATE TABLE IF NOT EXISTS "RegisterSnapshot" (
  "id"         BIGSERIAL PRIMARY KEY,
  "companyId"  TEXT NOT NULL,
  "quelle"     TEXT NOT NULL,
  "stand"      JSONB NOT NULL,
  "felder"     TEXT[] NOT NULL DEFAULT '{}',
  "bestandVon" TIMESTAMPTZ,
  "ersetztAm"  TIMESTAMPTZ NOT NULL,
  "runId"      TEXT,
  "createdAt"  TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS "RegisterSnapshot_company_idx" ON "RegisterSnapshot" ("companyId", "ersetztAm" DESC);

-- Burggraben 3: Neuigkeiten-Mail vom Server, wenn die AVA des Nutzers nicht laeuft.
-- appZuletztAt = letzte Anfrage der Desktop-/Server-AVA (nicht Browser, nicht MCP).
ALTER TABLE "NutzerAktivitaet" ADD COLUMN IF NOT EXISTS "appZuletztAt" TIMESTAMPTZ;

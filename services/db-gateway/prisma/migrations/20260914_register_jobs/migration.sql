-- Register-Delta S3 (docs/PLAN_STAMMDATEN_DELTA.md, Abschnitt 3.4) — Job-Queue
-- mit Lease. Worker (Desktop "Mithelfen", Betreiber-Fallback) holen Jobs per
-- SKIP LOCKED, melden Ergebnisse; das Gateway schreibt ueber master-data.
CREATE TABLE IF NOT EXISTS "RegisterJob" (
  "id" BIGSERIAL PRIMARY KEY,
  "art" TEXT NOT NULL,                       -- front | bekanntmachungen | refresh
  "schluessel" TEXT NOT NULL UNIQUE,         -- Idempotenz des Erstellers
  "payload" JSONB NOT NULL DEFAULT '{}'::jsonb,
  "status" TEXT NOT NULL DEFAULT 'offen',    -- offen | laeuft | erledigt | fehlgeschlagen
  "prioritaet" INTEGER NOT NULL DEFAULT 5,   -- klein = zuerst
  "leaseUntil" TIMESTAMPTZ,
  "leasedBy" TEXT,
  "versuche" INTEGER NOT NULL DEFAULT 0,
  "ergebnis" JSONB,
  "ergebnisAt" TIMESTAMPTZ,
  "fehler" TEXT,
  "createdAt" TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  "updatedAt" TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS "RegisterJob_offen" ON "RegisterJob"("status", "prioritaet", "id");
CREATE INDEX IF NOT EXISTS "RegisterJob_lease" ON "RegisterJob"("leaseUntil") WHERE "status" = 'laeuft';

-- Wer hat wann wie viele Abfragen geleistet (Systemseite, Metriken S5/S6).
CREATE TABLE IF NOT EXISTS "RegisterWorker" (
  "workerId" TEXT PRIMARY KEY,
  "tenantId" TEXT,
  "actorId" TEXT,
  "art" TEXT NOT NULL DEFAULT 'desktop',     -- desktop | betreiber
  "zuletztAt" TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  "jobsErledigt" INTEGER NOT NULL DEFAULT 0,
  "abfragen" INTEGER NOT NULL DEFAULT 0,
  "gesperrtAt" TIMESTAMPTZ
);

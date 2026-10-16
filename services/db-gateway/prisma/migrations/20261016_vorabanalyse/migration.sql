-- Vorabanalyse (docs/PLAN_VORABANALYSE.md): Betreiber-Werkzeug, CRM-Listen von
-- Interessenten gegen Stammdaten, Website, Miniprofil und ICP pruefen. Eigenstaendig,
-- keine Verbindung zu Transaktionen oder Bestand.
CREATE TABLE IF NOT EXISTS "VorabLauf" (
  "id" TEXT PRIMARY KEY,
  "kundeName" TEXT NOT NULL,
  "erstelltVon" TEXT NOT NULL,
  "status" TEXT NOT NULL DEFAULT 'neu',
  "icp" JSONB,
  "einstellungen" JSONB NOT NULL DEFAULT '{}'::jsonb,
  "zaehler" JSONB NOT NULL DEFAULT '{}'::jsonb,
  "spalten" JSONB,
  "dateiName" TEXT,
  "notiz" TEXT,
  "gestartetAt" TIMESTAMP(3),
  "beendetAt" TIMESTAMP(3),
  "deletedAt" TIMESTAMP(3),
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP
);
CREATE TABLE IF NOT EXISTS "VorabFirma" (
  "id" BIGSERIAL PRIMARY KEY,
  "laufId" TEXT NOT NULL REFERENCES "VorabLauf"("id") ON DELETE CASCADE,
  "zeile" INTEGER NOT NULL,
  "name" TEXT NOT NULL,
  "ort" TEXT,
  "plz" TEXT,
  "strasse" TEXT,
  "land" TEXT,
  "eingabe" JSONB,
  "duplikatVon" BIGINT,
  "abgleich" TEXT,
  "kandidaten" JSONB,
  "companyId" TEXT,
  "zuordnung" TEXT NOT NULL DEFAULT 'offen',
  "website" TEXT,
  "websiteKandidaten" JSONB,
  "websiteUrteil" JSONB,
  "profil" JSONB,
  "icpUrteil" JSONB,
  "schritt" TEXT NOT NULL DEFAULT 'eingelesen',
  "fehler" TEXT,
  "versuche" INTEGER NOT NULL DEFAULT 0,
  "gesperrtBis" TIMESTAMP(3),
  "updatedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP
);
CREATE INDEX IF NOT EXISTS "VorabFirma_lauf_schritt_idx" ON "VorabFirma" ("laufId", "schritt");
CREATE INDEX IF NOT EXISTS "VorabFirma_lauf_zeile_idx" ON "VorabFirma" ("laufId", "zeile");
CREATE TABLE IF NOT EXISTS "VorabEreignis" (
  "id" BIGSERIAL PRIMARY KEY,
  "laufId" TEXT NOT NULL REFERENCES "VorabLauf"("id") ON DELETE CASCADE,
  "zeit" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "schritt" TEXT NOT NULL,
  "art" TEXT NOT NULL,
  "text" TEXT NOT NULL,
  "daten" JSONB
);
CREATE INDEX IF NOT EXISTS "VorabEreignis_lauf_zeit_idx" ON "VorabEreignis" ("laufId", "zeit");
-- Valueserp-Aufrufe eines Laufs kennzeichnen (Kosten je Lauf).
ALTER TABLE "ProxyAudit" ADD COLUMN IF NOT EXISTS "ref" TEXT;

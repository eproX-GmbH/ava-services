-- Onboarding O1/O2 (docs/PLAN_ONBOARDING.md): Start-Analyse beim Registrieren.
-- StartAnalyse = Ergebnis je Domain (oeffentliche Website-Daten, Zwischenspeicher fuer Kollegen derselben Firma).
-- StartAuftrag = genau ein Auftrag je Nutzer; abgeholtAt sperrt die einmalige Uebernahme in die App.
CREATE TABLE IF NOT EXISTS "StartAnalyse" (
  "domain"    TEXT PRIMARY KEY,
  "ergebnis"  JSONB NOT NULL,
  "createdAt" TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS "StartAuftrag" (
  "actorId"            TEXT PRIMARY KEY,
  "domain"             TEXT,
  "website"            TEXT,
  "status"             TEXT NOT NULL DEFAULT 'offen',
  "versuch"            INTEGER NOT NULL DEFAULT 0,
  "naechsterVersuchAt" TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  "letzterFehler"      TEXT,
  "vorschlag"          JSONB,
  "abgeholtAt"         TIMESTAMPTZ,
  "abgeholtVon"        TEXT,
  "abholArt"           TEXT,
  "fertigAt"           TIMESTAMPTZ,
  "createdAt"          TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  "updatedAt"          TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS "StartAuftrag_faellig_idx" ON "StartAuftrag" ("status", "naechsterVersuchAt");

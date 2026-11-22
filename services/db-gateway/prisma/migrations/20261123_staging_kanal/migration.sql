-- Staging/UAT (docs/PLAN_STAGING.md ST1): Kanal je Konto, Test-Adressen, Release-Kandidaten,
-- Weichen-Schalter und Zahlungsmodus je Organisation. Nur neue, kleine Tabellen und eine Spalte
-- mit festem Standardwert (Postgres ändert dafür nur Metadaten, kein Umschreiben der Tabelle).
CREATE TABLE IF NOT EXISTS "KanalZugang" (
  "actorId"     TEXT PRIMARY KEY,
  "kanal"       TEXT NOT NULL DEFAULT 'staging',
  "testZahlung" BOOLEAN NOT NULL DEFAULT false,
  "email"       TEXT,
  "notiz"       TEXT,
  "von"         TEXT,
  "createdAt"   TIMESTAMPTZ NOT NULL DEFAULT now(),
  "updatedAt"   TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS "TestAdressMuster" (
  "muster"    TEXT PRIMARY KEY,
  "notiz"     TEXT,
  "von"       TEXT,
  "createdAt" TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS "AvaRelease" (
  "version"        TEXT PRIMARY KEY,
  "status"         TEXT NOT NULL DEFAULT 'kandidat',
  "commit"         TEXT,
  "komponenten"    JSONB NOT NULL DEFAULT '{}'::jsonb,
  "notiz"          TEXT,
  "von"            TEXT,
  "freigegebenAt"  TIMESTAMPTZ,
  "createdAt"      TIMESTAMPTZ NOT NULL DEFAULT now(),
  "updatedAt"      TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS "StagingSchalter" (
  "id"         INTEGER PRIMARY KEY DEFAULT 1,
  "routing"    BOOLEAN NOT NULL DEFAULT false,
  "von"        TEXT,
  "updatedAt"  TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT "StagingSchalter_einzeilig" CHECK ("id" = 1)
);
INSERT INTO "StagingSchalter" ("id", "routing") VALUES (1, false) ON CONFLICT ("id") DO NOTHING;

-- Bisheriger Stand gilt als freigegeben (alles bis einschließlich dieser Version ist Prod).
INSERT INTO "AvaRelease" ("version", "status", "freigegebenAt", "von", "notiz")
VALUES ('0.1.976', 'freigegeben', now(), 'migration', 'Stand beim Einführen von Staging')
ON CONFLICT ("version") DO NOTHING;

ALTER TABLE "TenantBilling" ADD COLUMN IF NOT EXISTS "stripeModus" TEXT NOT NULL DEFAULT 'live';

-- AVA Cloud in Selbstbedienung, Z1 (docs/PLAN_CLOUD_SELBSTBEDIENUNG.md §5): eine Instanz je
-- Mitglied in der Fly-Org der Kunden-Instanzen, mit Soll-Zustand und Ereignisprotokoll.
-- Neue, kleine Tabellen; keine Datenänderung an bestehenden.
CREATE TABLE IF NOT EXISTS "CloudInstanz" (
  "id"            TEXT PRIMARY KEY,
  "tenantId"      TEXT NOT NULL,
  "actorId"       TEXT NOT NULL,
  "flyApp"        TEXT NOT NULL UNIQUE,
  "region"        TEXT NOT NULL DEFAULT 'fra',
  "groesse"       TEXT NOT NULL DEFAULT 'standard',
  "zustand"       TEXT NOT NULL,
  "soll"          TEXT NOT NULL,
  "grund"         TEXT,
  "imageVersion"  TEXT,
  "maschineId"    TEXT,
  "volumeId"      TEXT,
  "schritte"      JSONB NOT NULL DEFAULT '{}'::jsonb,
  "letzterFehler" TEXT,
  "bootstrapHash" TEXT,
  "verbundenAt"   TIMESTAMPTZ,
  "bezahltBis"    TIMESTAMPTZ,
  "gestopptAt"    TIMESTAMPTZ,
  "loeschenAb"    TIMESTAMPTZ,
  "geloeschtAt"   TIMESTAMPTZ,
  "createdAt"     TIMESTAMPTZ NOT NULL DEFAULT now(),
  "updatedAt"     TIMESTAMPTZ NOT NULL DEFAULT now()
);
-- Höchstens eine nicht gelöschte Instanz je Mitglied.
CREATE UNIQUE INDEX IF NOT EXISTS "CloudInstanz_mitglied_aktiv" ON "CloudInstanz" ("tenantId", "actorId") WHERE "geloeschtAt" IS NULL;
CREATE INDEX IF NOT EXISTS "CloudInstanz_tenant_idx" ON "CloudInstanz" ("tenantId");

CREATE TABLE IF NOT EXISTS "CloudEreignis" (
  "id"        TEXT PRIMARY KEY,
  "instanzId" TEXT NOT NULL,
  "art"       TEXT NOT NULL,
  "quelle"    TEXT NOT NULL,
  "details"   JSONB,
  "createdAt" TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS "CloudEreignis_instanz_idx" ON "CloudEreignis" ("instanzId", "createdAt" DESC);

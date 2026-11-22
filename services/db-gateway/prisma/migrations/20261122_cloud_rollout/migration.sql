-- AVA Cloud Z7 (docs/PLAN_CLOUD_SELBSTBEDIENUNG.md §10.6): Updates der Kunden-Instanzen in Wellen.
-- Eine Zeile je Server-Version: Phase (betreiber → welle → alle → fertig | angehalten),
-- Zähler und der Hinweis für Mail M6. Neue, kleine Tabelle; keine Änderung an bestehenden.
CREATE TABLE IF NOT EXISTS "CloudRollout" (
  "version"   TEXT PRIMARY KEY,
  "phase"     TEXT NOT NULL,
  "phaseAt"   TIMESTAMPTZ NOT NULL DEFAULT now(),
  "erfolge"   INTEGER NOT NULL DEFAULT 0,
  "fehler"    INTEGER NOT NULL DEFAULT 0,
  "hinweis"   TEXT,
  "grund"     TEXT,
  "createdAt" TIMESTAMPTZ NOT NULL DEFAULT now(),
  "updatedAt" TIMESTAMPTZ NOT NULL DEFAULT now()
);

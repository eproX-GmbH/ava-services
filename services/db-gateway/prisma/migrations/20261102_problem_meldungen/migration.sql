-- docs/PLAN_PROBLEM_MELDEN.md M1 — Problemmeldungen der Nutzer mit Anhaengen (bytea) und Verlauf.
CREATE SEQUENCE IF NOT EXISTS "ProblemMeldung_nr_seq";
CREATE TABLE IF NOT EXISTS "ProblemMeldung" (
  "id"                       TEXT PRIMARY KEY,
  "kennung"                  TEXT NOT NULL UNIQUE,
  "tenantId"                 TEXT NOT NULL,
  "actorId"                  TEXT NOT NULL,
  "actorName"                TEXT,
  "actorEmail"               TEXT,
  "kategorie"                TEXT NOT NULL,
  "titel"                    TEXT NOT NULL,
  "beschreibung"             TEXT NOT NULL,
  "quelle"                   TEXT NOT NULL DEFAULT 'dialog',
  "status"                   TEXT NOT NULL DEFAULT 'neu',
  "prioritaet"               TEXT NOT NULL DEFAULT 'normal',
  "zugewiesenAn"             TEXT,
  "appVersion"               TEXT,
  "plattform"                TEXT,
  "conversationId"           TEXT,
  "companyId"                TEXT,
  "ungelesenNutzer"          BOOLEAN NOT NULL DEFAULT FALSE,
  "ungelesenBetreiber"       BOOLEAN NOT NULL DEFAULT TRUE,
  "letzteNutzerAntwortAt"    TIMESTAMPTZ,
  "letzteBetreiberAntwortAt" TIMESTAMPTZ,
  "geloestAt"                TIMESTAMPTZ,
  "geschlossenAt"            TIMESTAMPTZ,
  "createdAt"                TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  "updatedAt"                TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS "ProblemMeldung_status_idx" ON "ProblemMeldung" ("status", "updatedAt");
CREATE INDEX IF NOT EXISTS "ProblemMeldung_actor_idx" ON "ProblemMeldung" ("actorId", "updatedAt");
CREATE INDEX IF NOT EXISTS "ProblemMeldung_tenant_idx" ON "ProblemMeldung" ("tenantId");

CREATE TABLE IF NOT EXISTS "ProblemAnhang" (
  "id"         TEXT PRIMARY KEY,
  "meldungId"  TEXT NOT NULL REFERENCES "ProblemMeldung"("id") ON DELETE CASCADE,
  "art"        TEXT NOT NULL,
  "dateiname"  TEXT NOT NULL,
  "mime"       TEXT NOT NULL,
  "groesse"    INTEGER NOT NULL,
  "sha256"     TEXT,
  "inhalt"     BYTEA,
  "geloeschtAt" TIMESTAMPTZ,
  "createdAt"  TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS "ProblemAnhang_meldung_idx" ON "ProblemAnhang" ("meldungId");

CREATE TABLE IF NOT EXISTS "ProblemNachricht" (
  "id"         TEXT PRIMARY KEY,
  "meldungId"  TEXT NOT NULL REFERENCES "ProblemMeldung"("id") ON DELETE CASCADE,
  "von"        TEXT NOT NULL,
  "actorId"    TEXT,
  "actorName"  TEXT,
  "text"       TEXT NOT NULL,
  "intern"     BOOLEAN NOT NULL DEFAULT FALSE,
  "art"        TEXT NOT NULL DEFAULT 'nachricht',
  "createdAt"  TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS "ProblemNachricht_meldung_idx" ON "ProblemNachricht" ("meldungId", "createdAt");

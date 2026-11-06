-- Betreiber-Konsole: aktive Nutzer (letzte angemeldete Anfrage je Nutzer, Geraet, Version).
CREATE TABLE IF NOT EXISTS "NutzerAktivitaet" (
  "actorId"   TEXT PRIMARY KEY,
  "tenantId"  TEXT,
  "geraet"    TEXT NOT NULL,
  "version"   TEXT,
  "zuletztAt" TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  "erstesAt"  TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  "anfragen"  INTEGER NOT NULL DEFAULT 0
);
CREATE INDEX IF NOT EXISTS "NutzerAktivitaet_zuletzt_idx" ON "NutzerAktivitaet" ("zuletztAt" DESC);

-- docs/PLAN_BESTANDSSUCHE.md S2 — zentrale Belegtabelle fuer die Bestandssuche.
-- Eine Tabelle, Spalte quelle trennt Stellen, Karriere, Fokus-Themen, Referenzen,
-- Profil; tsv (german) fuer BM25, embedding spaeter (S3, lokal gerechnet).
CREATE TABLE IF NOT EXISTS "SuchBlock" (
  "id"         TEXT PRIMARY KEY,
  "companyId"  TEXT NOT NULL,
  "quelle"     TEXT NOT NULL,
  "ref"        TEXT NOT NULL,
  "titel"      TEXT NOT NULL,
  "text"       TEXT NOT NULL,
  "quelleUrl"  TEXT,
  "datum"      TIMESTAMPTZ,
  "tsv"        tsvector GENERATED ALWAYS AS (to_tsvector('german', coalesce("titel", '') || ' ' || "text")) STORED,
  "embedding"  REAL[],
  "updatedAt"  TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  CONSTRAINT "SuchBlock_quelle_companyId_ref_key" UNIQUE ("quelle", "companyId", "ref")
);
CREATE INDEX IF NOT EXISTS "SuchBlock_companyId_quelle_idx" ON "SuchBlock" ("companyId", "quelle");
CREATE INDEX IF NOT EXISTS "SuchBlock_tsv_idx" ON "SuchBlock" USING GIN ("tsv");

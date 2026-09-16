-- Firmen-Verflechtungen V4 (docs/PLAN_VERFLECHTUNGEN.md §4 Nr. 6): Rekursion ueber
-- Firmen-Gesellschafter ohne LLM im Gateway. Ein Kontext ist ein Verarbeitungs-
-- lauf ab einer Ursprungsfirma (Besuchsliste, Notbremse Tiefe/Anzahl, Opt-out).
CREATE TABLE IF NOT EXISTS "VerflechtungKontext" (
  "kontext" TEXT PRIMARY KEY,
  "tenantId" TEXT NOT NULL,
  "ursprungCompanyId" TEXT NOT NULL,
  "transactionId" TEXT NOT NULL,
  "quelleTransactionId" TEXT,
  "userId" TEXT,
  "maxTiefe" INTEGER NOT NULL,
  "maxFirmen" INTEGER NOT NULL,
  "ohneBremse" BOOLEAN NOT NULL DEFAULT FALSE,
  "erstelltAt" TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS "VerflechtungKontext_tenant_ursprung_idx" ON "VerflechtungKontext" ("tenantId", "ursprungCompanyId");

CREATE TABLE IF NOT EXISTS "VerflechtungBesuch" (
  "kontext" TEXT NOT NULL REFERENCES "VerflechtungKontext" ("kontext") ON DELETE CASCADE,
  "companyId" TEXT NOT NULL,
  "tiefe" INTEGER NOT NULL,
  "status" TEXT NOT NULL,
  "grund" TEXT,
  "gericht" TEXT,
  "art" TEXT,
  "nummer" TEXT,
  "zusatz" TEXT,
  "aktualisiertAt" TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  PRIMARY KEY ("kontext", "companyId")
);
CREATE INDEX IF NOT EXISTS "VerflechtungBesuch_status_idx" ON "VerflechtungBesuch" ("status", "aktualisiertAt");
CREATE INDEX IF NOT EXISTS "VerflechtungBesuch_company_idx" ON "VerflechtungBesuch" ("companyId");

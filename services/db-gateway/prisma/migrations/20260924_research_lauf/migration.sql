-- Manueller Recherche-Lauf je Firma (2026-09-24): Protokoll, wann welche
-- Recherche (Stellenanzeigen / Ausschreibungen, Standard / Deep) lief und
-- wie viele Ergebnisse zusammenkamen. Nutzerwunsch: nachvollziehen koennen,
-- was verarbeitet wurde — auch nach einem Seitenwechsel.
CREATE TABLE IF NOT EXISTS "CompanyResearchLauf" (
    "id"            TEXT         NOT NULL,
    "tenantId"      TEXT         NOT NULL,
    "actorId"       TEXT         NOT NULL,
    "companyId"     TEXT         NOT NULL,
    "transactionId" TEXT,
    "feature"       TEXT         NOT NULL,
    "stufe"         TEXT         NOT NULL,
    "state"         TEXT         NOT NULL DEFAULT 'laufend',
    "ergebnisse"    INTEGER,
    "fehler"        TEXT,
    "gestartetAt"   TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "beendetAt"     TIMESTAMP(3),
    CONSTRAINT "CompanyResearchLauf_pkey" PRIMARY KEY ("id")
);
CREATE INDEX IF NOT EXISTS "CompanyResearchLauf_firma_idx" ON "CompanyResearchLauf" ("tenantId", "companyId", "gestartetAt");

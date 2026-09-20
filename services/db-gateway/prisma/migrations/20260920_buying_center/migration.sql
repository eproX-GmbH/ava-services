-- Buying Center / Power Map (docs/PLAN_BUYING_CENTER.md, BC0).
--
-- Vier Dimensionen je Person nach Sieck. Gehoert IMMER der Person, die es
-- angelegt hat; Sichtfreigabe (BC7) ist nur lesend. Die Belegkette
-- (BuyingCenterAngabe) wird nie ueberschrieben, nur ergaenzt.

CREATE TABLE IF NOT EXISTS "BuyingCenter" (
    "id"                 TEXT         NOT NULL,
    "tenantId"           TEXT         NOT NULL,
    "eigentuemerActorId" TEXT         NOT NULL,
    "companyId"          TEXT         NOT NULL,
    "anlass"             TEXT         NOT NULL DEFAULT '',
    "status"             TEXT         NOT NULL DEFAULT 'aktiv',
    "angelegtAt"         TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt"          TIMESTAMP(3) NOT NULL,
    CONSTRAINT "BuyingCenter_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX IF NOT EXISTS "BuyingCenter_eigentuemer_firma_anlass_key"
    ON "BuyingCenter" ("tenantId", "eigentuemerActorId", "companyId", "anlass");
CREATE INDEX IF NOT EXISTS "BuyingCenter_eigentuemer_idx" ON "BuyingCenter" ("tenantId", "eigentuemerActorId");
CREATE INDEX IF NOT EXISTS "BuyingCenter_firma_idx"       ON "BuyingCenter" ("tenantId", "companyId");

CREATE TABLE IF NOT EXISTS "BuyingCenterMitglied" (
    "id"                    TEXT         NOT NULL,
    "buyingCenterId"        TEXT         NOT NULL,
    "personId"              TEXT,
    "name"                  TEXT         NOT NULL,
    "funktion"              TEXT,
    "rollen"                TEXT[]       NOT NULL DEFAULT ARRAY[]::TEXT[],
    "einstellung"           TEXT,
    "kontakt"               TEXT,
    "einfluss"              TEXT,
    "ansprechpartnerBeiUns" TEXT,
    "x"                     DOUBLE PRECISION,
    "y"                     DOUBLE PRECISION,
    "angelegtAt"            TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt"             TIMESTAMP(3) NOT NULL,
    CONSTRAINT "BuyingCenterMitglied_pkey" PRIMARY KEY ("id"),
    CONSTRAINT "BuyingCenterMitglied_bc_fkey" FOREIGN KEY ("buyingCenterId")
        REFERENCES "BuyingCenter" ("id") ON DELETE CASCADE ON UPDATE CASCADE
);
CREATE INDEX IF NOT EXISTS "BuyingCenterMitglied_bc_idx"     ON "BuyingCenterMitglied" ("buyingCenterId");
CREATE INDEX IF NOT EXISTS "BuyingCenterMitglied_person_idx" ON "BuyingCenterMitglied" ("personId");

CREATE TABLE IF NOT EXISTS "BuyingCenterAngabe" (
    "id"          TEXT         NOT NULL,
    "mitgliedId"  TEXT         NOT NULL,
    "dimension"   TEXT         NOT NULL,
    "wert"        TEXT,
    "herkunft"    TEXT         NOT NULL,
    "grund"       TEXT         NOT NULL,
    "vonActorId"  TEXT,
    "entschieden" TEXT,
    "erfasstAt"   TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "BuyingCenterAngabe_pkey" PRIMARY KEY ("id"),
    CONSTRAINT "BuyingCenterAngabe_mitglied_fkey" FOREIGN KEY ("mitgliedId")
        REFERENCES "BuyingCenterMitglied" ("id") ON DELETE CASCADE ON UPDATE CASCADE
);
CREATE INDEX IF NOT EXISTS "BuyingCenterAngabe_mitglied_idx"
    ON "BuyingCenterAngabe" ("mitgliedId", "dimension", "erfasstAt");

CREATE TABLE IF NOT EXISTS "BuyingCenterKante" (
    "id"             TEXT         NOT NULL,
    "buyingCenterId" TEXT         NOT NULL,
    "vonMitgliedId"  TEXT         NOT NULL,
    "nachMitgliedId" TEXT         NOT NULL,
    "art"            TEXT         NOT NULL,
    "staerke"        TEXT,
    "grund"          TEXT,
    "herkunft"       TEXT         NOT NULL DEFAULT 'nutzer',
    "vonActorId"     TEXT,
    "erfasstAt"      TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "BuyingCenterKante_pkey" PRIMARY KEY ("id"),
    CONSTRAINT "BuyingCenterKante_bc_fkey" FOREIGN KEY ("buyingCenterId")
        REFERENCES "BuyingCenter" ("id") ON DELETE CASCADE ON UPDATE CASCADE
);
CREATE INDEX IF NOT EXISTS "BuyingCenterKante_bc_idx" ON "BuyingCenterKante" ("buyingCenterId");

CREATE TABLE IF NOT EXISTS "BuyingCenterFreigabe" (
    "buyingCenterId" TEXT         NOT NULL,
    "actorId"        TEXT         NOT NULL,
    "erteiltVon"     TEXT         NOT NULL,
    "erteiltAt"      TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "BuyingCenterFreigabe_pkey" PRIMARY KEY ("buyingCenterId", "actorId"),
    CONSTRAINT "BuyingCenterFreigabe_bc_fkey" FOREIGN KEY ("buyingCenterId")
        REFERENCES "BuyingCenter" ("id") ON DELETE CASCADE ON UPDATE CASCADE
);
CREATE INDEX IF NOT EXISTS "BuyingCenterFreigabe_actor_idx" ON "BuyingCenterFreigabe" ("actorId");

CREATE TABLE IF NOT EXISTS "FokusKunde" (
    "tenantId"  TEXT         NOT NULL,
    "actorId"   TEXT         NOT NULL,
    "companyId" TEXT         NOT NULL,
    "seit"      TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "FokusKunde_pkey" PRIMARY KEY ("tenantId", "actorId", "companyId")
);
CREATE INDEX IF NOT EXISTS "FokusKunde_firma_idx" ON "FokusKunde" ("tenantId", "companyId");

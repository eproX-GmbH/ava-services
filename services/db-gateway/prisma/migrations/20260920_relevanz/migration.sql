-- Relevanz (docs/PLAN_RELEVANZ.md) — Naehe je Nutzer und Ziel.
--
-- Drei Tabellen: Rohsignale, abgeleiteter Wert, Sperre nach dem Entfernen
-- einer Firma. Alles streng getrennt nach tenantId UND actorId; die einzige
-- Abfrage ueber Nutzer hinweg ist das Aggregat aus Abschnitt 10 des Plans,
-- und das liefert nur eine Anzahl ohne Namen.
--
-- Organisationsvorgaben: relevanzSelbstbestimmt = darf das Mitglied vom
-- Schalter der Organisation abweichen (Standard ja). relevanzThemaSichtbar =
-- sehen Mitglieder, wie viele Kollegen eine Firma warm haben (Standard ja,
-- als blosse Anzahl). Die Funktion selbst haengt am ORG_FEATURES-Schluessel
-- "relevanz" und ist damit ohne Eintrag erlaubt.

CREATE TABLE IF NOT EXISTS "RelevanzSignal" (
    "id"        BIGSERIAL        NOT NULL,
    "tenantId"  TEXT             NOT NULL,
    "actorId"   TEXT             NOT NULL,
    "geraetRef" TEXT             NOT NULL,
    "zielArt"   TEXT             NOT NULL,
    "zielId"    TEXT             NOT NULL,
    "firmaId"   TEXT,
    "art"       TEXT             NOT NULL,
    "punkte"    DOUBLE PRECISION NOT NULL,
    "halbwertT" DOUBLE PRECISION NOT NULL,
    "zeitpunkt" TIMESTAMP(3)     NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "RelevanzSignal_pkey" PRIMARY KEY ("id")
);

-- Macht den Buendel-Versand wiederholbar: Ein erneuter Versuch nach einem
-- Netzfehler schreibt dieselben Signale nicht zweimal.
CREATE UNIQUE INDEX IF NOT EXISTS "RelevanzSignal_actorId_geraetRef_key"
    ON "RelevanzSignal" ("actorId", "geraetRef");
CREATE INDEX IF NOT EXISTS "RelevanzSignal_ziel_idx"
    ON "RelevanzSignal" ("tenantId", "actorId", "zielArt", "zielId", "zeitpunkt");
-- Fuer die taegliche Tilgung nach 400 Tagen.
CREATE INDEX IF NOT EXISTS "RelevanzSignal_zeitpunkt_idx"
    ON "RelevanzSignal" ("zeitpunkt");

CREATE TABLE IF NOT EXISTS "RelevanzWert" (
    "tenantId"      TEXT             NOT NULL,
    "actorId"       TEXT             NOT NULL,
    "zielArt"       TEXT             NOT NULL,
    "zielId"        TEXT             NOT NULL,
    "naehe"         DOUBLE PRECISION NOT NULL,
    "gewicht"       DOUBLE PRECISION NOT NULL DEFAULT 1,
    "rang"          DOUBLE PRECISION NOT NULL,
    "begruendung"   JSONB            NOT NULL,
    "letztesSignal" TIMESTAMP(3),
    "berechnet"     TIMESTAMP(3)     NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "RelevanzWert_pkey" PRIMARY KEY ("tenantId", "actorId", "zielArt", "zielId")
);

-- Arbeitsvorschau des Heartbeats.
CREATE INDEX IF NOT EXISTS "RelevanzWert_rang_idx"
    ON "RelevanzWert" ("tenantId", "actorId", "rang");
-- Aggregat "Gerade Thema": zaehlt ueber die Organisation, nicht ueber Nutzer.
CREATE INDEX IF NOT EXISTS "RelevanzWert_thema_idx"
    ON "RelevanzWert" ("tenantId", "zielArt", "naehe");

CREATE TABLE IF NOT EXISTS "RelevanzSperre" (
    "tenantId" TEXT         NOT NULL,
    "actorId"  TEXT         NOT NULL,
    "zielArt"  TEXT         NOT NULL,
    "zielId"   TEXT         NOT NULL,
    "bis"      TIMESTAMP(3) NOT NULL,

    CONSTRAINT "RelevanzSperre_pkey" PRIMARY KEY ("tenantId", "actorId", "zielArt", "zielId")
);

ALTER TABLE "TenantPolicy"
  ADD COLUMN IF NOT EXISTS "relevanzSelbstbestimmt" BOOLEAN NOT NULL DEFAULT true,
  ADD COLUMN IF NOT EXISTS "relevanzThemaSichtbar"  BOOLEAN NOT NULL DEFAULT true;

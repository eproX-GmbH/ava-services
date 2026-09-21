-- Buying Center: Protokoll der Hintergrundlaeufe (docs/PLAN_BUYING_CENTER.md).
--
-- Nutzerfrage 2026-09-21: "Wo kann ich nachvollziehen, wann und welche
-- Hintergrundverarbeitung stattfindet?" Bisher nur verstreut (Belegkette,
-- Heartbeat-Transparenz, Watchlist). Jetzt eine Zeile je Lauf am Buying
-- Center: Entwurf, CRM-Abgleich, Website-Abgleich, Nachfrage, Watchlist-
-- Aufnahme, Verknuepfung, Statuswechsel, Freigabe.
CREATE TABLE IF NOT EXISTS "BuyingCenterLauf" (
    "id"             TEXT         NOT NULL,
    "buyingCenterId" TEXT         NOT NULL,
    "art"            TEXT         NOT NULL,
    "ergebnis"       TEXT         NOT NULL,
    "details"        JSONB,
    "zeitpunkt"      TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "BuyingCenterLauf_pkey" PRIMARY KEY ("id"),
    CONSTRAINT "BuyingCenterLauf_bc_fkey" FOREIGN KEY ("buyingCenterId")
        REFERENCES "BuyingCenter" ("id") ON DELETE CASCADE ON UPDATE CASCADE
);
CREATE INDEX IF NOT EXISTS "BuyingCenterLauf_bc_zeit_idx" ON "BuyingCenterLauf" ("buyingCenterId", "zeitpunkt");

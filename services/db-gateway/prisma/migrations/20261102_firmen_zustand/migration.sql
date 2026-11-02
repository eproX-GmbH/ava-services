-- docs/PLAN_PRICING_TIERS.md P10 — Zustand je Nutzer und Firma: aktiv | ruhend.
-- Ohne Zeile gilt aktiv (Bestandsschutz). Vormerkungen (geplant) fuehrt der
-- Billing-Cron am Monatsersten aus.
CREATE TABLE IF NOT EXISTS "FirmenZustand" (
  "actorId"       TEXT NOT NULL,
  "companyId"     TEXT NOT NULL,
  "zustand"       TEXT NOT NULL,
  "seit"          TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  "quelle"        TEXT,
  "geplant"       TEXT,
  "geplantAb"     TEXT,
  "geplantTausch" TEXT[] NOT NULL DEFAULT '{}',
  "updatedAt"     TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  PRIMARY KEY ("actorId", "companyId")
);
CREATE INDEX IF NOT EXISTS "FirmenZustand_actor_zustand_idx" ON "FirmenZustand" ("actorId", "zustand");
CREATE INDEX IF NOT EXISTS "FirmenZustand_geplant_idx" ON "FirmenZustand" ("geplantAb") WHERE "geplant" IS NOT NULL;

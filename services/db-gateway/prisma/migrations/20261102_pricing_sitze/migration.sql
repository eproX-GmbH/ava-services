-- docs/PLAN_PRICING_TIERS.md P1 (2026-11-02): Plaene als Sitze je Organisation,
-- Kontingent je Nutzer, Pay-as-you-go oberhalb Ultra, LinkedIn-Beobachtung nach
-- Verbrauch, Enterprise-Limits durch den Betreiber.

-- Organisation: ein Stripe-Abo mit Mengen je Plan, vorgemerkte Reduktionen,
-- Enterprise-Grenzen. Nutzer: Pay-as-you-go-Freigabe je Monat, LinkedIn-Limit.
ALTER TABLE "TenantBilling" ADD COLUMN IF NOT EXISTS "sitzeGeplant" JSONB;
ALTER TABLE "TenantBilling" ADD COLUMN IF NOT EXISTS "stripeScheduleId" TEXT;
ALTER TABLE "TenantBilling" ADD COLUMN IF NOT EXISTS "maxMitglieder" INTEGER;
ALTER TABLE "TenantBilling" ADD COLUMN IF NOT EXISTS "firmenLimit" INTEGER;
ALTER TABLE "TenantBilling" ADD COLUMN IF NOT EXISTS "linkedinLimitCents" INTEGER;
ALTER TABLE "TenantBilling" ADD COLUMN IF NOT EXISTS "linkedinImVertrag" BOOLEAN NOT NULL DEFAULT false;
ALTER TABLE "TenantBilling" ADD COLUMN IF NOT EXISTS "paygFreigabePeriode" TEXT;
ALTER TABLE "TenantBilling" ADD COLUMN IF NOT EXISTS "paygLimitCents" INTEGER;

-- Sitze: Quelle fuer Mengen je Plan, freie Sitze, Zuweisung und die Historie,
-- aus der das tagesanteilige Kontingent je Nutzer berechnet wird. Nie loeschen,
-- nur "endetAm" setzen.
CREATE TABLE IF NOT EXISTS "Sitz" (
  "id"            TEXT PRIMARY KEY,
  "tenantId"      TEXT NOT NULL,
  "plan"          TEXT NOT NULL,            -- pro | max | ultra
  "stripeItemId"  TEXT,
  "actorId"       TEXT,                     -- NULL = frei
  "zugewiesenAm"  TIMESTAMPTZ,
  "zugewiesenVon" TEXT,
  "endetAm"       TIMESTAMPTZ,              -- NULL = laeuft
  "reduziertZum"  TIMESTAMPTZ,              -- vorgemerkte Reduktion zum Zyklusende
  "createdAt"     TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP
);
CREATE INDEX IF NOT EXISTS "Sitz_tenant_plan_idx" ON "Sitz" ("tenantId", "plan", "endetAm");
CREATE INDEX IF NOT EXISTS "Sitz_actor_idx" ON "Sitz" ("actorId", "endetAm");

-- Historie der Zuweisungen je Nutzer (Kontingent tagesanteilig): jede Zeile sagt,
-- welchen Plan der Nutzer ab "ab" hatte; "bis" NULL = bis heute.
CREATE TABLE IF NOT EXISTS "PlanZeitraum" (
  "id"        TEXT PRIMARY KEY,
  "actorId"   TEXT NOT NULL,
  "tenantId"  TEXT NOT NULL,
  "plan"      TEXT NOT NULL,                -- free | pro | max | ultra | enterprise
  "sitzId"    TEXT,
  "ab"        TIMESTAMPTZ NOT NULL,
  "bis"       TIMESTAMPTZ
);
CREATE INDEX IF NOT EXISTS "PlanZeitraum_actor_idx" ON "PlanZeitraum" ("actorId", "ab");

-- Neuverarbeitung ganzer Firmen durch den Kunden: zaehlt wie eine weitere
-- Aufnahme zum Stufenpreis, auch wenn die Firma im Monat schon im Bestand ist.
CREATE TABLE IF NOT EXISTS "NeuverarbeitungEntry" (
  "id"               TEXT PRIMARY KEY,
  "billingAccountId" TEXT NOT NULL,
  "periodKey"        TEXT NOT NULL,
  "companyId"        TEXT NOT NULL,
  "stufe"            TEXT,
  "preisCents"       INTEGER,
  "actorId"          TEXT,
  "createdAt"        TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP
);
CREATE INDEX IF NOT EXISTS "NeuverarbeitungEntry_konto_periode_idx" ON "NeuverarbeitungEntry" ("billingAccountId", "periodKey");

-- Mitglied ohne Platz wartet auf die Zuweisung eines Sitzes; Beitrittsanfrage
-- kann einen Sitzwunsch tragen (Einladung mit Plan).
ALTER TABLE "TenantMember" ADD COLUMN IF NOT EXISTS "status" TEXT NOT NULL DEFAULT 'aktiv';
ALTER TABLE "TenantJoinRequest" ADD COLUMN IF NOT EXISTS "sitzWunsch" TEXT;

-- LinkedIn-Beobachtung nach Verbrauch: Kundenpreis je Apify-Lauf (Schaetzung bis
-- die echten Kosten da sind) und Kontext (firmenverarbeitung | linkedin).
ALTER TABLE "LlmUsage" ADD COLUMN IF NOT EXISTS "preisCents" INTEGER;
ALTER TABLE "LlmUsage" ADD COLUMN IF NOT EXISTS "kontext" TEXT;

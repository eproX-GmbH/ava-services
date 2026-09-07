-- B1/B2 (docs/PLAN_ABRECHNUNG_SEATS.md) — Abrechnungskonto vom Daten-Tenant
-- trennen, Mitgliedschaftshistorie, Seat-Zaehlung, Abrechnungsdatensatz,
-- Billing-Events, Stripe-Event-Dedupe.
--
-- TenantBilling bleibt als Tabelle bestehen und wird zum ABRECHNUNGSKONTO:
-- "tenantId" ist die billingAccountId (persoenlich = Nutzer-sub,
-- Organisation = Organisations-ID). Aufloesung: lib/billing.ts
-- resolveBillingAccountId().

ALTER TABLE "TenantBilling" ADD COLUMN IF NOT EXISTS "kind" TEXT NOT NULL DEFAULT 'personal';
ALTER TABLE "TenantBilling" ADD COLUMN IF NOT EXISTS "mode" TEXT NOT NULL DEFAULT 'none';
ALTER TABLE "TenantBilling" ADD COLUMN IF NOT EXISTS "status" TEXT NOT NULL DEFAULT 'active';
ALTER TABLE "TenantBilling" ADD COLUMN IF NOT EXISTS "pastDueSince" TIMESTAMP(3);
ALTER TABLE "TenantBilling" ADD COLUMN IF NOT EXISTS "suspendedAt" TIMESTAMP(3);
ALTER TABLE "TenantBilling" ADD COLUMN IF NOT EXISTS "graceDays" INTEGER NOT NULL DEFAULT 14;
ALTER TABLE "TenantBilling" ADD COLUMN IF NOT EXISTS "seatTier" TEXT;
ALTER TABLE "TenantBilling" ADD COLUMN IF NOT EXISTS "seatBillingSince" TIMESTAMP(3);
ALTER TABLE "TenantBilling" ADD COLUMN IF NOT EXISTS "seatBillingEndsAt" TIMESTAMP(3);
ALTER TABLE "TenantBilling" ADD COLUMN IF NOT EXISTS "maxSeats" INTEGER;
ALTER TABLE "TenantBilling" ADD COLUMN IF NOT EXISTS "karenzTag" INTEGER;
ALTER TABLE "TenantBilling" ADD COLUMN IF NOT EXISTS "lastStripeEventAt" TIMESTAMP(3);

UPDATE "TenantBilling" b SET "kind" = 'organisation'
  FROM "Tenant" t WHERE t."id" = b."tenantId" AND t."kind" = 'organisation';
UPDATE "TenantBilling" SET "mode" = 'enterprise' WHERE "tier" = 'enterprise';
UPDATE "TenantBilling" SET "mode" = 'subscription' WHERE "mode" = 'none' AND "stripeSubscriptionId" IS NOT NULL;

-- Verbrauch haengt am Abrechnungskonto, nicht am Daten-Tenant.
ALTER TABLE "UsageEntry" RENAME COLUMN "tenantId" TO "billingAccountId";
ALTER INDEX "UsageEntry_tenantId_periodKey_idx" RENAME TO "UsageEntry_billingAccountId_periodKey_idx";

-- Mitgliedschaftshistorie (Intervalle) — Grundlage der Seat-Zaehlung.
CREATE TABLE "TenantMembership" (
  "id"         TEXT NOT NULL,
  "tenantId"   TEXT NOT NULL,
  "actorId"    TEXT NOT NULL,
  "role"       TEXT NOT NULL,
  "email"      TEXT,
  "name"       TEXT,
  "joinedAt"   TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "leftAt"     TIMESTAMP(3),
  "leftReason" TEXT,
  CONSTRAINT "TenantMembership_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "TenantMembership_tenantId_fkey" FOREIGN KEY ("tenantId")
    REFERENCES "Tenant"("id") ON DELETE CASCADE ON UPDATE CASCADE
);
CREATE INDEX "TenantMembership_tenantId_joinedAt_idx" ON "TenantMembership"("tenantId", "joinedAt");
CREATE INDEX "TenantMembership_actorId_leftAt_idx" ON "TenantMembership"("actorId", "leftAt");

INSERT INTO "TenantMembership" ("id", "tenantId", "actorId", "role", "email", "name", "joinedAt")
SELECT 'mb_' || md5(m."tenantId" || ':' || m."actorId" || ':' || m."joinedAt"::text),
       m."tenantId", m."actorId", m."role", m."email", m."name", m."joinedAt"
  FROM "TenantMember" m JOIN "Tenant" t ON t."id" = m."tenantId"
 WHERE t."kind" = 'organisation';

-- Tier-Zeitachse der Organisation ('none' = Sammelabrechnung aus).
CREATE TABLE "SeatTierChange" (
  "id"        TEXT NOT NULL,
  "tenantId"  TEXT NOT NULL,
  "tier"      TEXT NOT NULL,
  "validFrom" TIMESTAMP(3) NOT NULL,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "createdBy" TEXT,
  CONSTRAINT "SeatTierChange_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "SeatTierChange_tenantId_fkey" FOREIGN KEY ("tenantId")
    REFERENCES "Tenant"("id") ON DELETE CASCADE ON UPDATE CASCADE
);
CREATE INDEX "SeatTierChange_tenantId_validFrom_idx" ON "SeatTierChange"("tenantId", "validFrom");

-- Abrechnungsdatensatz je Organisation und Monat (reproduzierbar).
CREATE TABLE "SeatInvoice" (
  "id"              TEXT NOT NULL,
  "tenantId"        TEXT NOT NULL,
  "periodKey"       TEXT NOT NULL,
  "status"          TEXT NOT NULL DEFAULT 'recorded',
  "currency"        TEXT NOT NULL DEFAULT 'EUR',
  "subtotalCents"   INTEGER NOT NULL DEFAULT 0,
  "taxCents"        INTEGER,
  "totalCents"      INTEGER NOT NULL DEFAULT 0,
  "seatCount"       INTEGER NOT NULL DEFAULT 0,
  "computedAt"      TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "computeHash"     TEXT NOT NULL,
  "stripeInvoiceId" TEXT,
  "issuedAt"        TIMESTAMP(3),
  "paidAt"          TIMESTAMP(3),
  "note"            TEXT,
  CONSTRAINT "SeatInvoice_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "SeatInvoice_tenantId_fkey" FOREIGN KEY ("tenantId")
    REFERENCES "Tenant"("id") ON DELETE CASCADE ON UPDATE CASCADE
);
CREATE UNIQUE INDEX "SeatInvoice_tenantId_periodKey_key" ON "SeatInvoice"("tenantId", "periodKey");

CREATE TABLE "SeatInvoiceLine" (
  "id"             TEXT NOT NULL,
  "invoiceId"      TEXT NOT NULL,
  "tier"           TEXT NOT NULL,
  "seats"          INTEGER NOT NULL,
  "unitPriceCents" INTEGER NOT NULL,
  "amountCents"    INTEGER NOT NULL,
  CONSTRAINT "SeatInvoiceLine_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "SeatInvoiceLine_invoiceId_fkey" FOREIGN KEY ("invoiceId")
    REFERENCES "SeatInvoice"("id") ON DELETE CASCADE ON UPDATE CASCADE
);
CREATE INDEX "SeatInvoiceLine_invoiceId_idx" ON "SeatInvoiceLine"("invoiceId");

CREATE TABLE "SeatInvoiceSeat" (
  "id"              TEXT NOT NULL,
  "invoiceId"       TEXT NOT NULL,
  "actorId"         TEXT NOT NULL,
  "email"           TEXT,
  "name"            TEXT,
  "tier"            TEXT NOT NULL,
  "firstCountedDay" TEXT NOT NULL,
  "lastCountedDay"  TEXT NOT NULL,
  "countedDays"     INTEGER NOT NULL,
  CONSTRAINT "SeatInvoiceSeat_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "SeatInvoiceSeat_invoiceId_fkey" FOREIGN KEY ("invoiceId")
    REFERENCES "SeatInvoice"("id") ON DELETE CASCADE ON UPDATE CASCADE
);
CREATE INDEX "SeatInvoiceSeat_invoiceId_idx" ON "SeatInvoiceSeat"("invoiceId");

-- Audit je Abrechnungskonto.
CREATE TABLE "BillingEvent" (
  "id"               BIGSERIAL NOT NULL,
  "billingAccountId" TEXT NOT NULL,
  "ts"               TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "kind"             TEXT NOT NULL,
  "source"           TEXT NOT NULL,
  "actorId"          TEXT,
  "stripeEventId"    TEXT,
  "payload"          JSONB,
  CONSTRAINT "BillingEvent_pkey" PRIMARY KEY ("id")
);
CREATE INDEX "BillingEvent_billingAccountId_ts_idx" ON "BillingEvent"("billingAccountId", "ts");

-- Stripe-Webhook-Dedupe.
CREATE TABLE "StripeEvent" (
  "id"          TEXT NOT NULL,
  "type"        TEXT NOT NULL,
  "created"     TIMESTAMP(3) NOT NULL,
  "processedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "StripeEvent_pkey" PRIMARY KEY ("id")
);

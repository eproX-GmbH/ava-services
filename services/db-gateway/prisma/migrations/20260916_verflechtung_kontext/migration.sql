-- Firmen-Verflechtungen (docs/PLAN_VERFLECHTUNGEN.md §4 Schritt 6): Besuchsliste je
-- Verarbeitungskontext. Eine Firma bekommt je Kontext hoechstens einen
-- gesellschafter-Job; damit enden Schleifen (A haelt B, B haelt A).
CREATE TABLE "VerflechtungKontext" (
  "kontext" TEXT NOT NULL,
  "companyId" TEXT NOT NULL,
  "tiefe" INTEGER NOT NULL DEFAULT 0,
  "ohneBremse" BOOLEAN NOT NULL DEFAULT false,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "VerflechtungKontext_pkey" PRIMARY KEY ("kontext", "companyId")
);
CREATE INDEX "VerflechtungKontext_kontext_idx" ON "VerflechtungKontext"("kontext");

-- docs/PLAN_CHATGPT_ABO_UEBERALL.md (E4): Unter Anbieter-Sperre duerfen Mitglieder
-- die Firmenverarbeitung (Producer) nur mit dieser Freigabe ueber ihr
-- persoenliches ChatGPT-Abo laufen lassen. Standard false.
ALTER TABLE "TenantPolicy"
  ADD COLUMN IF NOT EXISTS "chatgptPlanProducer" BOOLEAN NOT NULL DEFAULT false;

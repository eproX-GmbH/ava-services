-- Organisationsvorgabe (docs/PLAN_SIGN_IN_WITH_CHATGPT.md): Duerfen Mitglieder
-- ihr persoenliches ChatGPT-Abo (Sign in with ChatGPT, Plan-Nutzung) in AVA
-- verwenden? Standard true. Konten bleiben persoenlich; es gibt keinen
-- zentralen Account der Organisation.
ALTER TABLE "TenantPolicy"
  ADD COLUMN IF NOT EXISTS "chatgptPlanErlaubt" BOOLEAN NOT NULL DEFAULT true;

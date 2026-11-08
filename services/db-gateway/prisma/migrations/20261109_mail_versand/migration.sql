-- Onboarding O5 (docs/PLAN_ONBOARDING.md): Mails an Nutzer.
ALTER TABLE "StartAuftrag" ADD COLUMN IF NOT EXISTS "email" TEXT;
ALTER TABLE "StartAuftrag" ADD COLUMN IF NOT EXISTS "vorname" TEXT;
ALTER TABLE "StartAuftrag" ADD COLUMN IF NOT EXISTS "willkommenGesendetAt" TIMESTAMPTZ;

-- Willkommen geht immer raus; Neuigkeiten erst nach Bestaetigung (Double-Opt-in,
-- Adressen sind unbestaetigt). token = Link-Schluessel fuer Bestaetigen/Abmelden.
CREATE TABLE IF NOT EXISTS "MailEinstellung" (
  "actorId"      TEXT PRIMARY KEY,
  "email"        TEXT NOT NULL,
  "vorname"      TEXT,
  "token"        TEXT NOT NULL UNIQUE,
  "neuigkeiten"  BOOLEAN NOT NULL DEFAULT FALSE,
  "bestaetigtAt" TIMESTAMPTZ,
  "abgemeldetAt" TIMESTAMPTZ,
  "createdAt"    TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  "updatedAt"    TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS "MailVersand" (
  "id"        BIGSERIAL PRIMARY KEY,
  "actorId"   TEXT NOT NULL,
  "art"       TEXT NOT NULL,
  "status"    TEXT NOT NULL,
  "mailgunId" TEXT,
  "fehler"    TEXT,
  "createdAt" TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS "MailVersand_actor_idx" ON "MailVersand" ("actorId", "createdAt" DESC);

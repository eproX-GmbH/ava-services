-- Fokus-Themen je Nutzer (2026-11-06): SuchBlock-Zeilen der Quelle thema tragen den Nutzer; andere Quellen bleiben NULL.
ALTER TABLE "SuchBlock" ADD COLUMN IF NOT EXISTS "actorId" TEXT;
CREATE INDEX IF NOT EXISTS "SuchBlock_thema_actor_idx" ON "SuchBlock" ("actorId") WHERE quelle = 'thema';
-- Bisherige Themen-Zeilen hatten keinen Nutzer und waeren fuer alle sichtbar: entfernen (Neuaufbau je Nutzer beim naechsten Lauf).
DELETE FROM "SuchBlock" WHERE quelle = 'thema' AND "actorId" IS NULL;

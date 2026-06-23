-- v0.1.394 — Nutzergesteuertes Pausieren EINER Firma im Vorgang.
--
-- Eine additive Spalte:
--   paused — wenn true, überspringt die Retry-Queue diese Zeile, sodass
--            fehlgeschlagene Schritte nicht erneut angetrieben werden.
--            „Fortsetzen" setzt es zurück. „Abbrechen" nutzt giveUpAt + state
--            (kein neuer Enum-Zustand nötig).
--
-- Default false → bestehende Zeilen verhalten sich unverändert.

ALTER TABLE "EntityProgress"
  ADD COLUMN IF NOT EXISTS "paused" BOOLEAN NOT NULL DEFAULT false;

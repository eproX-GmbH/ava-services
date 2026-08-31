-- v0.1.486 — runId auf ContentFreshness: das Tier-Gate muss Laeufe kennen.
--
-- Producer wie company-contact emittieren pro Lauf MEHRERE
-- Persist-Events (pro Seite + SERP + Cleanup). Das erste Event
-- schrieb die Freshness-Zeile, alle weiteren Events DESSELBEN Laufs
-- fielen auf "same tier, fresh (<= 30 days)" — vom eigenen Lauf
-- ausgesperrt (Live-Befund 2026-08-31: 12 extrahierte Personen, nur
-- das erste people=0-Event kam durch). Mit gespeicherter runId laesst
-- das Gate Events mit identischer runId immer durch. Backfill NULL —
-- alte Zeilen matchen nie, naechster Lauf stempelt frisch.

ALTER TABLE "ContentFreshness" ADD COLUMN "runId" TEXT;

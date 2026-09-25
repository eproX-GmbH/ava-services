-- Verbrauch nach Quelle (2026-09-25): Hintergrundaufrufe tragen im Header
-- x-ava-llm-quelle, welche Funktion sie ausgeloest hat (radar, mini-profile,
-- herzschlag …). Anlass: Kosten im Worker-Modus liessen sich keiner Funktion
-- zuordnen. Nur eine zusaetzliche, leere Spalte; bestehende Zeilen bleiben.
ALTER TABLE "LlmUsage" ADD COLUMN IF NOT EXISTS "quelle" TEXT;

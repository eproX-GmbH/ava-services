-- Konto loeschen / deaktivieren (docs/PLAN_KONTO_LOESCHEN.md). Unumkehrbar fuer
-- "geloescht"; "deaktiviert" kann nur das AVA-Team aufheben (Zeile loeschen +
-- Keycloak wieder einschalten). Die Anmeldepruefung weist beide ab.
CREATE TABLE IF NOT EXISTS "KontoStatus" (
  "actorId" TEXT PRIMARY KEY,
  "art"     TEXT NOT NULL,
  "domain"  TEXT,
  "fehler"  TEXT,
  "am"      TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

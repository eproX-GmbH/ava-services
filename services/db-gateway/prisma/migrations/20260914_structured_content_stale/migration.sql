-- Register-Delta S7 (docs/PLAN_STAMMDATEN_DELTA.md): Veraltet-Markierung
-- strukturierter Inhalte. Gesetzt vom Register-Delta (Registerblatt geaendert
-- oder Bekanntmachung mit neuen Dokumenten), geloescht, sobald
-- structured-content die Firma neu geschrieben hat. /companies/{id}/state
-- meldet die Stufe dann als nicht frisch, der Producer laeuft beim naechsten
-- Zugriff erneut.
CREATE TABLE IF NOT EXISTS "StructuredContentStale" (
  "companyId" TEXT PRIMARY KEY,
  "seit" TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  "grund" TEXT NOT NULL
);

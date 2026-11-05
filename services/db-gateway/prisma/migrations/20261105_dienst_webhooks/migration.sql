-- docs/PLAN_CLOSE_MCP.md C4 — Rueckkanal fremder Dienste: Empfangsadresse je Nutzer und Dienst, Ereignisse roh.
CREATE TABLE IF NOT EXISTS "WebhookEmpfaenger" (
  "id"        TEXT PRIMARY KEY,
  "token"     TEXT NOT NULL UNIQUE,
  "tenantId"  TEXT NOT NULL,
  "actorId"   TEXT NOT NULL,
  "dienst"    TEXT NOT NULL,
  "createdAt" TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  "zuletztAt" TIMESTAMPTZ,
  "anzahl"    INTEGER NOT NULL DEFAULT 0,
  CONSTRAINT "WebhookEmpfaenger_actor_dienst_key" UNIQUE ("actorId", "dienst")
);
CREATE TABLE IF NOT EXISTS "DienstEreignis" (
  "id"           TEXT PRIMARY KEY,
  "empfaengerId" TEXT NOT NULL REFERENCES "WebhookEmpfaenger"("id") ON DELETE CASCADE,
  "tenantId"     TEXT NOT NULL,
  "actorId"      TEXT NOT NULL,
  "dienst"       TEXT NOT NULL,
  "typ"          TEXT,
  "nutzlast"     JSONB NOT NULL,
  "empfangenAt"  TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  "gelesenAt"    TIMESTAMPTZ
);
CREATE INDEX IF NOT EXISTS "DienstEreignis_actor_empfangen_idx" ON "DienstEreignis" ("actorId", "empfangenAt" DESC);
CREATE INDEX IF NOT EXISTS "DienstEreignis_actor_ungelesen_idx" ON "DienstEreignis" ("actorId") WHERE "gelesenAt" IS NULL;

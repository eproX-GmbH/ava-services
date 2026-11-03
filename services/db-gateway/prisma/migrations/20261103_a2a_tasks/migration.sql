-- docs/PLAN_MCP_OEFFNUNG.md §14 — A2A-Fassade: Tasks fremder Agenten (Agent2Agent-Protokoll).
CREATE TABLE IF NOT EXISTS "A2aTask" (
  "id"             TEXT PRIMARY KEY,
  "contextId"      TEXT NOT NULL,
  "tenantId"       TEXT NOT NULL,
  "actorId"        TEXT NOT NULL,
  "skill"          TEXT NOT NULL,
  "eingabe"        JSONB NOT NULL,
  "zustand"        TEXT NOT NULL DEFAULT 'submitted',
  "statusText"     TEXT,
  "transactionId"  TEXT,
  "ergebnis"       JSONB,
  "verlauf"        JSONB NOT NULL DEFAULT '[]'::jsonb,
  "pushUrl"        TEXT,
  "pushToken"      TEXT,
  "pushVersuche"   INTEGER NOT NULL DEFAULT 0,
  "pushNaechster"  TIMESTAMPTZ,
  "pushErledigt"   BOOLEAN NOT NULL DEFAULT false,
  "abgeschlossenAt" TIMESTAMPTZ,
  "createdAt"      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  "updatedAt"      TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS "A2aTask_actor_idx" ON "A2aTask" ("actorId", "createdAt");
CREATE INDEX IF NOT EXISTS "A2aTask_offen_idx" ON "A2aTask" ("zustand") WHERE "zustand" IN ('submitted', 'working');
CREATE INDEX IF NOT EXISTS "A2aTask_push_idx" ON "A2aTask" ("pushNaechster") WHERE "pushErledigt" = false AND "pushUrl" IS NOT NULL;

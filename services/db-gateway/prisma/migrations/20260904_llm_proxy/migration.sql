-- O4 (docs/PLAN_ORGANISATIONEN.md) — Stellvertreter-Proxy: verschluesselte
-- Organisationsschluessel, Metering, Prompt-Audit (Opt-in).

CREATE TABLE "TenantProvider" (
  "tenantId"      TEXT NOT NULL,
  "kind"          TEXT NOT NULL,
  "keyCiphertext" TEXT NOT NULL,
  "keyHint"       TEXT NOT NULL,
  "updatedAt"     TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedBy"     TEXT,
  CONSTRAINT "TenantProvider_pkey" PRIMARY KEY ("tenantId", "kind"),
  CONSTRAINT "TenantProvider_tenantId_fkey" FOREIGN KEY ("tenantId")
    REFERENCES "Tenant"("id") ON DELETE CASCADE ON UPDATE CASCADE
);

CREATE TABLE "LlmUsage" (
  "id"              TEXT NOT NULL,
  "tenantId"        TEXT NOT NULL,
  "actorId"         TEXT NOT NULL,
  "kind"            TEXT NOT NULL,
  "model"           TEXT,
  "inputTokens"     INTEGER NOT NULL DEFAULT 0,
  "outputTokens"    INTEGER NOT NULL DEFAULT 0,
  "cacheReadTokens" INTEGER NOT NULL DEFAULT 0,
  "costMicroUsd"    INTEGER,
  "status"          INTEGER NOT NULL,
  "latencyMs"       INTEGER NOT NULL,
  "streamed"        BOOLEAN NOT NULL DEFAULT false,
  "createdAt"       TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "LlmUsage_pkey" PRIMARY KEY ("id")
);
CREATE INDEX "LlmUsage_tenantId_createdAt_idx" ON "LlmUsage"("tenantId", "createdAt");
CREATE INDEX "LlmUsage_actorId_createdAt_idx" ON "LlmUsage"("actorId", "createdAt");

CREATE TABLE "PromptAudit" (
  "id"        TEXT NOT NULL,
  "tenantId"  TEXT NOT NULL,
  "actorId"   TEXT NOT NULL,
  "kind"      TEXT NOT NULL,
  "model"     TEXT,
  "request"   JSONB NOT NULL,
  "response"  TEXT NOT NULL,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "PromptAudit_pkey" PRIMARY KEY ("id")
);
CREATE INDEX "PromptAudit_tenantId_createdAt_idx" ON "PromptAudit"("tenantId", "createdAt");

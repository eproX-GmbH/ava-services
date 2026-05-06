-- §8.v3 — operator-paid upstream proxy hardening (today: valueserp).
-- See prisma/schema.prisma for the why behind each table.

CREATE TABLE "ProxyAudit" (
    "id"        BIGSERIAL    NOT NULL,
    "proxy"     TEXT         NOT NULL,
    "tenantId"  TEXT         NOT NULL,
    "actorId"   TEXT         NOT NULL,
    "qHash"     TEXT         NOT NULL,
    "status"    INTEGER      NOT NULL,
    "latencyMs" INTEGER      NOT NULL,
    "cacheHit"  BOOLEAN      NOT NULL DEFAULT FALSE,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "ProxyAudit_pkey" PRIMARY KEY ("id")
);

CREATE INDEX "ProxyAudit_proxy_tenantId_createdAt_idx"
    ON "ProxyAudit" ("proxy", "tenantId", "createdAt");
CREATE INDEX "ProxyAudit_tenantId_createdAt_idx"
    ON "ProxyAudit" ("tenantId", "createdAt");

CREATE TABLE "ProxyQuotaOverride" (
    "tenantId"  TEXT         NOT NULL,
    "proxy"     TEXT         NOT NULL,
    "enabled"   BOOLEAN      NOT NULL DEFAULT TRUE,
    "perMinute" INTEGER,
    "perHour"   INTEGER,
    "perDay"    INTEGER,
    "perMonth"  INTEGER,
    "note"      TEXT,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "ProxyQuotaOverride_pkey" PRIMARY KEY ("tenantId", "proxy")
);

CREATE TABLE "ProxyCache" (
    "cacheKey"     TEXT         NOT NULL,
    "proxy"        TEXT         NOT NULL,
    "responseJson" TEXT         NOT NULL,
    "expiresAt"    TIMESTAMP(3) NOT NULL,
    "createdAt"    TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "ProxyCache_pkey" PRIMARY KEY ("cacheKey")
);

CREATE INDEX "ProxyCache_expiresAt_idx"  ON "ProxyCache" ("expiresAt");
CREATE INDEX "ProxyCache_proxy_createdAt_idx" ON "ProxyCache" ("proxy", "createdAt");

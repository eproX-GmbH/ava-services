-- O8 (docs/PLAN_ORGANISATIONEN.md §10) — Freigaben in der Organisation.
CREATE TABLE "OrgShare" (
  "id"        TEXT NOT NULL,
  "tenantId"  TEXT NOT NULL,
  "kind"      TEXT NOT NULL,
  "refId"     TEXT NOT NULL,
  "sharedBy"  TEXT NOT NULL,
  "sharedAt"  TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "note"      TEXT,
  "revokedAt" TIMESTAMP(3),
  CONSTRAINT "OrgShare_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "OrgShare_tenantId_fkey" FOREIGN KEY ("tenantId") REFERENCES "Tenant"("id") ON DELETE CASCADE ON UPDATE CASCADE
);
CREATE UNIQUE INDEX "OrgShare_tenantId_kind_refId_key" ON "OrgShare"("tenantId", "kind", "refId");
CREATE INDEX "OrgShare_tenantId_kind_sharedAt_idx" ON "OrgShare"("tenantId", "kind", "sharedAt");

CREATE TABLE "OrgShareSeen" (
  "shareId"     TEXT NOT NULL,
  "actorId"     TEXT NOT NULL,
  "seenAt"      TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "dismissedAt" TIMESTAMP(3),
  CONSTRAINT "OrgShareSeen_pkey" PRIMARY KEY ("shareId", "actorId"),
  CONSTRAINT "OrgShareSeen_shareId_fkey" FOREIGN KEY ("shareId") REFERENCES "OrgShare"("id") ON DELETE CASCADE ON UPDATE CASCADE
);

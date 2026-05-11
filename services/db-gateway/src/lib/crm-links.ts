// Workstream C — helpers around the CompanyCrmLink + CompanyCrmCache
// tables. Pure pg.Pool SQL; no Prisma client at runtime (the gateway
// only uses Prisma for schema + migrations — see lib/producer-pools.ts
// for the actual pool plumbing).
//
// Tables:
//   - CompanyCrmLink:  confirmed bindings AVA companyId ↔ CRM external id.
//   - CompanyCrmCache: opportunistic JSON cache of the enriched payload.

import { randomBytes } from "node:crypto";
import type { Pool } from "pg";

export type CrmType = "HUBSPOT" | "SALESFORCE" | "DYNAMICS";

export type ConfirmedSource =
  | "EXACT_MATCH"
  | "USER_CONFIRMED"
  | "MANUAL_LINK"
  | "SINGLE_IMPORT";

export interface CompanyCrmLinkRow {
  crmType: CrmType;
  crmExternalId: string;
  crmDisplayName: string | null;
  confirmedAt: Date;
  confirmedSource: ConfirmedSource;
  lastSyncedAt: Date | null;
}

/**
 * Map the desktop's lowercase provider strings to the gateway's
 * enum-cased CrmType. Used by import + read routes alike.
 */
export function toCrmType(value: string): CrmType | null {
  switch (value.toLowerCase()) {
    case "hubspot":
      return "HUBSPOT";
    case "salesforce":
      return "SALESFORCE";
    case "dynamics":
      return "DYNAMICS";
    default:
      return null;
  }
}

/**
 * Mint a small id without pulling in the Prisma client at runtime.
 * Prisma's default(cuid()) handles inserts via Prisma Migrate; we use
 * raw inserts here so a parallel id helper keeps the schema's id
 * column NOT NULL.
 */
function newId(): string {
  return "ccl_" + randomBytes(12).toString("hex");
}

/**
 * Upsert one CompanyCrmLink. Last-write-wins on the unique key
 * (tenantId, companyId, crmType): we replace `crmExternalId`,
 * `crmDisplayName`, `confirmedSource` and bump `confirmedAt` on
 * every call. This means re-importing under HubSpot with a new id
 * (e.g. the user reset their portal) cleanly migrates the binding.
 */
export async function upsertCrmLink(
  pool: Pool,
  args: {
    tenantId: string;
    companyId: string;
    crmType: CrmType;
    crmExternalId: string;
    crmDisplayName?: string | null;
    confirmedSource: ConfirmedSource;
  },
): Promise<void> {
  await pool.query(
    `INSERT INTO "CompanyCrmLink"
       ("id", "tenantId", "companyId", "crmType", "crmExternalId",
        "crmDisplayName", "confirmedSource",
        "confirmedAt", "createdAt", "updatedAt")
     VALUES ($1, $2, $3, $4::"CrmType", $5, $6, $7::"ConfirmedSource",
             NOW(), NOW(), NOW())
     ON CONFLICT ("tenantId", "companyId", "crmType") DO UPDATE
       SET "crmExternalId"   = EXCLUDED."crmExternalId",
           "crmDisplayName"  = EXCLUDED."crmDisplayName",
           "confirmedSource" = EXCLUDED."confirmedSource",
           "confirmedAt"     = NOW(),
           "updatedAt"       = NOW()`,
    [
      newId(),
      args.tenantId,
      args.companyId,
      args.crmType,
      args.crmExternalId,
      args.crmDisplayName ?? null,
      args.confirmedSource,
    ],
  );
}

/** List all CRM links for one (tenant, company). Empty when none. */
export async function listCrmLinks(
  pool: Pool,
  args: { tenantId: string; companyId: string },
): Promise<CompanyCrmLinkRow[]> {
  const res = await pool.query<{
    crmType: CrmType;
    crmExternalId: string;
    crmDisplayName: string | null;
    confirmedAt: Date;
    confirmedSource: ConfirmedSource;
    lastSyncedAt: Date | null;
  }>(
    `SELECT "crmType", "crmExternalId", "crmDisplayName",
            "confirmedAt", "confirmedSource", "lastSyncedAt"
       FROM "CompanyCrmLink"
      WHERE "tenantId" = $1 AND "companyId" = $2
      ORDER BY "crmType"`,
    [args.tenantId, args.companyId],
  );
  return res.rows;
}

/** Stamp lastSyncedAt after a successful CRM-side fetch. */
export async function markCrmLinkSynced(
  pool: Pool,
  args: {
    tenantId: string;
    companyId: string;
    crmType: CrmType;
  },
): Promise<void> {
  await pool.query(
    `UPDATE "CompanyCrmLink"
        SET "lastSyncedAt" = NOW(), "updatedAt" = NOW()
      WHERE "tenantId" = $1 AND "companyId" = $2 AND "crmType" = $3::"CrmType"`,
    [args.tenantId, args.companyId, args.crmType],
  );
}

/**
 * Look up a single cached enrichment payload. Returns `null` when no
 * row exists; caller decides whether the row's `fetchedAt` is fresh
 * enough.
 */
export async function getCrmCache(
  pool: Pool,
  args: { tenantId: string; companyId: string; crmType: CrmType },
): Promise<{ payload: unknown; fetchedAt: Date } | null> {
  const res = await pool.query<{ payload: unknown; fetchedAt: Date }>(
    `SELECT "payload", "fetchedAt"
       FROM "CompanyCrmCache"
      WHERE "tenantId" = $1 AND "companyId" = $2 AND "crmType" = $3::"CrmType"`,
    [args.tenantId, args.companyId, args.crmType],
  );
  if (!res.rowCount) return null;
  return res.rows[0]!;
}

/** Overwrite the cache row (insert or replace). */
export async function putCrmCache(
  pool: Pool,
  args: {
    tenantId: string;
    companyId: string;
    crmType: CrmType;
    payload: unknown;
  },
): Promise<void> {
  await pool.query(
    `INSERT INTO "CompanyCrmCache"
       ("id", "tenantId", "companyId", "crmType", "payload", "fetchedAt")
     VALUES ($1, $2, $3, $4::"CrmType", $5::jsonb, NOW())
     ON CONFLICT ("tenantId", "companyId", "crmType") DO UPDATE
       SET "payload"   = EXCLUDED."payload",
           "fetchedAt" = NOW()`,
    [
      "ccc_" + randomBytes(12).toString("hex"),
      args.tenantId,
      args.companyId,
      args.crmType,
      JSON.stringify(args.payload),
    ],
  );
}

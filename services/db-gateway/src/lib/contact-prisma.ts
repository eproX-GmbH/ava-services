// Gateway-side Prisma client for the `ava_company_contact` MPG schema
// (§8.v3 Phase 3). The reconciliation logic vendored in
// `lib/contact-extraction/` runs against this client.
//
// Derived URL: same MPG cluster, same auth, the database segment
// swapped to `ava_company_contact`. Mirrors the producer-pools
// convention so we don't need a new secret. The gateway already has
// DATABASE_URL pointing at its own audit DB on the cluster; we
// rewrite the pathname.
//
// Lazy + singleton — most gateway requests don't trigger contact
// reconciliation, so we don't pay the prisma engine startup cost
// until the first persist event arrives.

import { PrismaClient } from "../../generated/company-contact-client";
import { loadEnv } from "./env";
import { logger } from "./logger";

const TARGET_DB = "ava_company_contact";

let client: PrismaClient | undefined;

function buildContactDbUrl(envUrl: string): string {
  const u = new URL(envUrl);
  u.pathname = `/${TARGET_DB}`;
  // Conservative pool sizing — reconciliation work is bursty and
  // shares the cluster's pgbouncer cap with the persist-bus pools.
  u.searchParams.set("connection_limit", "4");
  u.searchParams.set("pool_timeout", "20");
  return u.toString();
}

export function getContactPrismaClient(): PrismaClient {
  if (client) return client;
  const env = loadEnv();
  const url = buildContactDbUrl(env.DATABASE_URL);
  // Prisma reads from env vars referenced in schema.prisma — set them
  // here so the client picks them up. Both URLs point at the same
  // database, the directUrl is only needed for migrations (we never
  // run prisma migrate against this client).
  process.env.COMPANY_CONTACT_DATABASE_URL = url;
  process.env.COMPANY_CONTACT_DIRECT_URL = env.DIRECT_URL
    ? buildContactDbUrl(env.DIRECT_URL)
    : url;
  client = new PrismaClient();
  logger.info({ db: TARGET_DB }, "company-contact prisma client connected");
  return client;
}

// Per-producer database URL derivation.
//
// The gateway's own DATABASE_URL points at its audit database on the
// shared fly MPG cluster. Every producer's database lives on the same
// cluster (same host/auth/port) — only the database segment differs.
// Both the local-amqp credential handout and the persist-bus consumer
// use the URLs computed here; lifted out of `routes/v1/local-amqp.ts`
// in §8.v3 (gateway persist consolidation) so non-route code can also
// reach them.

import { loadEnv } from "./env";

/**
 * Per-producer database name on the shared MPG cluster. Mirrors
 * `services/desktop/src/main/index.ts`'s PRODUCER_REGISTRY. When a
 * new producer is added there, mirror it here.
 */
export const PRODUCER_DATABASE_NAMES: Record<string, string> = {
  "company-profile": "ava_company_profile",
  "structured-content": "ava_structured_content",
  "company-publication": "ava_company_publication",
  "company-evaluation": "ava_company_evaluation",
  "company-contact": "ava_company_contact",
};

export type ProducerName = keyof typeof PRODUCER_DATABASE_NAMES;

/** Producer keys in registry order — convenient for iteration. */
export const PRODUCER_NAMES: readonly ProducerName[] = Object.keys(
  PRODUCER_DATABASE_NAMES,
) as ProducerName[];

/**
 * Build per-producer DATABASE_URLs from the gateway's own DATABASE_URL.
 * The MPG cluster + auth + host are shared; only the database segment
 * differs.
 *
 * The `connection_limit` / `pool_timeout` pair caps each consumer's
 * pool so 5 producers × pool_size + the gateway's own audit pool stay
 * under the cluster's pgbouncer limit.
 */
export function buildProducerDatabaseUrls(): Record<ProducerName, string> {
  const env = loadEnv();
  const result = {} as Record<ProducerName, string>;
  let parsed: URL;
  try {
    parsed = new URL(env.DATABASE_URL);
  } catch {
    return result;
  }
  for (const producer of PRODUCER_NAMES) {
    parsed.pathname = `/${PRODUCER_DATABASE_NAMES[producer]}`;
    parsed.searchParams.set("connection_limit", "2");
    parsed.searchParams.set("pool_timeout", "20");
    result[producer] = parsed.toString();
  }
  return result;
}

/**
 * Single-producer URL helper — used by the persist-bus to lazily
 * construct a `pg.Pool` per producer on first event arrival.
 */
export function buildProducerDatabaseUrl(producer: ProducerName): string {
  return buildProducerDatabaseUrls()[producer];
}

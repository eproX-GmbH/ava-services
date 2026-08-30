// §8.v3-Rewire — BestMatchJob-Anlage + Compute-Dispatch.
//
// Der Schreibpfad läuft jetzt asynchron OHNE die zerstoerte Fly-App:
//   1. Gateway legt die Job-Zeile an (status "queued") → 202 {bestMatchJobId}
//   2. Gateway publiziert tenant.compute.evaluation.v1 auf die
//      Nutzer-Queue (Muster retry-publish.ts)
//   3. Der lokale company-evaluation compute-worker rechnet (LLM +
//      Embeddings lokal, BM25 statt Elasticsearch) und schreibt
//      Ergebnis + Status zurueck in ava_company_evaluation.
//
// Die Spalten status/errorMessage/userId existieren im Prisma-Schema
// des Producers bewusst NICHT (kein Migrations-Tanz) — lazy ALTER hier,
// Producer schreibt sie per $executeRaw. userId schliesst zugleich die
// Ownership-Luecke fuer transaktionslose Offer-Analysis-Jobs.

import { randomUUID } from "node:crypto";
import type { Pool } from "pg";
import type { CloudEvent } from "@ava/event";
import { loadEnv } from "./env";
import { getGatewayAmqpPublisher } from "./amqp-publisher";
import { targetUserRoutingKey } from "./per-user-routing";

let columnsReady = false;

export async function ensureBestMatchJobColumns(pool: Pool): Promise<void> {
  if (columnsReady) return;
  await pool.query(`
    ALTER TABLE "BestMatchJob" ADD COLUMN IF NOT EXISTS "status" TEXT;
    ALTER TABLE "BestMatchJob" ADD COLUMN IF NOT EXISTS "errorMessage" TEXT;
    ALTER TABLE "BestMatchJob" ADD COLUMN IF NOT EXISTS "userId" TEXT;
  `);
  columnsReady = true;
}

export interface EvaluationComputePayload {
  kind: "best-match" | "offer-analysis";
  bestMatchJobId: string;
  tenantId: string;
  userId: string;
  input?: string;
  companyIds?: string[];
  topics?: string[];
  transactionId?: string | null;
  offer?: string;
  topK?: number;
}

export async function createBestMatchJob(
  pool: Pool,
  args: {
    input: string;
    transactionId: string | null;
    /** 0 = Vorgangs-Best-Match, 1 = globale Offer-Analysis (Legacy-Marker). */
    v: number;
    userId: string;
  },
): Promise<string> {
  await ensureBestMatchJobColumns(pool);
  const id = randomUUID();
  await pool.query(
    `INSERT INTO "BestMatchJob"
       (id, input, "transactionId", v, "status", "userId", "createdAt", "updatedAt")
     VALUES ($1, $2, $3, $4, 'queued', $5, NOW(), NOW())`,
    [id, args.input.slice(0, 20_000), args.transactionId, args.v, args.userId],
  );
  return id;
}

export async function markBestMatchJobFailed(
  pool: Pool,
  id: string,
  errorMessage: string,
): Promise<void> {
  await pool.query(
    `UPDATE "BestMatchJob"
        SET "status" = 'failed', "errorMessage" = $2, "updatedAt" = NOW()
      WHERE id = $1`,
    [id, errorMessage.slice(0, 500)],
  );
}

/** Compute-Auftrag auf die per-User-Queue publizieren. Wirft bei
 *  Broker-Problemen — der Aufrufer markiert den Job dann als failed. */
export async function publishEvaluationCompute(
  payload: EvaluationComputePayload,
): Promise<void> {
  const env = loadEnv();
  const client = await getGatewayAmqpPublisher();
  // Handgebautes CloudEvent: die tenant.*-Familie ist bewusst NICHT im
  // @ava/event-Generator registriert; der Consumer liest sie roh
  // (gleiches Muster wie der persist-bus).
  const event = {
    specversion: "1.0",
    id: randomUUID(),
    type: "tenant.compute.evaluation.v1",
    source: "db-gateway",
    time: new Date().toISOString(),
    data: payload,
  } as unknown as CloudEvent<never>;
  await client.publish(
    env.EVENT_BUS_EXCHANGE,
    targetUserRoutingKey(event, payload.userId),
  );
}

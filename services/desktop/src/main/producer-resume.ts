// Resume sweep for stuck producer stages on app start.
//
// Problem: when the desktop app exits mid-pipeline (crash, update, user
// closes the window) any (transactionId, companyId, stage) cell that was
// in `pending` or `in_progress` never restarts on the next launch. The
// renderer renders a yellow status dot forever because no AMQP trigger
// event is ever republished.
//
// Fix: after the producer supervisors are healthy and AMQP creds are
// fetched, walk recent transactions, find every stage cell stuck in
// pending / in_progress, and POST the same `/retry` endpoint the agent's
// `retry_stage` tool and the freshness-scheduler call. The endpoint is
// idempotent — the persist-bus tier-gate protects against bad writes —
// so re-running a stage from the beginning is safe even if it was
// partway done.

import { randomUUID } from "node:crypto";
import type { GatewayClient } from "./agent/gateway-client";

/**
 * Stages we will resume. Mirrors `RetryStage` in the gateway's schemas
 * (`services/db-gateway/src/routes/v1/schemas.ts`). `masterData` is
 * derived from downstream presence (see pipeline route) — it's never
 * directly retryable, so we omit it.
 */
const RESUMABLE_STAGES = [
  "structuredContent",
  "companyPublication",
  "website",
  "companyProfile",
  "companyContact",
  "companyEvaluation",
] as const;

type Stage = (typeof RESUMABLE_STAGES)[number];

const STUCK_STATES = new Set(["pending", "in_progress"]);

/** v0.1.360 — Stage → Producer-Name (= kebab-case der Stage = das
 *  resources/producers/<name>/-Verzeichnis). Wird gebraucht, um den
 *  Producer zu RESTARTEN, der eine festhängende Stage besitzt. */
const STAGE_TO_PRODUCER: Record<Stage, string> = {
  structuredContent: "structured-content",
  companyPublication: "company-publication",
  website: "website",
  companyProfile: "company-profile",
  companyContact: "company-contact",
  companyEvaluation: "company-evaluation",
};

/** Sanity bound: ignore transactions older than this. */
const MAX_AGE_MS = 7 * 24 * 60 * 60 * 1000;
/** Don't double-launch a row that just started transitioning. */
const RECENT_UPDATE_GUARD_MS = 60 * 1000;
/**
 * v0.1.360 — Eine Stage, die SO lange in `in_progress` festhängt, gilt als
 * "verklemmter Producer" (lebt, konsumiert aber kein AMQP mehr / Compute
 * eingefroren). Re-Dispatch allein hilft dann nicht — der Producer muss
 * neu gestartet werden, damit ein frischer AMQP-Consumer das (re-published)
 * Event abholt. Großzügig bemessen, damit ein langsamer, aber echt
 * arbeitender Producer (großer LLM-Call) nicht abgewürgt wird.
 */
const STALE_IN_PROGRESS_RESTART_MS = 10 * 60 * 1000;
/** Pull a generous window of recent transactions to scan. */
const TRANSACTIONS_PAGE_SIZE = 50;
/** Inter-call pacing so we don't hammer the gateway on a big sweep. */
const RETRY_SPACING_MS = 200;

interface TxRow {
  id?: string;
  transactionId?: string;
  createdAt?: string;
}

interface PipelineCell {
  state?: string;
  updatedAt?: string | null;
}

interface PipelineRow {
  companyId?: string;
  cells?: Partial<Record<Stage | "masterData", PipelineCell>>;
}

interface PipelineResp {
  rows?: PipelineRow[];
}

export interface ResumeStuckStagesDeps {
  gateway: GatewayClient;
  /** Optional logger; defaults to console. */
  logger?: { info: (...a: unknown[]) => void; warn: (...a: unknown[]) => void; debug?: (...a: unknown[]) => void };
  /**
   * v0.1.360 — Restartet den lokalen Producer-Subprozess mit diesem Namen
   * (stop+start). Wird aufgerufen, wenn eine Stage zu lange in
   * `in_progress` festhängt (verklemmter Producer). Ohne Restart bringt
   * der Re-Dispatch nichts, weil ein wedged Producer das AMQP-Event nicht
   * konsumiert. Optional — beim Boot weggelassen (Producer starten dort
   * ohnehin frisch).
   */
  restartProducer?: (producerName: string) => Promise<void>;
}

export interface ResumeStuckStagesResult {
  transactionsScanned: number;
  resumed: number;
  failed: number;
  restartedProducers: string[];
  byStage: Partial<Record<Stage, number>>;
}

function pickTxId(t: TxRow): string | null {
  return t.id ?? t.transactionId ?? null;
}

function isStuck(cell: PipelineCell | undefined): boolean {
  if (!cell || typeof cell.state !== "string") return false;
  return STUCK_STATES.has(cell.state);
}

function isRecentlyUpdated(cell: PipelineCell, now: number): boolean {
  if (!cell.updatedAt) return false;
  const t = Date.parse(cell.updatedAt);
  if (Number.isNaN(t)) return false;
  return now - t < RECENT_UPDATE_GUARD_MS;
}

/**
 * Walk recent transactions, find stuck (pending / in_progress) stage cells,
 * and re-trigger them via `POST /v1/transactions/:tid/entities/:cid/retry`.
 * Best-effort: a single failure never blocks the rest of the sweep.
 */
export async function resumeStuckStages(
  deps: ResumeStuckStagesDeps,
): Promise<ResumeStuckStagesResult> {
  const log = deps.logger ?? {
    info: (...a: unknown[]) => console.log("[producer-resume]", ...a),
    warn: (...a: unknown[]) => console.warn("[producer-resume]", ...a),
    debug: (...a: unknown[]) => console.log("[producer-resume:debug]", ...a),
  };
  const result: ResumeStuckStagesResult = {
    transactionsScanned: 0,
    resumed: 0,
    failed: 0,
    restartedProducers: [],
    byStage: {},
  };
  /** Producer, die eine zu-lange-in_progress-Stage besitzen → Restart. */
  const staleProducers = new Set<string>();

  // 1. List recent transactions. The gateway list endpoint sorts
  // newest-first and doesn't filter by status, so we pull a window
  // and filter client-side.
  let txList: { items?: TxRow[] };
  try {
    txList = await deps.gateway.request<{ items?: TxRow[] }>(
      "/v1/transactions",
      { query: { page: 1, pageSize: TRANSACTIONS_PAGE_SIZE } },
    );
  } catch (err) {
    log.warn(
      "transaction list fetch failed; skipping resume sweep:",
      err instanceof Error ? err.message : err,
    );
    return result;
  }

  const now = Date.now();
  const txs = (txList.items ?? []).filter((t) => {
    const id = pickTxId(t);
    if (!id) return false;
    if (!t.createdAt) return true; // no timestamp — be permissive
    const created = Date.parse(t.createdAt);
    if (Number.isNaN(created)) return true;
    return now - created <= MAX_AGE_MS;
  });

  if (txs.length === 0) {
    log.info("no recent transactions to scan");
    return result;
  }

  // 2. For each transaction, fetch the per-company × per-stage
  // pipeline matrix. The pipeline endpoint already inlines per-stage
  // state for every company in the transaction so we don't need a
  // second hop.
  interface ResumeJob {
    transactionId: string;
    companyId: string;
    stage: Stage;
  }
  const jobs: ResumeJob[] = [];

  for (const tx of txs) {
    const transactionId = pickTxId(tx);
    if (!transactionId) continue;
    let pipeline: PipelineResp;
    try {
      pipeline = await deps.gateway.request<PipelineResp>(
        `/v1/transactions/${encodeURIComponent(transactionId)}/pipeline`,
      );
    } catch (err) {
      log.warn(
        `pipeline fetch failed for ${transactionId}:`,
        err instanceof Error ? err.message : err,
      );
      continue;
    }
    result.transactionsScanned += 1;
    for (const row of pipeline.rows ?? []) {
      const companyId = row.companyId;
      if (!companyId || !row.cells) continue;
      for (const stage of RESUMABLE_STAGES) {
        const cell = row.cells[stage];
        if (!isStuck(cell)) continue;
        // 60s guard: if the row is currently transitioning don't
        // double-launch it. Skipped naturally for `pending` cells
        // with no updatedAt.
        if (cell && isRecentlyUpdated(cell, now)) continue;
        // v0.1.360 — Stage hängt lange in `in_progress`? Dann ist der
        // Producer vermutlich verklemmt (lebt, konsumiert aber kein AMQP
        // mehr). Owner-Producer für einen Restart vormerken — sonst holt
        // niemand das gleich re-dispatchte Event ab.
        if (cell && cell.state === "in_progress" && cell.updatedAt) {
          const ts = Date.parse(cell.updatedAt);
          if (!Number.isNaN(ts) && now - ts >= STALE_IN_PROGRESS_RESTART_MS) {
            staleProducers.add(STAGE_TO_PRODUCER[stage]);
          }
        }
        jobs.push({ transactionId, companyId, stage });
      }
    }
  }

  if (jobs.length === 0) {
    log.info(
      `scanned ${result.transactionsScanned} transaction(s); no stuck stages to resume`,
    );
    return result;
  }

  // v0.1.360 — Verklemmte Producer ZUERST neu starten, BEVOR wir
  // re-dispatchen. Ein wedged Producer (lebt, konsumiert aber kein AMQP)
  // ignoriert sonst das re-published Event und die Stage bleibt ewig
  // `in_progress` (gemeldeter „Pipeline komplett eingefroren"-Bug). Ein
  // Neustart bringt einen frischen AMQP-Consumer hoch, der das gleich
  // folgende Retry-Event abholt.
  if (deps.restartProducer && staleProducers.size > 0) {
    for (const name of staleProducers) {
      try {
        await deps.restartProducer(name);
        result.restartedProducers.push(name);
        log.info(`restarted wedged producer '${name}' (stale in_progress stage)`);
      } catch (err) {
        log.warn(
          `restart of producer '${name}' failed:`,
          err instanceof Error ? err.message : err,
        );
      }
    }
  }

  // 3. Dispatch retries sequentially with a small inter-call delay.
  // Body shape matches the freshness-scheduler defaultDispatch (and
  // the agent's retry_stage tool) — `{ stage }` plus a fresh
  // idempotency key so the gateway dedupe doesn't collapse this
  // sweep against any concurrent manual retry.
  for (let i = 0; i < jobs.length; i++) {
    const job = jobs[i];
    if (!job) continue;
    try {
      await deps.gateway.request(
        `/v1/transactions/${encodeURIComponent(job.transactionId)}/entities/${encodeURIComponent(job.companyId)}/retry`,
        {
          method: "POST",
          body: { stage: job.stage },
          idempotencyKey: randomUUID(),
        },
      );
      result.resumed += 1;
      result.byStage[job.stage] = (result.byStage[job.stage] ?? 0) + 1;
      log.debug?.(
        `resumed ${job.stage} for ${job.transactionId}/${job.companyId}`,
      );
    } catch (err) {
      result.failed += 1;
      log.warn(
        `retry POST failed for ${job.transactionId}/${job.companyId}/${job.stage}:`,
        err instanceof Error ? err.message : err,
      );
    }
    if (i < jobs.length - 1) {
      await new Promise<void>((resolve) =>
        setTimeout(resolve, RETRY_SPACING_MS),
      );
    }
  }

  log.info(
    `resume sweep complete: scanned ${result.transactionsScanned} tx, resumed ${result.resumed} stage(s), failed ${result.failed}; byStage=${JSON.stringify(result.byStage)}`,
  );
  return result;
}

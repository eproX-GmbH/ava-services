import {
  AMQPClient,
  EventTypeContext,
  EventTypeOperation,
  type CloudEvent,
  type TransactionProgressPayload,
} from "@ava/event";

import { loadEnv } from "./env";
import { logger } from "./logger";
import { getGatewayPool } from "./producer-pools";

// EntityProgress write helper, isolated here so the event-bus can
// persist incoming transaction.progress states alongside the SSE
// dispatch. Without this, producer-side failures (state="failed"
// emitted from a compute-worker catch handler) only flow over SSE —
// they never land in the DB. The snapshot endpoint reads the DB on
// every page load, so reloading the app would show those cells as
// `pending` (the seeded value) instead of `failed`. Persist-bus
// already writes the DB on its own apply path; this covers the
// non-persist paths (in_progress, producer-side failed/skipped).
//
// Best-effort: a transient DB hiccup logs but doesn't block SSE
// dispatch. Last-write-wins via the EXCLUDED.updatedAt > existing
// guard, so out-of-order arrivals are safe.
async function writeEntityProgressFromEvent(
  payload: TransactionProgressPayload,
): Promise<void> {
  if (!payload?.transactionId || !payload?.companyId || !payload?.service) {
    return;
  }
  const acceptedStates = new Set(["completed", "failed", "skipped", "in_progress"]);
  const state = payload.state as string;
  if (!acceptedStates.has(state)) return;
  const truncated = payload.errorMessage
    ? payload.errorMessage.slice(0, 500)
    : null;
  try {
    const pool = getGatewayPool();
    await pool.query(
      `INSERT INTO "EntityProgress"
         ("transactionId", "companyId", producer, state, "errorMessage",
          "updatedAt", "createdAt")
       VALUES ($1, $2, $3, $4, $5, NOW(), NOW())
       ON CONFLICT ("transactionId", "companyId", producer) DO UPDATE
       SET state = EXCLUDED.state,
           "errorMessage" = EXCLUDED."errorMessage",
           "updatedAt" = EXCLUDED."updatedAt"
       WHERE EXCLUDED."updatedAt" > "EntityProgress"."updatedAt"`,
      [
        payload.transactionId,
        payload.companyId,
        payload.service,
        state,
        truncated,
      ],
    );
  } catch (err) {
    logger.warn(
      {
        err: err instanceof Error ? err.message : String(err),
        transactionId: payload.transactionId,
        companyId: payload.companyId,
        service: payload.service,
        state,
      },
      "event-bus: entity-progress write failed",
    );
  }
}

// In-process fan-out for transaction.progress events.
//
// The gateway maintains a single AMQP connection bound to the shared
// "exchange" topic for `transaction.progress` events. Each SSE handler
// `subscribe()`s for a specific transactionId and gets only matching events.
//
// Tenant gating is the SSE handler's responsibility (it knows the caller's
// auth context). This module trusts whatever the producer puts on the bus.

type ProgressHandler = (payload: TransactionProgressPayload) => void;

class TransactionProgressBus {
  private client?: AMQPClient;
  private connecting?: Promise<void>;
  private handlers: Map<string, Set<ProgressHandler>> = new Map();

  /** Idempotent. First caller triggers connect; subsequent callers wait. */
  public async ensureConnected(): Promise<void> {
    if (this.client?.isConnected) return;
    if (this.connecting) return this.connecting;

    this.connecting = (async () => {
      const env = loadEnv();
      const client = new AMQPClient(env.EVENT_BUS_QUEUE);
      await client.connect(env.EVENT_BUS_URL);
      await client.assertExchange(env.EVENT_BUS_EXCHANGE);
      await client.assertQueue();
      await client.bindQueue(env.EVENT_BUS_EXCHANGE, "transaction.progress");

      const listener = client.getListener<TransactionProgressPayload>({
        context: EventTypeContext.TRANSACTION,
        operation: EventTypeOperation.PROGRESS,
      });
      listener.subscribe((event: CloudEvent<TransactionProgressPayload>, ack: () => void) => {
        try {
          // Dispatch SSE first — keeps the live matrix update path
          // tight even if the DB write below stalls. The persist
          // happens out-of-band; SSE subscribers never wait on it.
          this.dispatch(event.data);
          // Persist the state so a reload of the matrix shows the
          // same thing the live SSE just showed. Fire-and-forget;
          // the helper logs its own failures.
          void writeEntityProgressFromEvent(event.data);
        } catch (err) {
          logger.error({ err }, "transaction.progress dispatch failed");
        } finally {
          ack();
        }
      });

      this.client = client;
      logger.info(
        { exchange: env.EVENT_BUS_EXCHANGE, queue: env.EVENT_BUS_QUEUE },
        "event-bus subscribed to transaction.progress",
      );
    })();

    try {
      await this.connecting;
    } finally {
      this.connecting = undefined;
    }
  }

  private dispatch(payload: TransactionProgressPayload): void {
    if (!payload?.transactionId) return;
    const set = this.handlers.get(payload.transactionId);
    if (!set || set.size === 0) return;
    for (const h of set) {
      try {
        h(payload);
      } catch (err) {
        logger.error({ err, transactionId: payload.transactionId }, "progress handler threw");
      }
    }
  }

  /**
   * Locally inject a progress payload, bypassing AMQP. Used by the gateway
   * itself to synthesize events that don't have an obvious AMQP origin —
   * e.g. flipping a row to `in_progress` the moment the user clicks "Retry"
   * (DESKTOP_DATA_FLOW.md §6.2). Each producer's terminal-state event still
   * comes through AMQP normally; this is purely the immediate optimistic
   * update.
   *
   * In-process only: this stays inside one gateway process. With multiple
   * gateway replicas, the retry-receiver replica would dispatch but a
   * peer replica holding the SSE connection would not. Promote to AMQP if
   * we ever scale horizontally with sticky-less load balancing.
   */
  public publishLocal(payload: TransactionProgressPayload): void {
    this.dispatch(payload);
  }

  /** Returns an unsubscribe function. Caller MUST invoke it on disconnect. */
  public subscribe(transactionId: string, handler: ProgressHandler): () => void {
    let set = this.handlers.get(transactionId);
    if (!set) {
      set = new Set();
      this.handlers.set(transactionId, set);
    }
    set.add(handler);
    return () => {
      const s = this.handlers.get(transactionId);
      if (!s) return;
      s.delete(handler);
      if (s.size === 0) this.handlers.delete(transactionId);
    };
  }
}

export const transactionProgressBus = new TransactionProgressBus();

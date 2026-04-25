import {
  AMQPClient,
  EventTypeContext,
  EventTypeOperation,
  type CloudEvent,
  type TransactionProgressPayload,
} from "@ava/event";

import { loadEnv } from "./env";
import { logger } from "./logger";

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
          this.dispatch(event.data);
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

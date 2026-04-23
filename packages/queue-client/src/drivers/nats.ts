import type { CloudEvent, EventPayload, EventType } from "@ava/event";
import type { QueueClient, QueueListener, QueueListenerHandler } from "../types";

// NATS JetStream driver — skeleton only.
// Planned mapping (DECISIONS.md D1):
//   RabbitMQ exchange (topic)  → JetStream stream with subject `<exchange>.>`
//   Routing key `a.b.c`        → subject `<exchange>.a.b.c`
//   Durable queue `<name>`     → durable consumer `<name>` on the stream
//   prefetch(1) + manual ack   → consumer config `max_ack_pending=1`, AckExplicit
//
// Implementation will use `@nats-io/nats-core` + `@nats-io/jetstream`.
// Until we actually bundle NATS in the Electron build, any code path that
// hits this class throws so the mistake is loud.

const NOT_IMPLEMENTED = "NATS driver not implemented yet — set QUEUE_DRIVER=rabbitmq.";

class NATSListener<T extends EventPayload | undefined> implements QueueListener<T> {
  subscribe(_handler: QueueListenerHandler<T>): void {
    throw new Error(NOT_IMPLEMENTED);
  }
}

export class NATSClient implements QueueClient {
  readonly isConnected = false;

  async connect(_url: string): Promise<QueueClient> {
    throw new Error(NOT_IMPLEMENTED);
  }
  async assertExchange(_exchange: string): Promise<void> {
    throw new Error(NOT_IMPLEMENTED);
  }
  async assertQueue(_queue?: string): Promise<void> {
    throw new Error(NOT_IMPLEMENTED);
  }
  async bindQueue(_exchange: string, _key: string, _queue?: string): Promise<void> {
    throw new Error(NOT_IMPLEMENTED);
  }
  async publish(_exchange: string, _event: CloudEvent<any>): Promise<void> {
    throw new Error(NOT_IMPLEMENTED);
  }
  getListener<T extends EventPayload>(_type: EventType): QueueListener<T> {
    return new NATSListener<T>();
  }
}

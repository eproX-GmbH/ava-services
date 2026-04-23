import type { CloudEvent, EventPayload, EventType } from "@ava/event";

export type QueueListenerHandler<T extends EventPayload | undefined> = (
  event: CloudEvent<T>,
  ack: () => void,
) => void;

export interface QueueListener<T extends EventPayload | undefined> {
  subscribe(handler: QueueListenerHandler<T>): void;
}

export interface QueueClient {
  readonly isConnected: boolean;
  connect(url: string): Promise<QueueClient>;
  assertExchange(exchange: string): Promise<void>;
  assertQueue(queue?: string): Promise<void>;
  bindQueue(exchange: string, key: string, queue?: string): Promise<void>;
  publish(exchange: string, event: CloudEvent<any>): Promise<void>;
  getListener<T extends EventPayload>(type: EventType): QueueListener<T>;
}

export type QueueDriver = "rabbitmq" | "nats";

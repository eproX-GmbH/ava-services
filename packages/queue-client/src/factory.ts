import { RabbitMQClient } from "./drivers/rabbitmq";
import { NATSClient } from "./drivers/nats";
import type { QueueClient, QueueDriver } from "./types";

export function makeQueueClient(
  name?: string,
  driver: QueueDriver = (process.env.QUEUE_DRIVER as QueueDriver) || "rabbitmq",
): QueueClient {
  switch (driver) {
    case "nats":
      return new NATSClient();
    case "rabbitmq":
      return new (RabbitMQClient as any)(name) as QueueClient;
    default:
      throw new Error(`Unknown QUEUE_DRIVER: ${driver}`);
  }
}

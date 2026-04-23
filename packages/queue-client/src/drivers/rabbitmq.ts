import { AMQPClient } from "@ava/event";

// AMQPClient already matches the QueueClient surface structurally.
// We don't `implements QueueClient` here because @ava/event's published .d.ts
// files contain unresolved `@/...` path aliases (not rewritten at build time),
// so consumers see AMQPClient with missing method types. The factory casts
// to QueueClient at the boundary.
export class RabbitMQClient extends AMQPClient {}

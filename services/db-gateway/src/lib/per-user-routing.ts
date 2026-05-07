// v0.1.53 — per-user AMQP routing helper for gateway-side retry
// publishes (lib/retry-publish.ts). Mirrors the master-data helper
// at master-data/src/infrastructure/events/per-user-routing.ts so
// downstream producer queues can be bound per-user.
//
// Suffixes the userId to the event's routing-key (event.type) so AMQP
// delivers it to that user's bound queue. Returns a NEW event so the
// caller's reference (typically held by the EventBuilder) is not
// mutated.

import type { CloudEvent } from "@ava/event";

export function targetUserRoutingKey<T>(
  event: CloudEvent<T>,
  userId: string,
): CloudEvent<T> {
  if (!userId) {
    return event;
  }
  return {
    ...event,
    type: `${event.type}.${userId}` as typeof event.type,
  };
}

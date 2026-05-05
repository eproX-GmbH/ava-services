// Shared persist-event payload type. Lives in its own module so
// `lib/contact-extraction-apply.ts` (lazy-imported by persist-bus.ts)
// doesn't pull persist-bus.ts back at import time.

export interface PersistEvent<TResult = unknown> {
  runId: string;
  tenantId: string;
  dispatchedAt: string;
  computedAt: string;
  result: TResult;
}

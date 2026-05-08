// v0.1.62 — tier-aware persist (gateway side).
//
// Mirror of `tierShouldWrite()` from packages/ai-provider/src/index.ts.
// Inlined here because the gateway doesn't depend on @ava/ai-provider
// (the catalog metadata is producer-side concern; the gateway only
// receives a tier integer in each persist event and compares).
//
// IF YOU CHANGE THE COMPARISON RULES — keep this file in sync with
// the ai-provider helper. The producer-side and gateway-side gates
// must agree, otherwise we get oscillation (producer says skip,
// gateway says write, producer skips next time, etc.). A future
// follow-up could extract this into a shared workspace package
// — for now it's small enough that copy-paste-with-comments is
// the right trade-off.

export type ModelTier = 1 | 2 | 3 | 4;

const THIRTY_DAYS_MS = 30 * 24 * 60 * 60 * 1000;

/**
 * Decide whether an incoming write should replace an existing row.
 *
 * Inputs (see /MODEL_TIERS.md for the canonical rubric):
 *   incomingTier  — tier of the LLM that produced this write, or
 *                   null for non-LLM stages (structured-content,
 *                   publication)
 *   existingTier  — tier of the LLM that produced the existing row;
 *                   null for non-LLM stages OR if no row exists
 *   existingAgeMs — age of the existing row; pass Infinity when no
 *                   row exists
 *
 * Returns `{ write, reason }`. The `reason` string is the audit-log
 * line — it's surfaced in `recordEntityProgress` (state="skipped",
 * errorMessage=reason) so users see "downgrade refused: tier 1 < 4"
 * on the matrix instead of a vague "skipped".
 */
export function tierShouldWrite(args: {
  incomingTier: ModelTier | null;
  existingTier: ModelTier | null;
  existingAgeMs: number;
}): { write: boolean; reason: string } {
  const { incomingTier, existingTier, existingAgeMs } = args;
  if (existingAgeMs === Infinity) {
    return { write: true, reason: "no existing row" };
  }
  if (incomingTier === null && existingTier === null) {
    if (existingAgeMs > THIRTY_DAYS_MS) {
      return { write: true, reason: "non-LLM stage, existing > 30 days" };
    }
    return { write: false, reason: "non-LLM stage, fresh (≤ 30 days)" };
  }
  if (incomingTier === null) {
    return {
      write: false,
      reason:
        "incoming tier missing (producer misconfigured); refusing to overwrite",
    };
  }
  if (existingTier === null) {
    return { write: true, reason: "upgrading from untiered existing row" };
  }
  if (incomingTier > existingTier) {
    return {
      write: true,
      reason: `upgrade: tier ${incomingTier} > ${existingTier}`,
    };
  }
  if (incomingTier < existingTier) {
    return {
      write: false,
      reason: `downgrade refused: tier ${incomingTier} < ${existingTier}`,
    };
  }
  if (existingAgeMs > THIRTY_DAYS_MS) {
    return {
      write: true,
      reason: `same tier (${incomingTier}), existing > 30 days`,
    };
  }
  return {
    write: false,
    reason: `same tier (${incomingTier}), fresh (≤ 30 days)`,
  };
}

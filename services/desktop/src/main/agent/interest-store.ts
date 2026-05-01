// InterestStore (Phase 8.r4 — recent-interest boost).
//
// In-memory ring buffer of recently-touched companyIds. The renderer
// signals interest through two channels:
//   - CompanyDetail mount (the analyst opened the page)
//   - Chat company-link click (`[Foo GmbH](company:FOO123)` clicked)
//
// The freshness scheduler reads the latest touch timestamp via
// `getBoost(companyId, now)` and folds the result into the score
// formula. Companies the user just looked at sort to the top of the
// queue without needing an explicit pin.
//
// Why memory only: the buffer is a per-session attention signal, not a
// preference the user expects to persist. Restart resets the boost to
// zero — that's the right default; the user can pin-and-stay if they
// want lasting priority.
//
// Decay model: linear from 1.0 at the moment of touch to 0.0 at
// `BOOST_TTL_DAYS`. Anything older than the window contributes nothing.
// We DON'T stack multiple touches (a 5×-clicked company doesn't get
// a 5× boost) — saturation at 1.0 keeps the formula well-behaved
// against scenarios where a chat repeatedly references the same
// company in one turn.

const BOOST_TTL_DAYS = 14;
const BOOST_TTL_MS = BOOST_TTL_DAYS * 86_400_000;
const RING_CAPACITY = 200;

interface TouchEntry {
  companyId: string;
  /** Wall-clock ms of the most recent touch. */
  at: number;
}

export class InterestStore {
  private touches: Map<string, TouchEntry> = new Map();
  private readonly capacity: number;

  constructor(capacity = RING_CAPACITY) {
    this.capacity = capacity;
  }

  /**
   * Record a touch. Multiple touches for the same id keep only the
   * latest timestamp (Map mutation moves the key to the back of the
   * insertion order). When the map exceeds `capacity`, evict the
   * oldest-inserted key.
   */
  record(companyId: string, now: Date = new Date()): void {
    if (!companyId) return;
    // Re-insert (delete + set) so the LRU eviction below walks the
    // *touch* order, not the *first-seen* order.
    if (this.touches.has(companyId)) this.touches.delete(companyId);
    this.touches.set(companyId, { companyId, at: now.getTime() });
    if (this.touches.size > this.capacity) {
      const oldestKey = this.touches.keys().next().value;
      if (oldestKey !== undefined) this.touches.delete(oldestKey);
    }
  }

  /**
   * 0-1 boost for the freshness scheduler's score formula. 1.0 at the
   * moment of touch, decaying linearly to 0 over `BOOST_TTL_DAYS`.
   * 0 when the companyId has never been touched in this session.
   */
  getBoost(companyId: string, now: Date = new Date()): number {
    const entry = this.touches.get(companyId);
    if (!entry) return 0;
    const ageMs = now.getTime() - entry.at;
    if (ageMs < 0) return 1; // clock skew; treat as just-touched
    if (ageMs >= BOOST_TTL_MS) return 0;
    return 1 - ageMs / BOOST_TTL_MS;
  }

  /** Diagnostic helper — used by the Settings panel transparency log
   *  and tests. Returns entries sorted newest-first. */
  list(): TouchEntry[] {
    return Array.from(this.touches.values()).sort((a, b) => b.at - a.at);
  }
}

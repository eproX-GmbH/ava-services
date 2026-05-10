// v0.1.105 — Session A scaffold for the multi-source structured-content
// producer.
//
// The structured-content producer scrapes a master-data record from one
// of two sources today:
//   - unternehmensregister.de  (the source we've always used)
//   - handelsregister.de       (the new fallback we'll wire in Session B)
//
// The on-the-wire XML the producer emits is identical between sources,
// so the gateway / DB schema doesn't care which one we picked. The
// picker is local to the desktop and uses the live reachability
// snapshot from external-service-monitor.
//
// SESSION A (this PR): always returns "unternehmensregister" so behavior
// is unchanged. The seam exists so Session B is a one-liner.
//
// SESSION B: change the body of pickStructuredContentSource() to prefer
// handelsregister when unternehmensregister is unreachable and
// handelsregister is reachable.

export type StructuredContentSource =
  | "unternehmensregister"
  | "handelsregister";

export interface SourceReachability {
  unternehmensregister: boolean;
  handelsregister: boolean;
}

/**
 * Pick which upstream the structured-content producer should scrape.
 *
 * Session B: prefer handelsregister.de — empirically more stable than
 * unternehmensregister.de (anti-bot less aggressive, lower latency,
 * fewer 5xx blips). Fall back to unternehmensregister when
 * handelsregister is unreachable. If both are down the producer is
 * auto-paused by main/index.ts anyway, so the default doesn't matter
 * — we still return "handelsregister" so a recovery flap re-spawns
 * with the preferred source on top.
 */
export function pickStructuredContentSource(
  reachability: SourceReachability,
): StructuredContentSource {
  if (reachability.handelsregister) return "handelsregister";
  if (reachability.unternehmensregister) return "unternehmensregister";
  return "handelsregister";
}

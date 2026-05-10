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
 * Session A: always returns "unternehmensregister" — preserves today's
 * behavior. The reachability arg is accepted (and validated for shape)
 * so callers can already wire it through; flipping the picker in
 * Session B is a single-line change.
 */
export function pickStructuredContentSource(
  _reachability: SourceReachability,
): StructuredContentSource {
  // Session A: always return unternehmensregister (today's behavior).
  // Session B will flip this to prefer handelsregister when
  // unternehmensregister is down and handelsregister is reachable.
  return "unternehmensregister";
}

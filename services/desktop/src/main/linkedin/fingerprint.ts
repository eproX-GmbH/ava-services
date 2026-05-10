// LinkedIn-Beobachter fingerprint generator (Phase L1).
//
// Generates a stable per-install User-Agent + viewport tuple ONCE on
// first run and persists it in `LinkedInSettings.fingerprint`. L2's
// Playwright context will read this so we don't fluctuate the UA
// every visit (which itself looks bot-y to LinkedIn's heuristics).

import { app } from "electron";
import type { LinkedInFingerprint } from "../../shared/types";

// A recent Chrome on macOS UA. Stable across the install lifetime; the
// L2 scraper rotates this only when the user wipes via the kill-switch.
const DEFAULT_UA =
  "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 " +
  "(KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36";

const DEFAULT_VIEWPORT = { width: 1440, height: 900 } as const;

export function generateFingerprint(): LinkedInFingerprint {
  let timezone = "Europe/Berlin";
  try {
    const tz = Intl.DateTimeFormat().resolvedOptions().timeZone;
    if (tz) timezone = tz;
  } catch {
    /* keep fallback */
  }
  let locale = "de-DE";
  try {
    const l = app.getLocale();
    if (l && l.includes("-")) locale = l;
    else if (l) locale = `${l}-${l.toUpperCase()}`;
  } catch {
    /* keep fallback */
  }
  return {
    userAgent: DEFAULT_UA,
    viewport: { ...DEFAULT_VIEWPORT },
    timezone,
    locale,
  };
}

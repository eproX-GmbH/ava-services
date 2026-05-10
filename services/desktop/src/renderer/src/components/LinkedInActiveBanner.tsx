// LinkedIn-Beobachter active-mode banner (Phase L0).
//
// Permanent reminder that surfaces directly under the topbar whenever
// the LinkedIn feature is on. Yellow/amber tone — this isn't an error,
// it's a "you turned on something risky, you remain aware" reminder.
//
// Dismiss model:
//   - X opens a small popover with two options.
//   - "Heute nicht mehr anzeigen" stores a 24h-bounded suppression.
//   - "Bei aktivem Modus immer anzeigen" (default behaviour) just
//     closes the popover. There is intentionally no permanent
//     suppression — the user must remain aware while active.

import { useEffect, useState } from "react";
import { Link } from "react-router-dom";
import { AlertTriangle, X } from "lucide-react";
import type { LinkedInSettings } from "../../../shared/types";

const DISMISS_UNTIL_KEY = "ava.linkedinBanner.dismissedUntil";
const DAY_MS = 24 * 60 * 60 * 1000;

export function LinkedInActiveBanner() {
  const [settings, setSettings] = useState<LinkedInSettings | null>(null);
  const [dismissedUntil, setDismissedUntil] = useState<number | null>(() => {
    try {
      const v = localStorage.getItem(DISMISS_UNTIL_KEY);
      return v ? Number(v) : null;
    } catch {
      return null;
    }
  });
  const [confirmOpen, setConfirmOpen] = useState(false);

  // Fetch settings on mount + poll once every 30s. There's no push
  // channel for LinkedIn settings in L0 (the renderer-driven
  // settings panel is the only writer); a slow poll plus an explicit
  // refresh after Settings mutates is enough.
  useEffect(() => {
    let cancelled = false;
    const refresh = () => {
      void window.api.linkedin.getSettings().then((s) => {
        if (!cancelled) setSettings(s);
      });
    };
    refresh();
    const id = setInterval(refresh, 30_000);
    const onSettingsChanged = () => refresh();
    window.addEventListener("ava:linkedin-settings-changed", onSettingsChanged);
    return () => {
      cancelled = true;
      clearInterval(id);
      window.removeEventListener(
        "ava:linkedin-settings-changed",
        onSettingsChanged,
      );
    };
  }, []);

  if (!settings || !settings.enabled) return null;
  if (dismissedUntil !== null && Date.now() < dismissedUntil) return null;

  return (
    <div className="linkedin-active-banner" role="status" aria-live="polite">
      <AlertTriangle className="ct-icon-sm" aria-hidden="true" />
      <strong>LinkedIn-Beobachter ist aktiv.</strong>{" "}
      <span>Konto-Risiko + DSGVO liegen bei dir.</span>
      <Link to="/settings#linkedin-section" className="link linkedin-active-banner__settings">
        Einstellungen
      </Link>
      <button
        type="button"
        className="linkedin-active-banner__close"
        onClick={() => setConfirmOpen((v) => !v)}
        aria-label="Hinweis ausblenden"
        title="Hinweis ausblenden"
      >
        <X className="ct-icon-sm" aria-hidden="true" />
      </button>
      {confirmOpen && (
        <div className="linkedin-active-banner__confirm" role="dialog">
          <p className="linkedin-active-banner__confirm-title">
            Hinweis ausblenden?
          </p>
          <p className="linkedin-active-banner__confirm-body">
            Solange der LinkedIn-Beobachter aktiv ist, bleibt dieser Hinweis
            sichtbar. Du kannst ihn nur kurz ausblenden — nicht dauerhaft.
          </p>
          <div className="linkedin-active-banner__confirm-actions">
            <button
              type="button"
              className="primary"
              onClick={() => {
                const until = Date.now() + DAY_MS;
                setDismissedUntil(until);
                try {
                  localStorage.setItem(DISMISS_UNTIL_KEY, String(until));
                } catch {
                  /* ignore */
                }
                setConfirmOpen(false);
              }}
            >
              Heute nicht mehr anzeigen
            </button>
            <button
              type="button"
              className="link"
              onClick={() => setConfirmOpen(false)}
            >
              Bei aktivem Modus immer anzeigen
            </button>
          </div>
        </div>
      )}
    </div>
  );
}

/** Ping the banner to refresh its settings snapshot — fire this from
 *  Settings after every linkedin.* mutation so the banner appears /
 *  disappears without waiting for the 30s poll. */
export function notifyLinkedInSettingsChanged(): void {
  window.dispatchEvent(new CustomEvent("ava:linkedin-settings-changed"));
}

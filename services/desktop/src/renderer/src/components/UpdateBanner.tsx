import { useState } from "react";
import { useUpdaterStore } from "../store/updater";

// Floating update notification, bottom-right (Claude-Code style).
//
// Renders only when an update is genuinely actionable:
//   - state === "available"   → "Download v.X.Y.Z" pill
//   - state === "downloading" → percent indicator (no clicks)
//   - state === "ready"       → "Neu starten, um zu aktualisieren" pill
//
// Hidden in every other state (idle / checking / up-to-date /
// error). The Settings panel still shows full diagnostics for
// those cases — the banner is the user-facing nudge only.

export function UpdateBanner() {
  const status = useUpdaterStore((s) => s.status);
  const [busy, setBusy] = useState(false);

  // Per-state visibility. Hide the banner outside of these
  // user-actionable states.
  if (
    status.state !== "available" &&
    status.state !== "downloading" &&
    status.state !== "ready"
  ) {
    return null;
  }

  const onClick = async () => {
    if (busy) return;
    try {
      setBusy(true);
      if (status.state === "available") {
        await window.api.updater.download();
      } else if (status.state === "ready") {
        await window.api.updater.install();
      }
    } finally {
      setBusy(false);
    }
  };

  const isClickable = status.state !== "downloading";

  return (
    <button
      type="button"
      className="update-banner"
      onClick={onClick}
      disabled={!isClickable || busy}
      aria-label={titleFor(status.state)}
    >
      <span className="update-banner__icon" aria-hidden="true">
        {/* leaf-shaped glyph mirrors Claude Code's pill — simple SVG,
            no asset dependency, blends with the dark/light theme via
            currentColor. */}
        <svg width="16" height="16" viewBox="0 0 24 24" fill="none">
          <path
            d="M20 4c-7 0-13 4-15 11-1 4 0 7 3 8 1-3 3-6 6-8 0 0-3 4-4 9 4 0 9-3 11-7 2-4 2-9-1-13z"
            fill="currentColor"
            opacity="0.85"
          />
        </svg>
      </span>
      <span className="update-banner__body">
        <span className="update-banner__title">{titleFor(status.state, status.progress?.percent)}</span>
        <span className="update-banner__sub">
          v{status.latestVersion ?? status.currentVersion}
        </span>
      </span>
      {isClickable && (
        <span className="update-banner__chevron" aria-hidden="true">
          →
        </span>
      )}
    </button>
  );
}

function titleFor(
  state: "available" | "downloading" | "ready",
  percent?: number,
): string {
  switch (state) {
    case "available":
      return "Update verfügbar";
    case "downloading":
      return `Lädt herunter… ${percent ? Math.round(percent) + " %" : ""}`;
    case "ready":
      return "Neu starten, um zu aktualisieren";
  }
}

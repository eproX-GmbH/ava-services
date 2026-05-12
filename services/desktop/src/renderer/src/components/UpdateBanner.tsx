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

  // v0.1.155 — silent-install-failure banner takes precedence. The
  // previous boot tried to install a new version but the running
  // version on this boot is unchanged, so something in the Squirrel
  // pipeline failed silently. Surface the Squirrel + electron-updater
  // log paths so the user can attach them to a bug report.
  if (status.silentInstallFailedFromVersion) {
    return <SilentFailureBanner version={status.silentInstallFailedFromVersion} />;
  }

  // Per-state visibility. Hide the banner outside of these
  // user-actionable states.
  if (
    status.state !== "available" &&
    status.state !== "downloading" &&
    status.state !== "ready" &&
    status.state !== "installing"
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

  // `downloading` shows live percent (driven by main IPC pushes);
  // `installing` shows an indeterminate spinner — Squirrel takes
  // ~10–30s to swap the bundle and the user shouldn't wonder if
  // their click did anything.
  const isClickable =
    status.state !== "downloading" && status.state !== "installing";

  return (
    <button
      type="button"
      className="update-banner"
      onClick={onClick}
      disabled={!isClickable || busy}
      aria-label={titleFor(status.state)}
    >
      <span className="update-banner__icon" aria-hidden="true">
        {status.state === "installing" ? (
          // Indeterminate spinner — Squirrel.Mac is unpacking the
          // staged .zip and swapping the bundle; nothing to report
          // a percent against, so a rotating SVG is the honest cue.
          <svg
            width="16"
            height="16"
            viewBox="0 0 24 24"
            fill="none"
            className="update-banner__spinner"
          >
            <circle
              cx="12"
              cy="12"
              r="9"
              stroke="currentColor"
              strokeWidth="3"
              opacity="0.25"
            />
            <path
              d="M21 12a9 9 0 0 0-9-9"
              stroke="currentColor"
              strokeWidth="3"
              strokeLinecap="round"
            />
          </svg>
        ) : (
          /* leaf-shaped glyph mirrors Claude Code's pill — simple SVG,
              no asset dependency, blends with the dark/light theme via
              currentColor. */
          <svg width="16" height="16" viewBox="0 0 24 24" fill="none">
            <path
              d="M20 4c-7 0-13 4-15 11-1 4 0 7 3 8 1-3 3-6 6-8 0 0-3 4-4 9 4 0 9-3 11-7 2-4 2-9-1-13z"
              fill="currentColor"
              opacity="0.85"
            />
          </svg>
        )}
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
  state: "available" | "downloading" | "ready" | "installing",
  percent?: number,
): string {
  switch (state) {
    case "available":
      return "Update verfügbar";
    case "downloading":
      return `Lädt herunter… ${percent ? Math.round(percent) + " %" : ""}`;
    case "ready":
      return "Neu starten, um zu aktualisieren";
    case "installing":
      return "Update wird installiert… Anwendung startet gleich neu";
  }
}

/**
 * v0.1.155 — "Last install attempt didn't apply" banner. Triggered
 * when the boot-time version compare in main/updater.ts finds the
 * running app.getVersion() does NOT match the pending-install marker
 * we wrote right before quitAndInstall.
 *
 * We click-to-open the Squirrel log directory in the OS file manager
 * because that's where the ground truth lives — Squirrel.Mac writes
 * its own logs after our parent process is already dead, so the
 * autoUpdater "error" event in main never sees the failure reason.
 * The user can drag-drop the file into a bug report.
 */
function SilentFailureBanner({ version }: { version: string }) {
  const [showLogs, setShowLogs] = useState(false);

  const onShowLogs = async () => {
    // Diagnostics enumerates Squirrel + electron-updater logs from
    // main (which has access to the actual filesystem paths). We
    // pick the newest by mtime and reveal it in Finder so the user
    // can drag it into a bug report.
    const diag = await window.api.updater.getDiagnostics();
    if (diag.logs.length === 0) {
      // No log files at all (Squirrel never logged, electron-updater
      // never wrote main.log). Nothing to reveal — the dismiss button
      // is the remaining affordance.
      return;
    }
    const first = [...diag.logs].sort((a, b) => b.mtimeMs - a.mtimeMs)[0]!;
    await window.api.shell.showItemInFolder(first.path);
  };

  const onDismiss = () => {
    void window.api.updater.dismissSilentFailure();
  };

  return (
    <div className="update-banner update-banner--failure" role="alert">
      <span className="update-banner__icon" aria-hidden="true">
        {/* triangle-bang glyph for "attention needed" */}
        <svg width="16" height="16" viewBox="0 0 24 24" fill="none">
          <path
            d="M12 3 1 21h22L12 3z"
            stroke="currentColor"
            strokeWidth="2"
            strokeLinejoin="round"
          />
          <path
            d="M12 10v5M12 17.5v.5"
            stroke="currentColor"
            strokeWidth="2"
            strokeLinecap="round"
          />
        </svg>
      </span>
      <span className="update-banner__body">
        <span className="update-banner__title">
          Update auf v{version} konnte nicht installiert werden
        </span>
        <span className="update-banner__sub">
          {showLogs
            ? "Logs werden geöffnet…"
            : "Klick: Logs öffnen · Rechts: Hinweis schließen"}
        </span>
      </span>
      <span className="update-banner__actions">
        <button
          type="button"
          className="update-banner__chevron"
          onClick={async () => {
            setShowLogs(true);
            try {
              await onShowLogs();
            } finally {
              setShowLogs(false);
            }
          }}
          aria-label="Update-Logs öffnen"
        >
          →
        </button>
        <button
          type="button"
          className="update-banner__dismiss"
          onClick={onDismiss}
          aria-label="Hinweis schließen"
        >
          ×
        </button>
      </span>
    </div>
  );
}

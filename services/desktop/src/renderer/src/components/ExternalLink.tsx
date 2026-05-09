import { useEffect, useRef, useState, type ReactNode } from "react";

// Reusable external-link wrapper with an optional confirmation gate
// for LinkedIn URLs.
//
// Why the gate: LinkedIn aggressively rate-limits "profile views from
// external sources". Repeatedly clicking through to public profile URLs
// from a tool like AVA can flag the user's LinkedIn account — temporary
// search caps, profile-view limits, etc. The gate shows a one-line
// hinweis the first time, with a "nicht mehr fragen" toggle that
// persists in localStorage. Other URLs (XING, generic websites) open
// without a prompt.
//
// We deliberately don't try to be clever about the rate-limit itself
// (counting clicks per session, throttling). The user is the operator;
// the warning is the right tool.
//
// Implementation notes:
//   - All clicks go through `window.open(href, '_blank')` so the
//     Electron main-process `setWindowOpenHandler` bounces them to the
//     OS browser (already wired in main/index.ts).
//   - `target="_blank"` / `rel="noreferrer"` stay on the underlying <a>
//     for keyboard-driven middle-click and right-click "open in new
//     tab" — the JS handler is for the warning gate only, not auth.
//   - Don't-ask-again preference is keyed per-host so disabling the
//     LinkedIn warning won't accidentally disable a future one.

const STORAGE_PREFIX = "ava.externalLinkWarn.suppressed.";

interface ExternalLinkProps {
  href: string;
  children: ReactNode;
  className?: string;
  title?: string;
  /** Override the default warning copy. Pass `null` to disable the
   *  warning entirely for this anchor (useful when you've already
   *  warned upstream in a wrapping section). */
  warning?: { headline: string; body: string } | null;
  /** Override the per-host suppression key. Defaults to the URL host. */
  suppressKey?: string;
}

export function ExternalLink({
  href,
  children,
  className,
  title,
  warning,
  suppressKey,
}: ExternalLinkProps) {
  const effectiveWarning =
    warning === undefined ? defaultWarningFor(href) : warning;
  const key = suppressKey ?? hostOf(href) ?? "default";
  const [open, setOpen] = useState(false);

  const onClick = (e: React.MouseEvent<HTMLAnchorElement>) => {
    if (!effectiveWarning) return; // open natively
    if (e.metaKey || e.ctrlKey || e.shiftKey || e.button === 1) return;
    if (isSuppressed(key)) return;
    e.preventDefault();
    setOpen(true);
  };

  return (
    <>
      <a
        href={href}
        target="_blank"
        rel="noreferrer"
        className={className}
        title={title}
        onClick={onClick}
      >
        {children}
      </a>
      {open && effectiveWarning && (
        <ExternalLinkConfirm
          href={href}
          warning={effectiveWarning}
          suppressKey={key}
          onClose={() => setOpen(false)}
        />
      )}
    </>
  );
}

function ExternalLinkConfirm({
  href,
  warning,
  suppressKey,
  onClose,
}: {
  href: string;
  warning: { headline: string; body: string };
  suppressKey: string;
  onClose: () => void;
}) {
  const [suppress, setSuppress] = useState(false);
  const dialogRef = useRef<HTMLDivElement | null>(null);
  // Close on Esc; focus trap is handled by tab order alone (the dialog
  // has only two buttons + a checkbox — small enough that we don't need
  // a full focus library).
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
    };
    document.addEventListener("keydown", onKey);
    dialogRef.current?.focus();
    return () => document.removeEventListener("keydown", onKey);
  }, [onClose]);

  const onContinue = () => {
    if (suppress) markSuppressed(suppressKey);
    onClose();
    // window.open with _blank routes through Electron's
    // setWindowOpenHandler, which redirects to the OS browser.
    window.open(href, "_blank", "noreferrer");
  };

  return (
    <div className="link-warning-overlay" role="presentation" onClick={onClose}>
      <div
        ref={dialogRef}
        className="link-warning"
        role="dialog"
        aria-modal="true"
        aria-labelledby="link-warning-title"
        tabIndex={-1}
        onClick={(e) => e.stopPropagation()}
      >
        <h3 id="link-warning-title" className="link-warning__headline">
          {warning.headline}
        </h3>
        <p className="link-warning__body">{warning.body}</p>
        <p className="link-warning__url muted" title={href}>
          {href}
        </p>
        <label className="link-warning__suppress">
          <input
            type="checkbox"
            checked={suppress}
            onChange={(e) => setSuppress(e.target.checked)}
          />
          <span>Nicht mehr fragen</span>
        </label>
        <div className="link-warning__actions">
          <button type="button" onClick={onClose}>
            Abbrechen
          </button>
          <button type="button" className="primary" onClick={onContinue}>
            Trotzdem öffnen
          </button>
        </div>
      </div>
    </div>
  );
}

// ---- Per-host warning policy ----------------------------------------------

function defaultWarningFor(
  href: string,
): { headline: string; body: string } | null {
  const host = hostOf(href);
  if (!host) return null;
  if (/(^|\.)linkedin\.com$/i.test(host)) {
    return {
      headline: "LinkedIn-Profil öffnen?",
      body:
        "LinkedIn schränkt Konten ein, die häufig Profile aus externen Tools heraus öffnen, etwa durch Such-Limits, ausgegraute Profile oder eine zeitweise Profil-Sperre. Öffne den Link nur, wenn du das Profil wirklich brauchst, und nicht in schneller Folge mehrere hintereinander.",
    };
  }
  return null;
}

function hostOf(href: string): string | null {
  try {
    return new URL(href).host.toLowerCase();
  } catch {
    return null;
  }
}

// ---- Suppression preference (localStorage) --------------------------------

function isSuppressed(key: string): boolean {
  try {
    return window.localStorage.getItem(STORAGE_PREFIX + key) === "1";
  } catch {
    return false;
  }
}

function markSuppressed(key: string): void {
  try {
    window.localStorage.setItem(STORAGE_PREFIX + key, "1");
  } catch {
    // Best-effort; storage quota / private mode failures shouldn't
    // block the click.
  }
}

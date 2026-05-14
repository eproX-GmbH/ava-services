import { useEffect, useState } from "react";
import type { ResearchSettingsBundle } from "../../../shared/types";
import {
  FEATURE_LABEL,
  estimateImportCost,
  formatEuroRange,
} from "../../../shared/research-cost";

// v0.1.179 — Pre-import confirmation dialog.
//
// Shown before every import (UI Ingest + CRM-Import + chat-tool
// `import_excel`) when at least one research feature is active. Three
// outcomes: confirm-with-research, skip-research-for-this-import,
// cancel. See ProtocolNote at the bottom for the WHY behind the
// safety-first design (the user explicitly asked for this in response
// to "AVA könnte 1000+ Firmen aus Versehen mit Deep Research füttern,
// das wird teuer und ist ohne App-Close nicht stoppbar").
//
// The "Ohne Anreicherung" button does NOT itself trigger the import —
// it returns the decision to the caller, who then:
//   1. Calls `window.api.research.beginSkipMode()` → snapshotKey
//   2. Calls `window.api.research.waitWebsiteReady()` (~10s)
//   3. Does the actual import POST → transactionId
//   4. Calls `window.api.research.attachSkipToTransaction(snap, tx)`
//   5. Navigates to the transaction stream; the stream view auto-
//      restores via `endSkipModeForTransaction(tx)` on completion.

export type ImportConfirmChoice = "with-research" | "skip-research" | "cancel";

export interface ImportConfirmDialogProps {
  /** Estimated number of companies the import will touch. UI shows
   *  this prominently so the user notices "oh, 1000 rows" before
   *  clicking through. */
  companyCount: number;
  /** Snapshot of the current research settings. Pull from
   *  `window.api.research.getBundle()` in the caller; pass through
   *  so we don't re-fetch from inside the dialog. */
  bundle: ResearchSettingsBundle;
  onResolve: (choice: ImportConfirmChoice) => void;
  /** Renderer-side lock-out: if another skip-mode import is in
   *  flight, both skip options are disabled with an explanatory hint.
   *  Caller is responsible for setting this via
   *  `window.api.research.hasPendingSkipMode()`. */
  blockSkip?: boolean;
}

export function ImportConfirmDialog({
  companyCount,
  bundle,
  onResolve,
  blockSkip = false,
}: ImportConfirmDialogProps) {
  const estimate = estimateImportCost(bundle.config, companyCount);
  // Guard: if no features are active, the caller shouldn't even have
  // mounted this dialog. Render nothing as a safety net.
  if (!estimate) return null;

  // ESC to cancel, ENTER to confirm-with-research. Helps power-users.
  useEffect(() => {
    function onKey(e: KeyboardEvent) {
      if (e.key === "Escape") onResolve("cancel");
      // No Enter shortcut for confirm — too risky given the cost
      // implications. The user MUST click consciously.
    }
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onResolve]);

  return (
    <div
      role="dialog"
      aria-modal="true"
      style={{
        position: "fixed",
        inset: 0,
        background: "rgba(0,0,0,0.45)",
        display: "flex",
        alignItems: "center",
        justifyContent: "center",
        zIndex: 1000,
      }}
      onClick={() => onResolve("cancel")}
    >
      <div
        onClick={(e) => e.stopPropagation()}
        style={{
          background: "var(--bg-color, #fff)",
          padding: 24,
          borderRadius: 8,
          maxWidth: 560,
          minWidth: 440,
          boxShadow: "0 4px 32px rgba(0,0,0,0.25)",
        }}
      >
        <h3 style={{ marginTop: 0, marginBottom: 8 }}>
          Anreicherung für diesen Import bestätigen
        </h3>
        <p style={{ marginTop: 0 }}>
          Du startest einen Import von{" "}
          <strong>{companyCount.toLocaleString("de-DE")} Firmen</strong>.
        </p>

        <p className="muted small" style={{ marginBottom: 8 }}>
          Folgende kostenpflichtige Anreicherungen sind aktiv:
        </p>

        <ul style={{ margin: "0 0 12px", paddingLeft: 18 }}>
          {estimate.perFeature.map((p) => (
            <li key={p.feature} style={{ marginBottom: 6 }}>
              <strong>{FEATURE_LABEL[p.feature]}</strong>{" "}
              <span className="muted small">
                ({p.provider === "openai" ? "OpenAI" : "Anthropic"}{" "}
                {p.tier === "deep" ? "Deep Research" : "Standard"})
              </span>
              <div className="muted small" style={{ marginTop: 2 }}>
                {formatEuroRange(p.perFirma, { perFirma: true })} je Firma →{" "}
                <strong>{formatEuroRange(p.total)}</strong> total
              </div>
            </li>
          ))}
        </ul>

        <div
          style={{
            padding: "10px 12px",
            borderRadius: 6,
            background: "rgba(234, 179, 8, 0.12)",
            border: "1px solid rgba(234, 179, 8, 0.4)",
            marginBottom: 12,
            fontSize: 13,
          }}
        >
          <strong>Gesamtschätzung: {formatEuroRange(estimate.total)}</strong>
          <div className="muted small" style={{ marginTop: 4 }}>
            Diese Kosten werden direkt deinen API-Konten belastet — nicht von
            AVA. Bei „Ohne Anreicherung" werden die Features für diesen Import
            ausgesetzt und nach Abschluss automatisch wieder aktiviert.
          </div>
        </div>

        {blockSkip && (
          <p
            className="error small"
            style={{ marginTop: 0, marginBottom: 12 }}
          >
            Ein anderer Import läuft gerade im „Ohne Anreicherung"-Modus.
            Bitte warte bis der fertig ist, bevor du einen neuen Skip-Import
            startest.
          </p>
        )}

        <div
          style={{
            display: "flex",
            gap: 8,
            justifyContent: "flex-end",
            marginTop: 16,
            flexWrap: "wrap",
          }}
        >
          <button type="button" onClick={() => onResolve("cancel")}>
            Abbrechen
          </button>
          <button
            type="button"
            onClick={() => onResolve("skip-research")}
            disabled={blockSkip}
            title={
              blockSkip
                ? "Anderer Skip-Import läuft — bitte abwarten."
                : "Features kurz deaktivieren, importieren, danach automatisch wieder aktivieren."
            }
          >
            Ohne Anreicherung
          </button>
          <button
            type="button"
            onClick={() => onResolve("with-research")}
            style={{ fontWeight: 600 }}
          >
            Mit Anreicherung importieren
          </button>
        </div>
      </div>
    </div>
  );
}

/**
 * Renderer-side helper: orchestrate the skip-mode flow around an
 * import POST. Returns the transactionId on success.
 *
 * Usage from Ingest.tsx / chat tool / CRM:
 *
 *   const tx = await runImportWithSkipMode(
 *     () => doMyImportPost(),   // returns { transactionId }
 *   );
 *
 * Errors are propagated; on error the snapshot is restored
 * immediately so the user's config isn't stuck at off.
 */
export async function runImportWithSkipMode(
  doImport: () => Promise<{ transactionId: string }>,
): Promise<{ transactionId: string }> {
  const { snapshotKey } = await window.api.research.beginSkipMode();
  // Wait for the website producer to come back up with tier=off in
  // its env. ~10-15s typical; we give it 30s before giving up.
  const ready = await window.api.research.waitWebsiteReady(30_000);
  if (!ready.ready) {
    // Couldn't get the producer ready — restore immediately so the
    // user isn't stuck. We use a fake transactionId "abort-<snap>"
    // to route the snapshot back through the restore path.
    await window.api.research.attachSkipToTransaction(snapshotKey, `abort-${snapshotKey}`);
    await window.api.research.endSkipModeForTransaction(`abort-${snapshotKey}`);
    throw new Error(
      `Producer-Restart fehlgeschlagen (${ready.reason ?? "unknown"}). Anreicherung wurde nicht deaktiviert; bitte erneut versuchen.`,
    );
  }
  let res: { transactionId: string };
  try {
    res = await doImport();
  } catch (err) {
    // Import failed -- restore so the user's config isn't stuck.
    await window.api.research.attachSkipToTransaction(snapshotKey, `abort-${snapshotKey}`);
    await window.api.research.endSkipModeForTransaction(`abort-${snapshotKey}`);
    throw err;
  }
  await window.api.research.attachSkipToTransaction(snapshotKey, res.transactionId);
  return res;
}

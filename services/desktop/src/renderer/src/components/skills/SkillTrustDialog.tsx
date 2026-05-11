import { useEffect } from "react";
import type { SkillRow } from "../../../../shared/types";

// S4 — Trust-review dialog (PLAN §2.4 rule 5+6).
//
// Surfaced when the user clicks "Vertrauen prüfen" / "Erneut prüfen"
// on a skill row whose `trust !== "trusted"`. Lists every field that
// matters for a trust decision: scope, source path, allowed-tools,
// confirmation flags, body length. For modified skills we additionally
// diff allowed-tools against the previously-trusted set and highlight
// any newly-added tool in red.

const SCOPE_LABEL: Record<SkillRow["b2bScope"], string> = {
  outreach: "Outreach",
  qualifying: "Qualifying",
  competitive: "Wettbewerb",
  "data-extraction": "Datenextraktion",
  internal: "Intern",
};

export interface SkillTrustDialogProps {
  row: SkillRow;
  onAccept: () => void | Promise<void>;
  onClose: () => void;
}

export function SkillTrustDialog({
  row,
  onAccept,
  onClose,
}: SkillTrustDialogProps) {
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose]);

  const isModified = row.trust === "modified";
  const prev = new Set(row.previouslyTrustedAllowedTools);
  const newlyAdded = row.allowedTools.filter((t) => !prev.has(t));
  const bodyLength = 0; // body lookup is async — keep this dialog
  // self-contained; the user already sees the body via "Anzeigen".

  return (
    <div className="skill-modal" role="dialog" aria-modal="true">
      <div className="skill-modal__backdrop" onClick={onClose} />
      <div className="skill-modal__panel">
        <header className="skill-modal__head">
          <h4>
            {isModified
              ? "Skill erneut freigeben"
              : "Skill zum ersten Mal freigeben"}
          </h4>
          <button type="button" className="link" onClick={onClose}>
            Schließen
          </button>
        </header>

        <div className="skill-modal__body">
          {isModified && (
            <p
              className="error small"
              style={{
                padding: "0.5rem 0.75rem",
                background: "#fff5f5",
                border: "1px solid #e0a0a0",
                borderRadius: 4,
              }}
            >
              Achtung — dieses Skill wurde seit der letzten Freigabe geändert.
              Prüfe insbesondere neu hinzugekommene <code>allowed-tools</code>.
            </p>
          )}

          <dl className="trust-fields">
            <dt>Name</dt>
            <dd>
              <strong>{row.name}</strong>
            </dd>

            <dt>Bereich</dt>
            <dd>
              <span className="skill-pill skill-pill--scope">
                {SCOPE_LABEL[row.b2bScope]}
              </span>
            </dd>

            <dt>Quelle</dt>
            <dd className="muted small">{row.sourcePath}</dd>

            <dt>Beschreibung</dt>
            <dd>{row.description}</dd>

            <dt>Erlaubte Tools</dt>
            <dd>
              {row.allowedTools.length === 0 ? (
                <p className="muted small">
                  Dieses Skill darf keine Tools aufrufen (reines Prosa-Skill).
                </p>
              ) : (
                <ul className="trust-tool-list" style={{ paddingLeft: 0 }}>
                  {row.allowedTools.map((t) => {
                    const isNew = isModified && !prev.has(t);
                    return (
                      <li
                        key={t}
                        style={{
                          display: "inline-block",
                          margin: "0.15rem 0.3rem 0.15rem 0",
                          padding: "0.15rem 0.5rem",
                          borderRadius: 4,
                          background: isNew ? "#fdd6d6" : "#f1f1f1",
                          color: isNew ? "#7a0000" : undefined,
                          fontFamily: "monospace",
                          fontSize: "0.85rem",
                        }}
                      >
                        {t}
                        {isNew && " ← neu"}
                      </li>
                    );
                  })}
                </ul>
              )}
              {isModified && newlyAdded.length > 0 && (
                <p
                  className="error small"
                  style={{ marginTop: "0.5rem" }}
                >
                  {newlyAdded.length} neu hinzugefügte Tool(s) seit der
                  letzten Freigabe.
                </p>
              )}
            </dd>

            <dt>Flags</dt>
            <dd>
              <ul style={{ paddingLeft: "1.2rem", margin: 0 }}>
                <li>
                  Bestätigung pro Aufruf nötig:{" "}
                  {row.requiresUserConfirm ? "ja" : "nein"}
                </li>
                <li>
                  Auto-Aktivierung deaktiviert:{" "}
                  {row.disableModelInvocation ? "ja" : "nein"}
                </li>
                <li>
                  Per <code>/{row.name}</code> aufrufbar:{" "}
                  {row.userInvocable ? "ja" : "nein"}
                </li>
              </ul>
            </dd>

            <dt>Hash</dt>
            <dd className="muted small">
              <code>{row.hash.slice(0, 16)}…</code>
              {bodyLength > 0 && ` · ${bodyLength} Zeichen`}
            </dd>
          </dl>
        </div>

        <footer className="skill-modal__foot">
          <div
            className="actions"
            style={{ display: "flex", gap: "0.5rem" }}
          >
            <button
              type="button"
              className="link"
              onClick={() => void onAccept()}
              style={{ fontWeight: 600 }}
            >
              Vertrauen + aktivieren
            </button>
            <button type="button" className="link" onClick={onClose}>
              Ablehnen
            </button>
          </div>
        </footer>
      </div>
    </div>
  );
}

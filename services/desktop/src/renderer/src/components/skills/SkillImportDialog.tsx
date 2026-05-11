import { useEffect, useMemo, useState } from "react";
import type {
  SkillB2bScope,
  SkillImportAction,
  SkillImportCommit,
  SkillImportCommitEntry,
  SkillImportConflict,
  SkillImportStagedEntry,
} from "../../../../shared/types";

// S5 — Skill-Import-Dialog.
//
// Mirrors `SkillTrustDialog` for the per-row card layout but adds a
// per-entry toggle ("importieren?") + a global commit affordance that
// lets the user pick between "Importieren + vertrauen" (auto-trust)
// and the safer "Nur importieren" (write file, leave untrusted).
//
// Defaults:
//   - "create" rows → opt-in by default.
//   - "overwrite-trusted" with unchanged allowed-tools → opt-in.
//   - any other overwrite (modified / untrusted / new allowed-tools) →
//     opt-OUT. The user has to actively flip the switch, surfacing the
//     potentially-broader permissions before commit.

const SCOPE_LABEL: Record<SkillB2bScope, string> = {
  outreach: "Outreach",
  qualifying: "Qualifying",
  competitive: "Wettbewerb",
  "data-extraction": "Datenextraktion",
  internal: "Intern",
};

const ACTION_LABEL: Record<SkillImportAction, string> = {
  create: "Neu installieren",
  "overwrite-trusted": "Bestehendes (freigegebenes) Skill überschreiben",
  "overwrite-modified":
    "Bestehendes Skill überschreiben (lokal seit Freigabe geändert)",
  "overwrite-untrusted":
    "Bestehendes Skill überschreiben (noch nicht freigegeben)",
};

function defaultSelection(entry: SkillImportStagedEntry): boolean {
  if (entry.action === "create") return true;
  if (entry.action === "overwrite-trusted") {
    const prev = new Set(entry.previousAllowedTools ?? []);
    const addedTools = entry.allowedTools.filter((t) => !prev.has(t));
    if (addedTools.length === 0) return true;
  }
  return false;
}

export interface SkillImportDialogProps {
  stagingId: string;
  staged: SkillImportStagedEntry[];
  conflicts: SkillImportConflict[];
  onCancel: () => void;
  onCommit: (
    commit: SkillImportCommit,
    mode: "auto" | "deferred",
  ) => void | Promise<void>;
}

export function SkillImportDialog({
  stagingId,
  staged,
  conflicts,
  onCancel,
  onCommit,
}: SkillImportDialogProps) {
  const initial = useMemo(() => {
    const m: Record<string, boolean> = {};
    for (const e of staged) m[e.name] = defaultSelection(e);
    return m;
  }, [staged]);
  const [selected, setSelected] = useState<Record<string, boolean>>(initial);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape" && !busy) onCancel();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onCancel, busy]);

  const chosen = staged.filter((e) => selected[e.name]);
  const importable = staged.length > 0;

  const commit = async (mode: "auto" | "deferred") => {
    setError(null);
    if (chosen.length === 0) {
      setError("Keine Skills zum Import ausgewählt.");
      return;
    }
    setBusy(true);
    try {
      const payload: SkillImportCommit = {
        stagingId,
        staged: chosen.map<SkillImportCommitEntry>((e) => ({
          name: e.name,
          trust: mode,
        })),
      };
      await onCommit(payload, mode);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="skill-modal" role="dialog" aria-modal="true">
      <div
        className="skill-modal__backdrop"
        onClick={busy ? undefined : onCancel}
      />
      <div
        className="skill-modal__panel"
        style={{ width: "min(95vw, 900px)", maxHeight: "90vh" }}
      >
        <header className="skill-modal__head">
          <h4>Skills importieren</h4>
          <button
            type="button"
            className="link"
            onClick={onCancel}
            disabled={busy}
          >
            Schließen
          </button>
        </header>

        <div className="skill-modal__body" style={{ overflow: "auto" }}>
          {!importable && (
            <p className="muted">
              Keine importierbaren Skills im Paket gefunden.
            </p>
          )}
          {conflicts.length > 0 && (
            <div
              style={{
                marginBottom: "1rem",
                padding: "0.5rem 0.75rem",
                background: "#fff5f5",
                border: "1px solid #e0a0a0",
                borderRadius: 4,
              }}
            >
              <p className="error small" style={{ margin: 0, fontWeight: 600 }}>
                {conflicts.length} fehlerhafte Einträge übersprungen:
              </p>
              <ul
                style={{
                  paddingLeft: "1.2rem",
                  margin: "0.3rem 0 0",
                  fontSize: "0.85rem",
                }}
              >
                {conflicts.map((c, i) => (
                  <li key={i}>
                    {c.name ? <strong>{c.name}: </strong> : null}
                    {c.reason}
                  </li>
                ))}
              </ul>
            </div>
          )}

          {staged.map((entry) => (
            <StagedCard
              key={entry.name}
              entry={entry}
              selected={!!selected[entry.name]}
              onToggle={(on) =>
                setSelected((prev) => ({ ...prev, [entry.name]: on }))
              }
            />
          ))}
        </div>

        {error && (
          <div style={{ padding: "0 1rem" }}>
            <p className="error small">Fehler: {error}</p>
          </div>
        )}

        <footer className="skill-modal__foot">
          <div
            className="actions"
            style={{ display: "flex", gap: "0.5rem", flexWrap: "wrap" }}
          >
            <button
              type="button"
              className="link"
              onClick={() => void commit("auto")}
              disabled={busy || chosen.length === 0}
              style={{ fontWeight: 600 }}
            >
              {busy ? "Importiert…" : "Alle importieren + vertrauen"}
            </button>
            <button
              type="button"
              className="link"
              onClick={() => void commit("deferred")}
              disabled={busy || chosen.length === 0}
            >
              Nur importieren, nicht vertrauen
            </button>
            <button
              type="button"
              className="link"
              onClick={onCancel}
              disabled={busy}
            >
              Abbrechen
            </button>
          </div>
        </footer>
      </div>
    </div>
  );
}

function StagedCard({
  entry,
  selected,
  onToggle,
}: {
  entry: SkillImportStagedEntry;
  selected: boolean;
  onToggle: (on: boolean) => void;
}) {
  const prev = entry.previousAllowedTools;
  const isOverwrite = entry.action !== "create";
  const prevSet = new Set(prev ?? []);
  const newSet = new Set(entry.allowedTools);
  const addedTools = entry.allowedTools.filter((t) => !prevSet.has(t));
  const removedTools = (prev ?? []).filter((t) => !newSet.has(t));

  return (
    <div
      style={{
        border: "1px solid #e0e0e0",
        borderRadius: 6,
        padding: "0.75rem 1rem",
        marginBottom: "0.75rem",
        background: selected ? "#f7faff" : "#fafafa",
      }}
    >
      <header
        style={{
          display: "flex",
          alignItems: "center",
          justifyContent: "space-between",
          gap: "0.5rem",
        }}
      >
        <div style={{ display: "flex", alignItems: "center", gap: "0.5rem", flexWrap: "wrap" }}>
          <strong>{entry.name}</strong>
          <span className="skill-pill skill-pill--scope">
            {SCOPE_LABEL[entry.b2bScope]}
          </span>
          {isOverwrite && (
            <span
              className="skill-pill skill-pill--warn"
              style={{
                background: entry.action === "overwrite-modified"
                  ? "#fdd6d6"
                  : "#fff3d6",
                color: entry.action === "overwrite-modified"
                  ? "#7a0000"
                  : "#7a4b00",
              }}
            >
              Überschreibt vorhandenes Skill
            </span>
          )}
        </div>
        <label className="small" style={{ display: "flex", alignItems: "center", gap: "0.3rem" }}>
          <input
            type="checkbox"
            checked={selected}
            onChange={(e) => onToggle(e.target.checked)}
          />
          Importieren
        </label>
      </header>

      <p className="muted small" style={{ margin: "0.3rem 0" }}>
        {ACTION_LABEL[entry.action]}
      </p>

      <p style={{ margin: "0.4rem 0" }}>{entry.description}</p>

      <div style={{ display: "flex", gap: "1.5rem", flexWrap: "wrap" }}>
        <div style={{ minWidth: 240 }}>
          <p className="small" style={{ margin: 0, fontWeight: 600 }}>
            Erlaubte Tools ({entry.allowedTools.length})
          </p>
          {entry.allowedTools.length === 0 ? (
            <p className="muted small" style={{ margin: "0.2rem 0 0" }}>
              Reines Prosa-Skill (kein Tool-Aufruf).
            </p>
          ) : (
            <ul style={{ paddingLeft: 0, margin: "0.3rem 0 0" }}>
              {entry.allowedTools.map((t) => {
                const isNew = isOverwrite && prev && !prevSet.has(t);
                return (
                  <li
                    key={t}
                    style={{
                      display: "inline-block",
                      margin: "0.1rem 0.25rem 0.1rem 0",
                      padding: "0.1rem 0.4rem",
                      borderRadius: 4,
                      background: isNew ? "#fdd6d6" : "#f1f1f1",
                      color: isNew ? "#7a0000" : undefined,
                      fontFamily: "monospace",
                      fontSize: "0.8rem",
                    }}
                  >
                    {t}
                    {isNew && " ← neu"}
                  </li>
                );
              })}
            </ul>
          )}
          {isOverwrite && removedTools.length > 0 && (
            <p className="small" style={{ margin: "0.3rem 0 0" }}>
              Entfällt:{" "}
              {removedTools.map((t) => (
                <span
                  key={t}
                  style={{
                    display: "inline-block",
                    margin: "0.1rem 0.25rem 0.1rem 0",
                    padding: "0.1rem 0.4rem",
                    borderRadius: 4,
                    background: "#e6fbe6",
                    color: "#225522",
                    fontFamily: "monospace",
                    fontSize: "0.8rem",
                    textDecoration: "line-through",
                  }}
                >
                  {t}
                </span>
              ))}
            </p>
          )}
          {isOverwrite && !prev && (
            <p className="muted small" style={{ margin: "0.3rem 0 0" }}>
              Bestehendes Skill wird überschrieben (kein Diff verfügbar, da
              die alte Version keine freigegebene Tool-Liste hatte).
            </p>
          )}
        </div>

        <div style={{ minWidth: 200 }}>
          <p className="small" style={{ margin: 0, fontWeight: 600 }}>
            Body
          </p>
          <p className="muted small" style={{ margin: "0.2rem 0 0" }}>
            {entry.bodyLength} Zeichen · {entry.bodyLines} Zeile
            {entry.bodyLines === 1 ? "" : "n"}
          </p>
          <p className="muted small" style={{ margin: "0.2rem 0 0" }}>
            Hash: <code>{entry.hash.slice(0, 16)}…</code>
          </p>
        </div>
      </div>

      {isOverwrite && addedTools.length > 0 && (
        <p
          className="small"
          style={{
            margin: "0.5rem 0 0",
            padding: "0.4rem 0.6rem",
            background: "#fff5f5",
            border: "1px solid #e0a0a0",
            borderRadius: 4,
            color: "#7a0000",
          }}
        >
          Achtung: {addedTools.length} neu hinzugefügte Tool(s) gegenüber der
          letzten Freigabe. Prüfe vor dem Vertrauen.
        </p>
      )}
    </div>
  );
}

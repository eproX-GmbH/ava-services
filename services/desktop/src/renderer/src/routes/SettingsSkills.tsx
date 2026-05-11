import { useCallback, useEffect, useMemo, useState } from "react";
import ReactMarkdown from "react-markdown";
import type {
  SkillBody,
  SkillRow,
  SkillSavePayload,
} from "../../../shared/types";
import { SkillTrustDialog } from "../components/skills/SkillTrustDialog";
import { SkillEditor } from "../components/skills/SkillEditor";

// Settings → Skills (PLAN §2, S3 + S4).
//
// S3 shipped: read-only list with toggle + body modal.
// S4 adds: trust dialog (untrusted/modified), in-app editor, delete.

const SCOPE_LABEL: Record<SkillRow["b2bScope"], string> = {
  outreach: "Outreach",
  qualifying: "Qualifying",
  competitive: "Wettbewerb",
  "data-extraction": "Datenextraktion",
  internal: "Intern",
};

const SOURCE_LABEL: Record<SkillRow["scope"], string> = {
  user: "Nutzer",
  workspace: "Workspace",
};

function truncate(text: string, max: number): string {
  const collapsed = text.replace(/\s+/g, " ").trim();
  if (collapsed.length <= max) return collapsed;
  return `${collapsed.slice(0, max - 1).trimEnd()}…`;
}

export function SettingsSkills() {
  const [rows, setRows] = useState<SkillRow[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [info, setInfo] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [viewName, setViewName] = useState<string | null>(null);
  const [trustName, setTrustName] = useState<string | null>(null);
  const [editorTarget, setEditorTarget] = useState<
    { mode: "new" } | { mode: "edit"; name: string } | null
  >(null);

  const refresh = useCallback(async () => {
    try {
      const next = await window.api.skills.list();
      setRows(next);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    }
  }, []);

  useEffect(() => {
    void refresh();
    const off = window.api.skills.onChanged(() => {
      void refresh();
    });
    return () => off();
  }, [refresh]);

  const onToggle = async (name: string, enabled: boolean) => {
    setError(null);
    try {
      await window.api.skills.setEnabled(name, enabled);
      setRows((prev) =>
        prev
          ? prev.map((r) => (r.name === name ? { ...r, enabled } : r))
          : prev,
      );
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    }
  };

  const onReload = async () => {
    setBusy(true);
    setError(null);
    try {
      await window.api.skills.reload();
      await refresh();
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  };

  const onOpenSourceDir = async () => {
    const res = await window.api.skills.openPath();
    if ("error" in res) setError(res.error);
  };

  const onOpenFile = async (path: string) => {
    const res = await window.api.skills.openPath(path);
    if ("error" in res) setError(res.error);
  };

  const onDelete = async (row: SkillRow) => {
    if (row.scope === "workspace") {
      setError(
        "Workspace-Skills werden im Projekt-Repo verwaltet und können hier nicht gelöscht werden.",
      );
      return;
    }
    const confirmed = window.confirm(
      `Skill '${row.name}' wirklich endgültig löschen?\n\nDie Datei ${row.sourcePath} wird entfernt.`,
    );
    if (!confirmed) return;
    setError(null);
    try {
      const res = await window.api.skills.delete(row.name);
      if (!res.ok) {
        setError(res.error);
        return;
      }
      setInfo(`Skill '${row.name}' gelöscht.`);
      await refresh();
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    }
  };

  const trustRow = useMemo(
    () => rows?.find((r) => r.name === trustName) ?? null,
    [rows, trustName],
  );

  return (
    <section className="provider-section" id="skills-list">
      <h3>Skills</h3>
      <p className="muted small">
        Vom Nutzer hinterlegte Markdown-Skills, die der Chat-Agent
        automatisch aktivieren kann. Auto-Aktivierung basiert auf der
        Beschreibung; alternativ explizit per <code>/skill-name</code>.
        Neue oder geänderte Skills müssen einmal freigegeben werden,
        bevor der Agent sie aufruft.
      </p>

      <div className="actions" style={{ margin: "0.5rem 0 1rem" }}>
        <button
          type="button"
          className="link"
          onClick={() => setEditorTarget({ mode: "new" })}
        >
          Neues Skill
        </button>
        <button
          type="button"
          className="link"
          onClick={() => void onReload()}
          disabled={busy}
        >
          {busy ? "Lädt neu…" : "Aktualisieren"}
        </button>
        <button
          type="button"
          className="link"
          onClick={() => void onOpenSourceDir()}
        >
          Skills-Ordner öffnen
        </button>
      </div>

      {error && <p className="error small">Fehler: {error}</p>}
      {info && !error && <p className="muted small">{info}</p>}

      {rows === null ? (
        <p className="muted">Lädt…</p>
      ) : rows.length === 0 ? (
        <SkillsEmptyState
          onCreate={() => setEditorTarget({ mode: "new" })}
          onOpen={() => void onOpenSourceDir()}
        />
      ) : (
        <ul className="skills-list">
          {rows.map((row) => (
            <SkillCard
              key={`${row.scope}:${row.name}`}
              row={row}
              onToggle={(enabled) => void onToggle(row.name, enabled)}
              onView={() => setViewName(row.name)}
              onOpenFile={() => void onOpenFile(row.sourcePath)}
              onTrust={() => setTrustName(row.name)}
              onEdit={() =>
                setEditorTarget({ mode: "edit", name: row.name })
              }
              onDelete={() => void onDelete(row)}
            />
          ))}
        </ul>
      )}

      {viewName && (
        <SkillBodyModal
          name={viewName}
          onClose={() => setViewName(null)}
        />
      )}

      {trustRow && (
        <SkillTrustDialog
          row={trustRow}
          onClose={() => setTrustName(null)}
          onAccept={async () => {
            try {
              await window.api.skills.trust(trustRow.name);
              setTrustName(null);
              await refresh();
            } catch (err) {
              setError(err instanceof Error ? err.message : String(err));
            }
          }}
        />
      )}

      {editorTarget && (
        <SkillEditor
          target={editorTarget}
          onClose={() => setEditorTarget(null)}
          onSaved={async (payload: SkillSavePayload, oldName?: string) => {
            setEditorTarget(null);
            await refresh();
            if (oldName && oldName !== payload.frontmatter.name) {
              const wantsDelete = window.confirm(
                `Du hast das Skill umbenannt. Die alte Datei '${oldName}' bleibt auf der Platte. Jetzt löschen?`,
              );
              if (wantsDelete) {
                const res = await window.api.skills.delete(oldName);
                if (!res.ok) setError(res.error);
                else {
                  setInfo(`Alte Datei '${oldName}' gelöscht.`);
                  await refresh();
                }
              }
            } else {
              setInfo(`Skill '${payload.frontmatter.name}' gespeichert.`);
            }
          }}
        />
      )}
    </section>
  );
}

function SkillsEmptyState({
  onCreate,
  onOpen,
}: {
  onCreate: () => void;
  onOpen: () => void;
}) {
  return (
    <div className="skills-empty">
      <p>
        Noch keine Skills installiert. Lege eines per <em>Neues Skill</em> an
        oder ziehe später (S5) ein Skill-Paket per Drag-and-Drop hierher.
      </p>
      <div className="actions">
        <button type="button" className="link" onClick={onCreate}>
          Neues Skill anlegen
        </button>
        <button type="button" className="link" onClick={onOpen}>
          Pfad öffnen
        </button>
      </div>
    </div>
  );
}

interface SkillCardProps {
  row: SkillRow;
  onToggle: (enabled: boolean) => void;
  onView: () => void;
  onOpenFile: () => void;
  onTrust: () => void;
  onEdit: () => void;
  onDelete: () => void;
}

function SkillCard({
  row,
  onToggle,
  onView,
  onOpenFile,
  onTrust,
  onEdit,
  onDelete,
}: SkillCardProps) {
  const isWorkspace = row.scope === "workspace";
  return (
    <li className="skill-card">
      <header className="skill-card__head">
        <div className="skill-card__title">
          <strong>{row.name}</strong>
          <span className="skill-pill skill-pill--scope">
            {SCOPE_LABEL[row.b2bScope]}
          </span>
          <span className="skill-pill skill-pill--source">
            {SOURCE_LABEL[row.scope]}
          </span>
          {row.trust === "untrusted" && (
            <span
              className="skill-pill skill-pill--warn"
              style={{ background: "#fff3d6", color: "#7a4b00" }}
            >
              Vertrauen erforderlich
            </span>
          )}
          {row.trust === "modified" && (
            <span
              className="skill-pill skill-pill--warn"
              style={{ background: "#fdd6d6", color: "#7a0000" }}
            >
              Geändert seit letzter Freigabe
            </span>
          )}
        </div>
        <label className="skill-card__toggle">
          <input
            type="checkbox"
            checked={row.enabled}
            disabled={!row.gateSatisfied}
            onChange={(e) => onToggle(e.target.checked)}
          />
          <span>Aktiv</span>
        </label>
      </header>
      <p className="skill-card__desc">{truncate(row.description, 140)}</p>
      <SkillStatusPill row={row} />
      {row.trust !== "trusted" && (
        <div
          className="skill-card__trust-banner"
          style={{
            margin: "0.5rem 0",
            padding: "0.5rem 0.75rem",
            background: row.trust === "modified" ? "#fff5f5" : "#fffaf0",
            border: `1px solid ${row.trust === "modified" ? "#e0a0a0" : "#d9b066"}`,
            borderRadius: 4,
          }}
        >
          <p className="small" style={{ margin: 0 }}>
            {row.trust === "modified"
              ? "Dieses Skill wurde seit der letzten Freigabe geändert. Bitte erneut prüfen, bevor der Agent es benutzt."
              : "Dieses Skill ist noch nicht freigegeben. Der Agent benutzt es erst nach deiner Bestätigung."}
          </p>
          <div className="actions" style={{ marginTop: "0.4rem" }}>
            <button type="button" className="link" onClick={onTrust}>
              {row.trust === "modified" ? "Erneut prüfen" : "Vertrauen prüfen"}
            </button>
          </div>
        </div>
      )}
      <div className="skill-card__actions">
        <button type="button" className="link" onClick={onView}>
          Anzeigen
        </button>
        <button
          type="button"
          className="link"
          onClick={onEdit}
          disabled={isWorkspace}
          title={
            isWorkspace
              ? "Workspace-Skills werden im Projekt-Repo verwaltet."
              : undefined
          }
        >
          Bearbeiten
        </button>
        <button type="button" className="link" onClick={onOpenFile}>
          Datei öffnen
        </button>
        <button
          type="button"
          className="link"
          onClick={onDelete}
          disabled={isWorkspace}
          title={
            isWorkspace
              ? "Workspace-Skills werden im Projekt-Repo verwaltet."
              : undefined
          }
          style={{ color: isWorkspace ? undefined : "#b00020" }}
        >
          Löschen
        </button>
      </div>
    </li>
  );
}

function SkillStatusPill({ row }: { row: SkillRow }) {
  if (!row.gateSatisfied) {
    const reason = row.gateReason ?? "Voraussetzung fehlt";
    return (
      <p className="skill-status skill-status--warn">
        Voraussetzung fehlt: {reason}
      </p>
    );
  }
  if (row.trust !== "trusted") {
    return (
      <p className="skill-status skill-status--muted">
        Inaktiv bis zur Freigabe
      </p>
    );
  }
  if (!row.enabled) {
    return (
      <p className="skill-status skill-status--muted">Deaktiviert</p>
    );
  }
  if (row.disableModelInvocation) {
    return (
      <p className="skill-status skill-status--info">
        Nur explizit (<code>/{row.name}</code>)
      </p>
    );
  }
  return <p className="skill-status skill-status--ok">Aktiv</p>;
}

function SkillBodyModal({
  name,
  onClose,
}: {
  name: string;
  onClose: () => void;
}) {
  const [body, setBody] = useState<SkillBody | null | "loading">("loading");

  useEffect(() => {
    let cancelled = false;
    void window.api.skills.getBody(name).then((res) => {
      if (!cancelled) setBody(res);
    });
    return () => {
      cancelled = true;
    };
  }, [name]);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose]);

  return (
    <div className="skill-modal" role="dialog" aria-modal="true">
      <div className="skill-modal__backdrop" onClick={onClose} />
      <div className="skill-modal__panel">
        <header className="skill-modal__head">
          <h4>{name}</h4>
          <button type="button" className="link" onClick={onClose}>
            Schließen
          </button>
        </header>
        <div className="skill-modal__body">
          {body === "loading" && <p className="muted">Lädt…</p>}
          {body === null && (
            <p className="muted">
              Skill nicht gefunden. Wurde die Datei gerade gelöscht?
            </p>
          )}
          {body && body !== "loading" && (
            <SkillMarkdown markdown={body.body} />
          )}
        </div>
        {body && body !== "loading" && (
          <footer className="skill-modal__foot">
            <span className="muted small">{body.sourcePath}</span>
          </footer>
        )}
      </div>
    </div>
  );
}

function SkillMarkdown({ markdown }: { markdown: string }) {
  const safe = useMemo(() => markdown, [markdown]);
  return (
    <div className="skill-modal__markdown">
      <ReactMarkdown>{safe}</ReactMarkdown>
    </div>
  );
}

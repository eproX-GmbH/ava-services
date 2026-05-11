import { useCallback, useEffect, useMemo, useState } from "react";
import ReactMarkdown from "react-markdown";
import type { SkillBody, SkillRow } from "../../../shared/types";

// Settings → Skills (PLAN §2, S3).
//
// Read-only inventory + per-skill enabled toggle + markdown viewer.
// In-app authoring lands with S4; for now power users edit SKILL.md
// files directly on disk and the "Datei öffnen" affordance shells the
// path out via `shell.openPath`. The file watcher fires
// `skills:changed` so edits show up without a reload.

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
  const [busy, setBusy] = useState(false);
  const [viewName, setViewName] = useState<string | null>(null);

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
      // Optimistic update — the IPC push will reconcile if needed.
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

  return (
    <section className="provider-section" id="skills-list">
      <h3>Skills</h3>
      <p className="muted small">
        Vom Nutzer hinterlegte Markdown-Skills, die der Chat-Agent
        automatisch aktivieren kann. Auto-Aktivierung basiert auf der
        Beschreibung; alternativ explizit per <code>/skill-name</code>.
        Deaktivierte Skills bleiben sichtbar, werden aber weder im
        System-Prompt erwähnt noch über <code>/name</code> akzeptiert.
      </p>

      <div className="actions" style={{ margin: "0.5rem 0 1rem" }}>
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

      {rows === null ? (
        <p className="muted">Lädt…</p>
      ) : rows.length === 0 ? (
        <SkillsEmptyState onOpen={() => void onOpenSourceDir()} />
      ) : (
        <ul className="skills-list">
          {rows.map((row) => (
            <SkillCard
              key={`${row.scope}:${row.name}`}
              row={row}
              onToggle={(enabled) => void onToggle(row.name, enabled)}
              onView={() => setViewName(row.name)}
              onOpenFile={() => void onOpenFile(row.sourcePath)}
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
    </section>
  );
}

function SkillsEmptyState({ onOpen }: { onOpen: () => void }) {
  return (
    <div className="skills-empty">
      <p>
        Noch keine Skills installiert. Lege <code>SKILL.md</code>-Dateien
        unter <code>&lt;userData&gt;/skills/&lt;name&gt;/</code> ab oder
        ziehe später (S5) ein Skill-Paket per Drag-and-Drop hierher.
      </p>
      <button type="button" className="link" onClick={onOpen}>
        Pfad öffnen
      </button>
    </div>
  );
}

interface SkillCardProps {
  row: SkillRow;
  onToggle: (enabled: boolean) => void;
  onView: () => void;
  onOpenFile: () => void;
}

function SkillCard({ row, onToggle, onView, onOpenFile }: SkillCardProps) {
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
      <div className="skill-card__actions">
        <button type="button" className="link" onClick={onView}>
          Anzeigen
        </button>
        <button type="button" className="link" onClick={onOpenFile}>
          Datei öffnen
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
  // The body may include `${argument}` / `$ARGUMENTS` placeholders.
  // ReactMarkdown treats `${…}` as plain text, which is what we want
  // — the modal is a read-only preview of the source body, not an
  // execution.
  const safe = useMemo(() => markdown, [markdown]);
  return (
    <div className="skill-modal__markdown">
      <ReactMarkdown>{safe}</ReactMarkdown>
    </div>
  );
}

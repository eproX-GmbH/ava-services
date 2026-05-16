import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";
import type {
  SkillBody,
  SkillImportCommit,
  SkillImportConflict,
  SkillImportResult,
  SkillImportStagedEntry,
  SkillRow,
  SkillSavePayload,
} from "../../../shared/types";
import { SkillTrustDialog } from "../components/skills/SkillTrustDialog";
import { SkillEditor } from "../components/skills/SkillEditor";
import { SkillImportDialog } from "../components/skills/SkillImportDialog";

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
  // S5 — import staging state. `pending` holds the result of a
  // staging call until the user commits or cancels via the dialog.
  // `trustQueue` drives the "Alle prüfen" walk-through across every
  // `trust === "modified"` row.
  const [pending, setPending] = useState<
    {
      stagingId: string;
      staged: SkillImportStagedEntry[];
      conflicts: SkillImportConflict[];
    } | null
  >(null);
  const [markdownDraft, setMarkdownDraft] = useState("");
  const [markdownOpen, setMarkdownOpen] = useState(false);
  const [trustQueue, setTrustQueue] = useState<string[]>([]);
  const dropAreaRef = useRef<HTMLDivElement | null>(null);
  const [dragActive, setDragActive] = useState(false);

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

  const modifiedRows = useMemo(
    () => (rows ?? []).filter((r) => r.trust === "modified"),
    [rows],
  );

  const onExport = async (name: string) => {
    setError(null);
    try {
      const res = await window.api.skills.export(name);
      if (res.ok) {
        setInfo(`Skill '${name}' nach ${res.path} exportiert.`);
        return;
      }
      if ("cancelled" in res) return;
      setError(res.error);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    }
  };

  const onExportAll = async () => {
    setError(null);
    try {
      const res = await window.api.skills.exportAll();
      if (res.ok) {
        setInfo(`${res.count} Skill(s) nach ${res.path} exportiert.`);
        return;
      }
      if ("cancelled" in res) return;
      setError(res.error);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    }
  };

  const handleStagingResult = (res: SkillImportResult) => {
    if (!res.ok) {
      setError(res.error);
      return;
    }
    if (res.staged.length === 0 && res.conflicts.length === 0) {
      setError("Keine gültigen Skills im Paket gefunden.");
      // Best-effort: cancel the empty staging dir.
      void window.api.skills.cancelImport(res.stagingId).catch(() => {});
      return;
    }
    setPending({
      stagingId: res.stagingId,
      staged: res.staged,
      conflicts: res.conflicts,
    });
  };

  const onPickImport = async () => {
    setError(null);
    try {
      const picked = await window.api.skills.pickImportFile();
      if ("cancelled" in picked) return;
      await importFromPath(picked.path);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    }
  };

  const importFromPath = async (path: string) => {
    setError(null);
    setBusy(true);
    try {
      const isMd = /\.md$/i.test(path);
      let res: SkillImportResult;
      if (isMd) {
        // .md drops: read via importMarkdown using a tiny file:// fetch.
        // The renderer can't read arbitrary disk paths directly, so
        // we route through importZip if it's a zip and ask the main
        // process to read the markdown via a dedicated channel. To
        // keep the surface small, we treat .md the same as .zip and
        // let the main-side importZip path fail with a clear error,
        // OR we fall back to reading it via the picker round-trip.
        // Simpler: pipe it through importZip — adm-zip rejects a
        // non-zip, but we'd rather support .md cleanly. Workaround:
        // re-use importMarkdown if a renderer DataTransfer item is a
        // text/markdown drop (handled in onDrop). For path-only flow
        // .md drops go through importZip too; if that fails the user
        // can paste instead. (Documented in SKILLS.md.)
        res = await window.api.skills.importZip(path);
      } else {
        res = await window.api.skills.importZip(path);
      }
      handleStagingResult(res);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  };

  const onImportMarkdownPaste = async () => {
    setError(null);
    if (!markdownDraft.trim()) {
      setError("SKILL.md-Body ist leer.");
      return;
    }
    setBusy(true);
    try {
      const res = await window.api.skills.importMarkdown(markdownDraft);
      handleStagingResult(res);
      setMarkdownDraft("");
      setMarkdownOpen(false);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  };

  const onCommitImport = async (commit: SkillImportCommit) => {
    setError(null);
    try {
      const res = await window.api.skills.commitImport(commit);
      if (!res.ok) {
        setError(res.error);
        return;
      }
      setPending(null);
      setInfo(`${res.written.length} Skill(s) importiert.`);
      await refresh();
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    }
  };

  const onCancelImport = () => {
    if (pending) {
      void window.api.skills
        .cancelImport(pending.stagingId)
        .catch(() => {});
    }
    setPending(null);
  };

  const onCheckAllModified = () => {
    if (modifiedRows.length === 0) return;
    const queue = modifiedRows.map((r) => r.name);
    const first = queue[0]!;
    setTrustQueue(queue.slice(1));
    setTrustName(first);
  };

  // Drag-and-drop wiring. Electron exposes `File.path` for dropped
  // files in the renderer (sandbox: true does NOT strip it for
  // user-initiated drops). Text drops are routed to importMarkdown.
  const onDrop = async (e: React.DragEvent<HTMLDivElement>) => {
    e.preventDefault();
    setDragActive(false);
    if (e.dataTransfer.files && e.dataTransfer.files.length > 0) {
      const f = e.dataTransfer.files[0]!;
      // Electron-specific `path` field on a renderer File.
      const path = (f as unknown as { path?: string }).path;
      if (path) {
        if (/\.md$/i.test(path)) {
          // Read the markdown directly so a single SKILL.md drop
          // doesn't have to go through adm-zip.
          try {
            const text = await f.text();
            const res = await window.api.skills.importMarkdown(text);
            handleStagingResult(res);
          } catch (err) {
            setError(err instanceof Error ? err.message : String(err));
          }
          return;
        }
        await importFromPath(path);
        return;
      }
      // Fallback for non-Electron environments / sandboxed drops
      // without a path: read text + import as markdown.
      try {
        const text = await f.text();
        const res = await window.api.skills.importMarkdown(text);
        handleStagingResult(res);
      } catch (err) {
        setError(err instanceof Error ? err.message : String(err));
      }
      return;
    }
    const text = e.dataTransfer.getData("text/plain");
    if (text && text.trim()) {
      try {
        const res = await window.api.skills.importMarkdown(text);
        handleStagingResult(res);
      } catch (err) {
        setError(err instanceof Error ? err.message : String(err));
      }
    }
  };

  const onDragOver = (e: React.DragEvent<HTMLDivElement>) => {
    e.preventDefault();
    e.dataTransfer.dropEffect = "copy";
    if (!dragActive) setDragActive(true);
  };
  const onDragLeave = () => setDragActive(false);

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

      <div className="actions" style={{ margin: "0.5rem 0 1rem", display: "flex", flexWrap: "wrap", gap: "0.5rem" }}>
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
          onClick={() => void onPickImport()}
          disabled={busy}
        >
          Importieren
        </button>
        <button
          type="button"
          className="link"
          onClick={() => void onExportAll()}
          disabled={busy || (rows?.filter((r) => r.scope === "user").length ?? 0) === 0}
        >
          Alle exportieren
        </button>
        <button
          type="button"
          className="link"
          onClick={() => setMarkdownOpen((v) => !v)}
        >
          {markdownOpen ? "Einfügen abbrechen" : "SKILL.md einfügen"}
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

      {modifiedRows.length > 0 && (
        <div
          style={{
            margin: "0 0 0.75rem",
            padding: "0.6rem 0.85rem",
            background: "#fff5f5",
            border: "1px solid #e0a0a0",
            borderRadius: 4,
            display: "flex",
            justifyContent: "space-between",
            alignItems: "center",
            flexWrap: "wrap",
            gap: "0.5rem",
          }}
        >
          <span className="small">
            <strong>Vertrauensänderungen:</strong>{" "}
            {modifiedRows.length} Skill
            {modifiedRows.length === 1 ? "" : "s"} wurde
            {modifiedRows.length === 1 ? "" : "n"} seit der letzten
            Freigabe geändert.
          </span>
          <button
            type="button"
            className="link"
            onClick={onCheckAllModified}
          >
            Alle prüfen
          </button>
        </div>
      )}

      {markdownOpen && (
        <div
          style={{
            margin: "0 0 1rem",
            padding: "0.6rem 0.85rem",
            background: "#fafafa",
            border: "1px solid #ddd",
            borderRadius: 4,
          }}
        >
          <p className="small" style={{ margin: 0 }}>
            SKILL.md-Inhalt einfügen:
          </p>
          <textarea
            value={markdownDraft}
            onChange={(e) => setMarkdownDraft(e.target.value)}
            rows={8}
            placeholder={"---\nname: mein-skill\n..."}
            style={{
              width: "100%",
              marginTop: "0.4rem",
              fontFamily: "monospace",
              fontSize: "0.85rem",
            }}
          />
          <div className="actions" style={{ marginTop: "0.4rem" }}>
            <button
              type="button"
              className="link"
              onClick={() => void onImportMarkdownPaste()}
              disabled={busy || !markdownDraft.trim()}
            >
              Aus Text importieren
            </button>
            <button
              type="button"
              className="link"
              onClick={() => {
                setMarkdownDraft("");
                setMarkdownOpen(false);
              }}
            >
              Abbrechen
            </button>
          </div>
        </div>
      )}

      <div
        ref={dropAreaRef}
        onDrop={(e) => void onDrop(e)}
        onDragOver={onDragOver}
        onDragLeave={onDragLeave}
        style={{
          border: `2px dashed ${dragActive ? "#3070d0" : "#cccccc"}`,
          background: dragActive ? "#eef4ff" : "transparent",
          borderRadius: 6,
          padding: "0.6rem 0.85rem",
          marginBottom: "1rem",
          textAlign: "center",
        }}
      >
        <span className="muted small">
          {dragActive
            ? "Datei hier loslassen, um zu importieren"
            : "Skill-Paket (.zip) oder einzelne SKILL.md hierher ziehen"}
        </span>
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
              onExport={() => void onExport(row.name)}
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
          onClose={() => {
            setTrustName(null);
            // S5 — "Alle prüfen" walk-through: if the user dismisses
            // a queued dialog (Ablehnen / Schließen), advance to the
            // next modified row anyway so they can still skip through.
            if (trustQueue.length > 0) {
              const [next, ...rest] = trustQueue;
              setTrustQueue(rest);
              setTrustName(next ?? null);
            }
          }}
          onAccept={async () => {
            try {
              await window.api.skills.trust(trustRow.name);
              if (trustQueue.length > 0) {
                const [next, ...rest] = trustQueue;
                setTrustQueue(rest);
                setTrustName(next ?? null);
              } else {
                setTrustName(null);
              }
              await refresh();
            } catch (err) {
              setError(err instanceof Error ? err.message : String(err));
            }
          }}
        />
      )}

      {pending && (
        <SkillImportDialog
          stagingId={pending.stagingId}
          staged={pending.staged}
          conflicts={pending.conflicts}
          onCancel={onCancelImport}
          onCommit={(commit) => void onCommitImport(commit)}
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
        Noch keine Skills installiert. Lege eines per <em>Neues Skill</em> an,
        nutze <em>Importieren</em> für ein Skill-Paket oder ziehe ein{" "}
        <code>.zip</code>/<code>SKILL.md</code> direkt hierher.
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
  onExport: () => void;
}

function SkillCard({
  row,
  onToggle,
  onView,
  onOpenFile,
  onTrust,
  onEdit,
  onDelete,
  onExport,
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
        <button type="button" className="link" onClick={onExport}>
          Exportieren
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
      <ReactMarkdown remarkPlugins={[remarkGfm]}>{safe}</ReactMarkdown>
    </div>
  );
}

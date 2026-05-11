import { useEffect, useMemo, useState } from "react";
import ReactMarkdown from "react-markdown";
import type {
  SkillArgumentPayload,
  SkillB2bScope,
  SkillLanguage,
  SkillRow,
  SkillSavePayload,
} from "../../../../shared/types";

// S4 — Skill editor.
//
// Two-column modal: left = frontmatter form (validated client-side),
// right = body textarea with a Vorschau toggle. Save calls
// `window.api.skills.save(payload)`; on success the caller refreshes
// the list. Rename detection (oldName !== newName) is handled by the
// parent so it can offer to delete the old file.

const KEBAB_RE = /^[a-z][a-z0-9]*(?:-[a-z0-9]+)*$/;

const B2B_SCOPES: SkillB2bScope[] = [
  "outreach",
  "qualifying",
  "competitive",
  "data-extraction",
  "internal",
];

const SCOPE_LABEL: Record<SkillB2bScope, string> = {
  outreach: "Outreach",
  qualifying: "Qualifying",
  competitive: "Wettbewerb",
  "data-extraction": "Datenextraktion",
  internal: "Intern",
};

const LANG_LABEL: Record<SkillLanguage, string> = {
  de: "Deutsch",
  en: "Englisch",
};

const EMPTY_FRONTMATTER = {
  name: "",
  description: "",
  language: "de" as SkillLanguage,
  "b2b-scope": "outreach" as SkillB2bScope,
  "allowed-tools": [] as string[],
  "requires-user-confirm": true,
  "disable-model-invocation": false,
  "user-invocable": true,
  arguments: [] as SkillArgumentPayload[],
};

const EMPTY_BODY = `# Neues Skill

Beschreibe hier deine Anweisungen an den Agenten.
`;

export interface SkillEditorProps {
  target: { mode: "new" } | { mode: "edit"; name: string };
  onClose: () => void;
  onSaved: (
    payload: SkillSavePayload,
    oldName?: string,
  ) => void | Promise<void>;
}

export function SkillEditor({ target, onClose, onSaved }: SkillEditorProps) {
  const [frontmatter, setFrontmatter] = useState(EMPTY_FRONTMATTER);
  const [body, setBody] = useState(EMPTY_BODY);
  const [oldName, setOldName] = useState<string | null>(null);
  const [availableTools, setAvailableTools] = useState<string[] | null>(null);
  const [toolFilter, setToolFilter] = useState("");
  const [preview, setPreview] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [loading, setLoading] = useState(target.mode === "edit");

  // Hydrate from existing skill row + body on edit.
  useEffect(() => {
    let cancelled = false;
    if (target.mode === "new") {
      setLoading(false);
      return;
    }
    void (async () => {
      try {
        const rows = await window.api.skills.list();
        const row = rows.find((r: SkillRow) => r.name === target.name);
        if (!row) {
          if (!cancelled) setError("Skill nicht gefunden.");
          return;
        }
        const bodyRes = await window.api.skills.getBody(target.name);
        if (cancelled) return;
        setFrontmatter({
          name: row.name,
          description: row.description,
          language: row.language,
          "b2b-scope": row.b2bScope,
          "allowed-tools": row.allowedTools.slice(),
          "requires-user-confirm": row.requiresUserConfirm,
          "disable-model-invocation": row.disableModelInvocation,
          "user-invocable": row.userInvocable,
          arguments: [],
        });
        setOldName(row.name);
        setBody(bodyRes?.body ?? "");
        setLoading(false);
      } catch (err) {
        if (!cancelled)
          setError(err instanceof Error ? err.message : String(err));
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [target]);

  // Load registered tools for the chip multi-select.
  useEffect(() => {
    let cancelled = false;
    void window.api.skills
      .listAvailableTools()
      .then((tools) => {
        if (!cancelled) setAvailableTools(tools.map((t) => t.name));
      })
      .catch(() => {
        if (!cancelled) setAvailableTools([]);
      });
    return () => {
      cancelled = true;
    };
  }, []);

  // Escape closes (only if not busy).
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape" && !busy) onClose();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose, busy]);

  const lineCount = useMemo(() => body.split(/\r?\n/).length, [body]);
  const charCount = body.length;

  const filteredTools = useMemo(() => {
    const all = availableTools ?? [];
    const f = toolFilter.trim().toLowerCase();
    if (!f) return all;
    return all.filter((t) => t.toLowerCase().includes(f));
  }, [availableTools, toolFilter]);

  const validate = (): string | null => {
    if (!KEBAB_RE.test(frontmatter.name)) {
      return "Feld 'name' muss in kebab-case sein (z. B. 'mein-skill').";
    }
    if (!frontmatter.description.trim()) {
      return "Feld 'description' darf nicht leer sein.";
    }
    if (frontmatter.description.length > 500) {
      return "Feld 'description' darf höchstens 500 Zeichen lang sein.";
    }
    for (const a of frontmatter.arguments) {
      if (!KEBAB_RE.test(a.name)) {
        return `Argumentname '${a.name}' muss in kebab-case sein.`;
      }
      if (!a.description.trim()) {
        return `Argument '${a.name}' braucht eine Beschreibung.`;
      }
    }
    return null;
  };

  const onSave = async () => {
    setError(null);
    const v = validate();
    if (v) {
      setError(v);
      return;
    }
    setBusy(true);
    try {
      const payload: SkillSavePayload = { frontmatter, body };
      const res = await window.api.skills.save(payload);
      if (!res.ok) {
        setError(res.error);
        return;
      }
      await onSaved(payload, oldName && oldName !== frontmatter.name ? oldName : undefined);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  };

  const toggleTool = (name: string) => {
    setFrontmatter((fm) => {
      const set = new Set(fm["allowed-tools"]);
      if (set.has(name)) set.delete(name);
      else set.add(name);
      return { ...fm, "allowed-tools": Array.from(set).sort() };
    });
  };

  const addArgument = () => {
    setFrontmatter((fm) => ({
      ...fm,
      arguments: [
        ...fm.arguments,
        { name: "", description: "", required: false },
      ],
    }));
  };

  const updateArgument = (i: number, patch: Partial<SkillArgumentPayload>) => {
    setFrontmatter((fm) => ({
      ...fm,
      arguments: fm.arguments.map((a, idx) =>
        idx === i ? { ...a, ...patch } : a,
      ),
    }));
  };

  const removeArgument = (i: number) => {
    setFrontmatter((fm) => ({
      ...fm,
      arguments: fm.arguments.filter((_, idx) => idx !== i),
    }));
  };

  return (
    <div className="skill-modal" role="dialog" aria-modal="true">
      <div className="skill-modal__backdrop" onClick={busy ? undefined : onClose} />
      <div
        className="skill-modal__panel"
        style={{ maxHeight: "90vh" }}
      >
        <header className="skill-modal__head">
          <h4>
            {target.mode === "new" ? "Neues Skill" : `Bearbeiten: ${target.name}`}
          </h4>
          <button
            type="button"
            className="link"
            onClick={onClose}
            disabled={busy}
          >
            Schließen
          </button>
        </header>

        {loading ? (
          <div className="skill-modal__body">
            <p className="muted">Lädt…</p>
          </div>
        ) : (
          <div
            className="skill-modal__body"
            style={{
              display: "grid",
              gridTemplateColumns: "minmax(0, 1fr) minmax(0, 1.2fr)",
              gap: "1rem",
              overflow: "auto",
            }}
          >
            {/* LEFT — frontmatter form */}
            <div>
              <h5>Metadaten</h5>

              <label className="form-field">
                <span>Name</span>
                <input
                  type="text"
                  value={frontmatter.name}
                  onChange={(e) =>
                    setFrontmatter({ ...frontmatter, name: e.target.value })
                  }
                  placeholder="mein-skill"
                />
                <span className="muted small">
                  Nur Kleinbuchstaben, Ziffern und Bindestriche.
                </span>
              </label>

              <label className="form-field">
                <span>Beschreibung</span>
                <textarea
                  rows={4}
                  value={frontmatter.description}
                  maxLength={500}
                  onChange={(e) =>
                    setFrontmatter({
                      ...frontmatter,
                      description: e.target.value,
                    })
                  }
                />
                <span className="muted small">
                  {frontmatter.description.length}/500 Zeichen
                </span>
              </label>

              <label className="form-field">
                <span>Sprache</span>
                <select
                  value={frontmatter.language}
                  onChange={(e) =>
                    setFrontmatter({
                      ...frontmatter,
                      language: e.target.value as SkillLanguage,
                    })
                  }
                >
                  {(Object.keys(LANG_LABEL) as SkillLanguage[]).map((l) => (
                    <option key={l} value={l}>
                      {LANG_LABEL[l]}
                    </option>
                  ))}
                </select>
              </label>

              <label className="form-field">
                <span>B2B-Bereich</span>
                <select
                  value={frontmatter["b2b-scope"]}
                  onChange={(e) =>
                    setFrontmatter({
                      ...frontmatter,
                      "b2b-scope": e.target.value as SkillB2bScope,
                    })
                  }
                >
                  {B2B_SCOPES.map((s) => (
                    <option key={s} value={s}>
                      {SCOPE_LABEL[s]}
                    </option>
                  ))}
                </select>
              </label>

              <fieldset className="form-field">
                <legend>Erlaubte Tools ({frontmatter["allowed-tools"].length})</legend>
                <input
                  type="search"
                  placeholder="Filtern…"
                  value={toolFilter}
                  onChange={(e) => setToolFilter(e.target.value)}
                  style={{ marginBottom: "0.4rem", width: "100%" }}
                />
                <div
                  style={{
                    maxHeight: 180,
                    overflow: "auto",
                    border: "1px solid #ddd",
                    borderRadius: 4,
                    padding: "0.4rem",
                  }}
                >
                  {availableTools === null && (
                    <p className="muted small">Lädt Tool-Liste…</p>
                  )}
                  {availableTools !== null && filteredTools.length === 0 && (
                    <p className="muted small">Keine Treffer.</p>
                  )}
                  {filteredTools.map((t) => {
                    const checked = frontmatter["allowed-tools"].includes(t);
                    return (
                      <label
                        key={t}
                        style={{
                          display: "block",
                          fontFamily: "monospace",
                          fontSize: "0.85rem",
                          padding: "0.1rem 0",
                        }}
                      >
                        <input
                          type="checkbox"
                          checked={checked}
                          onChange={() => toggleTool(t)}
                        />{" "}
                        {t}
                      </label>
                    );
                  })}
                </div>
                <span className="muted small">
                  Leere Liste = reines Prosa-Skill (kein Tool-Aufruf).
                </span>
              </fieldset>

              <fieldset className="form-field">
                <legend>Flags</legend>
                <label style={{ display: "block" }}>
                  <input
                    type="checkbox"
                    checked={frontmatter["requires-user-confirm"]}
                    onChange={(e) =>
                      setFrontmatter({
                        ...frontmatter,
                        "requires-user-confirm": e.target.checked,
                      })
                    }
                  />{" "}
                  Bestätigung pro Tool-Aufruf nötig
                </label>
                <label style={{ display: "block" }}>
                  <input
                    type="checkbox"
                    checked={frontmatter["disable-model-invocation"]}
                    onChange={(e) =>
                      setFrontmatter({
                        ...frontmatter,
                        "disable-model-invocation": e.target.checked,
                      })
                    }
                  />{" "}
                  Auto-Aktivierung deaktivieren (nur explizit aufrufbar)
                </label>
                <label style={{ display: "block" }}>
                  <input
                    type="checkbox"
                    checked={frontmatter["user-invocable"]}
                    onChange={(e) =>
                      setFrontmatter({
                        ...frontmatter,
                        "user-invocable": e.target.checked,
                      })
                    }
                  />{" "}
                  Per <code>/{frontmatter.name || "name"}</code> aufrufbar
                </label>
              </fieldset>

              <fieldset className="form-field">
                <legend>Argumente</legend>
                {frontmatter.arguments.length === 0 && (
                  <p className="muted small">Keine Argumente definiert.</p>
                )}
                {frontmatter.arguments.map((a, i) => (
                  <div
                    key={i}
                    style={{
                      display: "grid",
                      gridTemplateColumns: "1fr 2fr auto auto",
                      gap: "0.3rem",
                      marginBottom: "0.4rem",
                    }}
                  >
                    <input
                      type="text"
                      placeholder="arg-name"
                      value={a.name}
                      onChange={(e) =>
                        updateArgument(i, { name: e.target.value })
                      }
                    />
                    <input
                      type="text"
                      placeholder="Beschreibung"
                      value={a.description}
                      onChange={(e) =>
                        updateArgument(i, { description: e.target.value })
                      }
                    />
                    <label className="small">
                      <input
                        type="checkbox"
                        checked={a.required}
                        onChange={(e) =>
                          updateArgument(i, { required: e.target.checked })
                        }
                      />{" "}
                      Pflicht
                    </label>
                    <button
                      type="button"
                      className="link"
                      onClick={() => removeArgument(i)}
                    >
                      Entf.
                    </button>
                  </div>
                ))}
                <button type="button" className="link" onClick={addArgument}>
                  + Argument hinzufügen
                </button>
              </fieldset>
            </div>

            {/* RIGHT — body editor */}
            <div style={{ display: "flex", flexDirection: "column" }}>
              <div
                style={{
                  display: "flex",
                  justifyContent: "space-between",
                  alignItems: "center",
                  marginBottom: "0.4rem",
                }}
              >
                <h5 style={{ margin: 0 }}>Body (Markdown)</h5>
                <label className="small">
                  <input
                    type="checkbox"
                    checked={preview}
                    onChange={(e) => setPreview(e.target.checked)}
                  />{" "}
                  Vorschau
                </label>
              </div>
              {preview ? (
                <div
                  className="skill-modal__markdown"
                  style={{
                    flex: 1,
                    minHeight: 300,
                    overflow: "auto",
                    border: "1px solid #ddd",
                    borderRadius: 4,
                    padding: "0.6rem",
                  }}
                >
                  <ReactMarkdown>{body}</ReactMarkdown>
                </div>
              ) : (
                <textarea
                  value={body}
                  onChange={(e) => setBody(e.target.value)}
                  style={{
                    flex: 1,
                    minHeight: 300,
                    fontFamily: "monospace",
                    fontSize: "0.85rem",
                    width: "100%",
                    resize: "vertical",
                  }}
                />
              )}
              <p className="muted small" style={{ marginTop: "0.3rem" }}>
                {charCount} Zeichen · {lineCount} Zeile{lineCount === 1 ? "" : "n"}
              </p>
            </div>
          </div>
        )}

        {error && (
          <div style={{ padding: "0 1rem" }}>
            <p className="error small">Fehler: {error}</p>
          </div>
        )}

        <footer className="skill-modal__foot">
          <div
            className="actions"
            style={{ display: "flex", gap: "0.5rem" }}
          >
            <button
              type="button"
              className="link"
              onClick={() => void onSave()}
              disabled={busy}
              style={{ fontWeight: 600 }}
            >
              {busy ? "Speichert…" : "Speichern"}
            </button>
            <button
              type="button"
              className="link"
              onClick={onClose}
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

// W3 — Workflows: Liste + Offene Freigaben (docs/PLAN_WORKFLOWS.md §7).
// AVA baut Workflows im Chat; hier: Ueberblick, starten, pausieren,
// Freigaben entscheiden, in den Editor wechseln.

import { useCallback, useEffect, useState } from "react";
import { Link, useNavigate } from "react-router-dom";
import type { OrgWorkflowRow, WorkflowApproval, WorkflowListEntry, WorkflowProgressFrame, WorkflowTrigger } from "../../../shared/workflow-types";


export function triggerText(t: WorkflowTrigger): string {
  if (t.kind === "manual") return "manuell";
  if (t.kind === "chat") return "per Chat";
  if (t.kind === "event") return `Ereignis: ${t.event}`;
  if (t.intervalMinutes) return t.intervalMinutes % 1440 === 0 ? `alle ${t.intervalMinutes / 1440} Tag(e)` : t.intervalMinutes % 60 === 0 ? `alle ${t.intervalMinutes / 60} Std.` : `alle ${t.intervalMinutes} Min.`;
  if (t.at) {
    const tage = t.weekdays && t.weekdays.length > 0 && t.weekdays.length < 7 ? ` (${t.weekdays.map((d) => ["So", "Mo", "Di", "Mi", "Do", "Fr", "Sa"][d]).join(", ")})` : "";
    return `täglich ${t.at}${tage}`;
  }
  return "Zeitplan";
}

export function statusPill(status: string): JSX.Element {
  const cls = status === "success" ? "pill--connected" : status === "error" ? "pill--error" : status === "running" ? "pill--polling" : status === "paused" || status === "waiting" ? "pill--paused" : "pill--connecting";
  const label = status === "success" ? "erfolgreich" : status === "error" ? "Fehler" : status === "running" ? "läuft" : status === "paused" ? "wartet auf Freigabe" : status === "waiting" ? "wartet auf Vorgang" : status === "cancelled" ? "abgebrochen" : status;
  return <span className={`pill ${cls}`}>{label}</span>;
}

/** Firmenauswahl vor dem Start: jeder Workflow-Lauf gilt fuer genau eine Firma. */
export function FirmenAuswahl({
  onWahl,
  onAbbruch,
  onMehrere,
}: {
  onWahl: (f: { companyId: string; name: string } | null) => void;
  onAbbruch: () => void;
  /** Optional: mehrere Firmen auf einmal (je Firma ein Lauf). */
  onMehrere?: (f: Array<{ companyId: string; name: string }>) => void;
}): JSX.Element {
  const [q, setQ] = useState("");
  const [kandidaten, setKandidaten] = useState<Array<{ companyId: string; name: string; ort: string | null }>>([]);
  const [gewaehlt, setGewaehlt] = useState<Map<string, string>>(new Map());
  const [fehler, setFehler] = useState<string | null>(null);
  const [laedt, setLaedt] = useState(false);
  const suchen = async (): Promise<void> => {
    if (q.trim().length < 2) return;
    setLaedt(true);
    setFehler(null);
    try {
      const r = await window.api.workflows.resolveCompany(q.trim());
      if (r.error) setFehler(r.error);
      setKandidaten(r.kandidaten ?? []);
    } finally {
      setLaedt(false);
    }
  };
  return (
    <div className="ct-card wf-firma">
      <h3>Für welche Firma?</h3>
      <p className="muted small">Jeder Lauf bezieht sich auf genau eine Firma; ihr vollständiger Kontext (Stammdaten, Profil, Finanzen, Kontakte, CRM) liegt dem Lauf vor.</p>
      <div className="telegram-row">
        <input
          className="telegram-input"
          placeholder="Firmenname suchen"
          value={q}
          onChange={(e) => setQ(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter") void suchen();
          }}
          autoFocus
        />
        <button type="button" className="btn" disabled={laedt || q.trim().length < 2} onClick={() => void suchen()}>
          Suchen
        </button>
        <button type="button" className="link" onClick={onAbbruch}>
          Abbrechen
        </button>
      </div>
      {fehler && <p className="muted small warn">{fehler}</p>}
      {kandidaten.length > 0 && (
        <div className="org-list">
          {kandidaten.map((k) => (
            <div key={k.companyId} className="org-row">
              {onMehrere && (
                <input
                  type="checkbox"
                  checked={gewaehlt.has(k.companyId)}
                  onChange={(e) =>
                    setGewaehlt((m) => {
                      const n = new Map(m);
                      if (e.target.checked) n.set(k.companyId, k.name);
                      else n.delete(k.companyId);
                      return n;
                    })
                  }
                  aria-label={`${k.name} auswählen`}
                />
              )}
              <button type="button" className="org-row__main wf-run" onClick={() => onWahl({ companyId: k.companyId, name: k.name })}>
                <span className="org-row__title">{k.name}</span>
                <span className="org-row__meta">{k.ort ?? k.companyId}</span>
              </button>
            </div>
          ))}
        </div>
      )}
      {onMehrere && gewaehlt.size > 0 && (
        <div className="org-actions">
          <button type="button" className="primary" onClick={() => onMehrere([...gewaehlt.entries()].map(([companyId, name]) => ({ companyId, name })))}>
            Für {gewaehlt.size} Firmen starten (je Firma ein Lauf)
          </button>
        </div>
      )}
      <p className="muted small">
        Ohne Firmenbezug starten (nur für Workflows mit Einstellung „ohne Firma“):{" "}
        <button type="button" className="link" onClick={() => onWahl(null)}>
          ohne Firma
        </button>
      </p>
    </div>
  );
}

export function Workflows(): JSX.Element {
  const [rows, setRows] = useState<WorkflowListEntry[]>([]);
  const [approvals, setApprovals] = useState<WorkflowApproval[]>([]);
  const [orgRows, setOrgRows] = useState<Array<OrgWorkflowRow & { vonMir: boolean }>>([]);
  const [vorlagen, setVorlagen] = useState<Array<{ id: string; name: string; description: string; verfuegbar: boolean; fehlendeTools: string[]; trigger: string }>>([]);
  const [vorlagenOffen, setVorlagenOffen] = useState(false);
  // Organisation vorhanden? → Liste der geteilten Workflows laedt ohne Fehler.
  const [inOrg, setInOrg] = useState(false);
  const [notice, setNotice] = useState<string | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const navigate = useNavigate();

  const reload = useCallback(async () => {
    try {
      const [r, a] = await Promise.all([window.api.workflows.list(), window.api.workflows.approvals("open")]);
      setRows(r);
      setApprovals(a);
      const o = await window.api.workflows.orgList();
      setInOrg(!o.error);
      setOrgRows(o.items ?? []);
      setVorlagen(await window.api.workflows.templates());
    } catch (err) {
      setNotice(err instanceof Error ? err.message : String(err));
    }
  }, []);

  useEffect(() => {
    void reload();
    return window.api.workflows.onProgress((f: WorkflowProgressFrame) => {
      if (f.kind === "execution-started" || f.kind === "execution-finished" || f.kind === "approval-open" || f.kind === "approvals-changed") void reload();
    });
  }, [reload]);

  const [firmaFuer, setFirmaFuer] = useState<{ id: string; dryRun: boolean } | null>(null);

  const run = async (id: string, dryRun: boolean): Promise<void> => {
    // Jeder Lauf gilt fuer eine Firma: erst waehlen.
    setFirmaFuer({ id, dryRun });
  };

  const starte = async (id: string, dryRun: boolean, firma: { companyId: string; name: string } | null): Promise<void> => {
    setBusy(id);
    setNotice(null);
    setFirmaFuer(null);
    try {
      const r = await window.api.workflows.run(id, { dryRun, ...(firma ? { companyId: firma.companyId, companyName: firma.name } : {}) });
      setNotice(r.error ?? (dryRun ? `Trockenlauf gestartet${firma ? ` für ${firma.name}` : ""}.` : `Workflow gestartet${firma ? ` für ${firma.name}` : ""}.`));
    } finally {
      setBusy(null);
      void reload();
    }
  };

  const toggle = async (row: WorkflowListEntry): Promise<void> => {
    await window.api.workflows.patch(row.id, { enabled: !row.enabled });
    void reload();
  };

  const remove = async (row: WorkflowListEntry): Promise<void> => {
    if (!window.confirm(`Workflow „${row.name}“ samt Lauf-Historie löschen?`)) return;
    await window.api.workflows.delete(row.id);
    void reload();
  };

  const teilen = async (row: WorkflowListEntry): Promise<void> => {
    setBusy(row.id);
    try {
      const r = await window.api.workflows.share(row.id);
      setNotice(r.error ?? `„${row.name}“ mit der Organisation geteilt — Kolleginnen und Kollegen können ihn übernehmen.`);
    } finally {
      setBusy(null);
      void reload();
    }
  };

  const uebernehmen = async (o: OrgWorkflowRow): Promise<void> => {
    setBusy(o.id);
    try {
      const r = await window.api.workflows.adopt(o.id);
      setNotice(r.error ?? `„${o.name}“ übernommen — Trigger steht auf manuell, Schreib-Schritte sind nicht freigegeben.`);
    } finally {
      setBusy(null);
      void reload();
    }
  };

  const decide = async (a: WorkflowApproval, approved: boolean): Promise<void> => {
    setBusy(a.id);
    try {
      await window.api.workflows.approve(a.id, approved);
    } finally {
      setBusy(null);
      void reload();
    }
  };

  return (
    <div className="radar-page wf-page">
      <div className="radar-head">
        <div>
          <h1>Workflows</h1>
          <p className="radar-sub">
            Gespeicherte Abläufe aus Tool-Schritten. AVA baut sie im Chat („speicher das als Workflow“, „bau mir einen Workflow, der …“);
            hier siehst du sie, startest sie, gibst Schritte frei und korrigierst Kleinigkeiten.
          </p>
        </div>
        <div className="radar-actions">
          <Link to="/workflows/laeufe" className="proc-toggle">
            Alle Läufe
          </Link>
          <Link to="/chat" className="proc-toggle">
            Im Chat bauen
          </Link>
          <button type="button" className="proc-toggle" onClick={() => void reload()}>
            Aktualisieren
          </button>
        </div>
      </div>

      {notice && <div className="radar-notice">{notice}</div>}
      {firmaFuer && (
        <FirmenAuswahl
          onAbbruch={() => setFirmaFuer(null)}
          onWahl={(f) => void starte(firmaFuer.id, firmaFuer.dryRun, f)}
          onMehrere={(fs) => {
            const { id, dryRun } = firmaFuer;
            setFirmaFuer(null);
            void window.api.workflows.runBatch(id, fs, { dryRun }).then((r) => {
              setNotice(r.error ?? `${dryRun ? "Trockenlauf" : "Workflow"} für ${fs.length} Firmen gestartet — je Firma ein Lauf, Ergebnisse kommen als Meldungen.`);
              void reload();
            });
          }}
        />
      )}

      {approvals.length > 0 && (
        <section className="ct-card wf-approvals">
          <h3>Offene Freigaben ({approvals.length})</h3>
          <p className="muted small">Diese Workflows warten, bis du entscheidest. Ohne Entscheidung verfallen Freigaben nach 48 Stunden.</p>
          <div className="org-list">
            {approvals.map((a) => (
              <div key={a.id} className="org-row">
                <div className="org-row__main">
                  <span className="org-row__title">
                    {a.workflowName} · Schritt „{a.nodeName}“
                  </span>
                  <span className="org-row__meta">{a.prompt}</span>
                  {a.items.length > 0 && (
                    <details className="settings-collapse">
                      <summary>{a.items.length} betroffene Einträge</summary>
                      <pre className="wf-pre">{JSON.stringify(a.items.slice(0, 20).map((i) => i.json), null, 1)}</pre>
                    </details>
                  )}
                </div>
                <div className="org-row__actions">
                  <button type="button" className="primary" disabled={busy === a.id} onClick={() => void decide(a, true)}>
                    Freigeben
                  </button>
                  <button type="button" className="btn" disabled={busy === a.id} onClick={() => void decide(a, false)}>
                    Ablehnen
                  </button>
                </div>
              </div>
            ))}
          </div>
        </section>
      )}

      {inOrg && orgRows.length > 0 && (
        <section className="ct-card wf-approvals">
          <h3>Von der Organisation geteilt</h3>
          <p className="muted small">Übernehmen legt eine eigene Kopie an. Zugänge kommen aus deinen Einstellungen; Trigger und Freigaben setzt du selbst.</p>
          <div className="org-list">
            {orgRows.map((o) => (
              <div key={o.id} className="org-row">
                <div className="org-row__main">
                  <span className="org-row__title">
                    {o.name} <span className="muted">· v{o.version} · {o.nodeCount} Schritte</span>
                  </span>
                  <span className="org-row__meta">
                    {o.description || "—"} · geteilt von {o.sharedByName ?? `${o.sharedBy.slice(0, 8)}…`} am {new Date(o.updatedAt).toLocaleDateString("de-DE")}
                    {o.vonMir ? " · von dir" : ""}
                  </span>
                </div>
                <div className="org-row__actions">
                  <button type="button" className="primary" disabled={busy === o.id} onClick={() => void uebernehmen(o)}>
                    Übernehmen
                  </button>
                  {o.vonMir && (
                    <button
                      type="button"
                      className="link"
                      disabled={busy === o.id}
                      onClick={() => void window.api.workflows.orgRevoke(o.id).then(() => reload())}
                    >
                      Zurückziehen
                    </button>
                  )}
                </div>
              </div>
            ))}
          </div>
        </section>
      )}

      <details className="settings-collapse" open={vorlagenOffen || rows.length === 0} onToggle={(e) => setVorlagenOffen((e.target as HTMLDetailsElement).open)}>
        <summary>Vorlagen ({vorlagen.length})</summary>
        <div className="org-list">
          {vorlagen.map((v) => (
            <div key={v.id} className="org-row">
              <div className="org-row__main">
                <span className="org-row__title">
                  {v.name} <span className="muted">· Trigger {v.trigger}</span>
                </span>
                <span className="org-row__meta">{v.description}</span>
                {!v.verfuegbar && <span className="muted small warn">Nicht verfügbar: {v.fehlendeTools.join(", ")} (Funktion abgeschaltet oder nicht verbunden)</span>}
              </div>
              <div className="org-row__actions">
                <button
                  type="button"
                  className="primary"
                  disabled={!v.verfuegbar || busy === v.id}
                  onClick={() => {
                    setBusy(v.id);
                    void window.api.workflows.createFromTemplate(v.id).then((r) => {
                      setNotice(r.error ?? `Angelegt: ${(r.angelegt ?? []).join(", ")} — Trigger steht auf manuell, Schreib-Schritte sind nicht freigegeben.`);
                      setBusy(null);
                      void reload();
                    });
                  }}
                >
                  Anlegen
                </button>
              </div>
            </div>
          ))}
        </div>
      </details>

      {rows.length === 0 ? (
        <div className="radar-hint">
          Noch keine Workflows. Erarbeite einen Ablauf im <Link to="/chat">Chat</Link> und sag dann „speicher die Schritte als Workflow“, beschreibe direkt, was
          regelmäßig passieren soll, oder starte mit einer Vorlage oben.
        </div>
      ) : (
        <div className="wf-grid">
          {rows.map((w) => (
            <div key={w.id} className={`ct-card ct-card-lift wf-card${w.enabled ? "" : " wf-card--aus"}`}>
              <div className="wf-card__head">
                <button type="button" className="wf-card__title" onClick={() => navigate(`/workflows/${w.id}`)}>
                  {w.name}
                </button>
                <label className="field-inline" title={w.enabled ? "Aktiv — Trigger greifen" : "Pausiert — läuft nur manuell"}>
                  <input type="checkbox" checked={w.enabled} onChange={() => void toggle(w)} />
                  <span>aktiv</span>
                </label>
              </div>
              {w.description && <p className="muted small">{w.description}</p>}
              <div className="wf-card__meta">
                <span>{w.nodeCount} Schritte</span>
                <span>Trigger: {triggerText(w.trigger)}</span>
                {w.nextRunAt && <span>Nächster Lauf: {new Date(w.nextRunAt).toLocaleString("de-DE", { dateStyle: "short", timeStyle: "short" })}</span>}
              </div>
              <div className="wf-card__meta">
                {w.lastRun ? (
                  <>
                    {statusPill(w.lastRun.status)}
                    <span className="muted">
                      {new Date(w.lastRun.startedAt).toLocaleString("de-DE", { dateStyle: "short", timeStyle: "short" })}
                      {w.lastRun.summary ? ` — ${w.lastRun.summary}` : ""}
                    </span>
                  </>
                ) : (
                  <span className="muted">Noch nicht gelaufen.</span>
                )}
                {w.openApprovals > 0 && <span className="pill pill--paused">{w.openApprovals} Freigabe(n) offen</span>}
              </div>
              {w.blocked && <p className="muted small warn">{w.blocked}</p>}
              <div className="wf-card__actions">
                <button type="button" className="proc-toggle" disabled={busy === w.id || Boolean(w.blocked)} onClick={() => void run(w.id, true)}>
                  Trockenlauf
                </button>
                <button type="button" className="primary" disabled={busy === w.id || Boolean(w.blocked)} onClick={() => void run(w.id, false)}>
                  Jetzt ausführen
                </button>
                <Link to={`/workflows/${w.id}`} className="proc-toggle">
                  Öffnen
                </Link>
                {inOrg && (
                  <button type="button" className="proc-toggle" disabled={busy === w.id} onClick={() => void teilen(w)} title="Kopie der Definition für alle Mitglieder deiner Organisation">
                    Mit Organisation teilen
                  </button>
                )}
                <button type="button" className="link" onClick={() => void remove(w)}>
                  Löschen
                </button>
              </div>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

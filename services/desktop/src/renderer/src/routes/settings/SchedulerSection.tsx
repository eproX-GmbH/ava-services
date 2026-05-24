// v0.1.274 — Scheduler-Jobs UI.
//
// Liste aller wiederkehrenden Jobs + Inline-Create-Form für Mail-Loops.
// Live-Updates über scheduler:jobs-changed (push vom Supervisor).
//
// Aktion-Buttons pro Row:
//   - Pause / Resume (für status === "active" oder "paused")
//   - Stoppen (cancelled; harte Aktion, mit confirm)
//
// Edit eines bestehenden Jobs gibt's bewusst nicht in V1 — dafür kann
// der Nutzer Cancel + neu anlegen. Das vermeidet einen halben Refactor
// im Store (in-place-edit von Intervall/Empfänger wäre fragil).

import { useEffect, useMemo, useState, type FormEvent } from "react";
import type { ScheduledJob } from "../../../../shared/types";

export function SchedulerSection(): JSX.Element {
  const [jobs, setJobs] = useState<ScheduledJob[] | null>(null);
  const [createOpen, setCreateOpen] = useState(false);

  useEffect(() => {
    void window.api.scheduler.list().then(setJobs);
    const off = window.api.scheduler.onJobsChanged(setJobs);
    return () => off();
  }, []);

  const activeCount = useMemo(
    () => (jobs ?? []).filter((j) => j.status === "active").length,
    [jobs],
  );

  return (
    <section
      id="scheduler-section"
      className="provider-section alerts-prefs"
    >
      <h3>Wiederkehrende Aufgaben</h3>
      <p className="muted">
        AVA kann wiederkehrende Aktionen für dich ausführen (z. B. „alle
        5 Minuten eine Test-Mail senden"). Aktuell unterstützt: Mail-Loops.
        Empfänger müssen in der Mail-Allowlist stehen.{" "}
        <strong>
          {activeCount} aktive{activeCount === 1 ? "r" : ""} Job
          {activeCount === 1 ? "" : "s"} / max 10
        </strong>
        .
      </p>

      {jobs == null ? (
        <p className="muted">Lädt…</p>
      ) : jobs.length === 0 ? (
        <p className="muted">Noch keine Jobs angelegt.</p>
      ) : (
        <ul className="scheduler-list">
          {jobs.map((j) => (
            <JobRow key={j.id} job={j} />
          ))}
        </ul>
      )}

      <div className="scheduler-create">
        {!createOpen ? (
          <button type="button" onClick={() => setCreateOpen(true)}>
            + Neuen Mail-Loop anlegen
          </button>
        ) : (
          <CreateMailLoopForm
            onDone={() => setCreateOpen(false)}
            onCancel={() => setCreateOpen(false)}
          />
        )}
      </div>
    </section>
  );
}

function JobRow({ job }: { job: ScheduledJob }): JSX.Element {
  const [busy, setBusy] = useState(false);
  const onPause = async (): Promise<void> => {
    setBusy(true);
    try {
      await window.api.scheduler.pause(job.id);
    } finally {
      setBusy(false);
    }
  };
  const onResume = async (): Promise<void> => {
    setBusy(true);
    try {
      await window.api.scheduler.resume(job.id);
    } finally {
      setBusy(false);
    }
  };
  const onCancel = async (): Promise<void> => {
    if (
      !window.confirm(
        `Job "${job.label}" wirklich stoppen? Kann nicht rückgängig gemacht werden — du müsstest ihn neu anlegen.`,
      )
    )
      return;
    setBusy(true);
    try {
      await window.api.scheduler.cancel(job.id);
    } finally {
      setBusy(false);
    }
  };

  const statusLabel = STATUS_LABEL[job.status] ?? job.status;
  return (
    <li className={`scheduler-row scheduler-row--${job.status}`}>
      <div className="scheduler-row__main">
        <div className="scheduler-row__header">
          <strong>{job.label}</strong>
          <span className={`pill pill--${job.status}`}>{statusLabel}</span>
        </div>
        <div className="muted scheduler-row__meta">
          alle {job.intervalMinutes} min · {job.runsCompleted}/{job.runsCap} Runs
          {job.status === "active" && (
            <> · nächster Run: {formatRelative(job.nextRunAt)}</>
          )}
          · Auto-Stop {formatRelative(job.expiresAt)}
        </div>
        {/* v0.1.305 — Payload-Render abhängig von kind. mail-send zeigt
            Empfänger + Betreff, reminder zeigt die Reminder-Botschaft. */}
        {job.kind === "mail-send" && "to" in job.payload && (
          <div className="muted scheduler-row__meta">
            → {job.payload.to.join(", ")}
            {job.payload.cc && job.payload.cc.length > 0
              ? ` (CC: ${job.payload.cc.join(", ")})`
              : ""}
            {" · Betreff: "}
            <em>{job.payload.subject}</em>
          </div>
        )}
        {job.kind === "reminder" && "prompt" in job.payload && (
          <div className="muted scheduler-row__meta">
            {job.payload.companyName ? `Firma: ${job.payload.companyName} · ` : ""}
            <em>{job.payload.prompt.slice(0, 140)}{job.payload.prompt.length > 140 ? "…" : ""}</em>
          </div>
        )}
        {job.lastError && (
          <div className="scheduler-row__error">
            Letzter Fehler: {job.lastError}
          </div>
        )}
      </div>
      <div className="scheduler-row__actions">
        {job.status === "active" && (
          <button type="button" onClick={onPause} disabled={busy}>
            Pause
          </button>
        )}
        {job.status === "paused" && (
          <button type="button" onClick={onResume} disabled={busy}>
            Fortsetzen
          </button>
        )}
        {(job.status === "active" || job.status === "paused") && (
          <button
            type="button"
            onClick={onCancel}
            disabled={busy}
            className="danger"
          >
            Stoppen
          </button>
        )}
      </div>
    </li>
  );
}

const STATUS_LABEL: Record<ScheduledJob["status"], string> = {
  active: "aktiv",
  paused: "pausiert",
  expired: "abgelaufen",
  completed: "fertig",
  cancelled: "abgebrochen",
};

interface CreateMailLoopFormState {
  label: string;
  to: string;
  cc: string;
  subject: string;
  text: string;
  intervalMinutes: number;
  firstRunImmediately: boolean;
  expiresInHours: number;
}

const EMPTY_FORM: CreateMailLoopFormState = {
  label: "",
  to: "",
  cc: "",
  subject: "",
  text: "",
  intervalMinutes: 60,
  firstRunImmediately: false,
  expiresInHours: 24,
};

function CreateMailLoopForm({
  onDone,
  onCancel,
}: {
  onDone: () => void;
  onCancel: () => void;
}): JSX.Element {
  const [form, setForm] = useState<CreateMailLoopFormState>(EMPTY_FORM);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const onSubmit = async (e: FormEvent): Promise<void> => {
    e.preventDefault();
    setError(null);
    setBusy(true);
    try {
      const r = await window.api.scheduler.createMailLoop({
        label: form.label.trim(),
        to: splitAddresses(form.to),
        ...(form.cc.trim().length > 0
          ? { cc: splitAddresses(form.cc) }
          : {}),
        subject: form.subject.trim(),
        text: form.text,
        intervalMinutes: form.intervalMinutes,
        firstRunImmediately: form.firstRunImmediately,
        expiresInHours: form.expiresInHours,
      });
      if (!r.ok) {
        setError(r.error);
        return;
      }
      onDone();
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  };

  return (
    <form className="scheduler-form" onSubmit={onSubmit}>
      <h4>Neuen Mail-Loop anlegen</h4>
      <p className="muted">
        Min Intervall 1 min · Max 7 Tage Laufzeit · Empfänger müssen in
        der Mail-Allowlist stehen.
      </p>
      <label>
        <span>Label (kurz, was der Job tut)</span>
        <input
          type="text"
          required
          maxLength={200}
          value={form.label}
          onChange={(e) => setForm({ ...form, label: e.target.value })}
          placeholder="z. B. Stündlicher Status-Ping"
        />
      </label>
      <label>
        <span>An (Komma-getrennt, müssen in der Mail-Allowlist stehen)</span>
        <input
          type="text"
          required
          value={form.to}
          onChange={(e) => setForm({ ...form, to: e.target.value })}
          placeholder="joyce@quikk.de"
        />
      </label>
      <label>
        <span>CC (optional, Komma-getrennt)</span>
        <input
          type="text"
          value={form.cc}
          onChange={(e) => setForm({ ...form, cc: e.target.value })}
        />
      </label>
      <label>
        <span>Betreff</span>
        <input
          type="text"
          required
          maxLength={998}
          value={form.subject}
          onChange={(e) => setForm({ ...form, subject: e.target.value })}
        />
      </label>
      <label>
        <span>Inhalt</span>
        <textarea
          required
          rows={4}
          value={form.text}
          onChange={(e) => setForm({ ...form, text: e.target.value })}
        />
      </label>
      <div className="scheduler-form__row">
        <label>
          <span>Intervall (Minuten)</span>
          <input
            type="number"
            min={1}
            required
            value={form.intervalMinutes}
            onChange={(e) =>
              setForm({
                ...form,
                intervalMinutes: Math.max(1, parseInt(e.target.value, 10) || 1),
              })
            }
          />
        </label>
        <label>
          <span>Auto-Stop (Stunden, max 168)</span>
          <input
            type="number"
            min={1}
            max={168}
            required
            value={form.expiresInHours}
            onChange={(e) =>
              setForm({
                ...form,
                expiresInHours: clamp(parseInt(e.target.value, 10) || 24, 1, 168),
              })
            }
          />
        </label>
        <label className="scheduler-form__checkbox">
          <input
            type="checkbox"
            checked={form.firstRunImmediately}
            onChange={(e) =>
              setForm({ ...form, firstRunImmediately: e.target.checked })
            }
          />
          <span>Erste Mail sofort</span>
        </label>
      </div>
      {error && <div className="scheduler-form__error">Fehler: {error}</div>}
      <div className="scheduler-form__actions">
        <button type="submit" disabled={busy} className="primary">
          Job starten
        </button>
        <button type="button" onClick={onCancel} disabled={busy}>
          Abbrechen
        </button>
      </div>
    </form>
  );
}

function splitAddresses(input: string): string[] {
  return input
    .split(/[,;\n]/)
    .map((s) => s.trim())
    .filter((s) => s.length > 0);
}

function clamp(n: number, lo: number, hi: number): number {
  return Math.max(lo, Math.min(hi, n));
}

function formatRelative(iso: string): string {
  const d = new Date(iso).getTime();
  if (!Number.isFinite(d)) return iso;
  const diff = d - Date.now();
  const abs = Math.abs(diff);
  if (abs < 60_000) return diff > 0 ? "gleich" : "gerade eben";
  if (abs < 3_600_000) {
    const min = Math.round(abs / 60_000);
    return diff > 0 ? `in ${min} min` : `vor ${min} min`;
  }
  if (abs < 86_400_000) {
    const h = Math.round(abs / 3_600_000);
    return diff > 0 ? `in ${h} h` : `vor ${h} h`;
  }
  const days = Math.round(abs / 86_400_000);
  return diff > 0 ? `in ${days} Tagen` : `vor ${days} Tagen`;
}

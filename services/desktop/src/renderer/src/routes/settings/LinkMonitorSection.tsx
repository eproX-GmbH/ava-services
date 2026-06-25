// LM7 — Link-Überwachung UI.
//
// Liste aller überwachten Links + Inline-Form zum Anlegen/Bearbeiten.
// Live-Updates über link-monitor:changed (push vom Supervisor). Bewusst
// self-contained (lokaler useState wie SchedulerSection) — kein eigener
// zustand-Store nötig. Reuse der scheduler-*/pill-CSS-Klassen.

import { useEffect, useState, type FormEvent } from "react";
import type {
  LinkMonitor,
  LinkMonitorFrequencyPreset,
  LinkMonitorSnapshot,
} from "../../../../shared/types";
import {
  LINK_MONITOR_MAX_INTERVAL_MINUTES,
  LINK_MONITOR_MIN_INTERVAL_MINUTES,
  LINK_MONITOR_PRESET_MINUTES,
} from "../../../../shared/types";

const EMPTY_SNAPSHOT: LinkMonitorSnapshot = {
  monitors: [],
  activeCount: 0,
  cap: 5,
};

export function LinkMonitorSection(): JSX.Element {
  const [snap, setSnap] = useState<LinkMonitorSnapshot | null>(null);
  const [createOpen, setCreateOpen] = useState(false);

  useEffect(() => {
    void window.api.linkMonitor.list().then(setSnap);
    const off = window.api.linkMonitor.onChanged(setSnap);
    return () => off();
  }, []);

  const s = snap ?? EMPTY_SNAPSHOT;

  return (
    <section id="link-monitor-section" className="provider-section alerts-prefs">
      <h3>Link-Überwachung</h3>
      <p className="muted">
        AVA öffnet einen Link regelmäßig in einem Hintergrund-Browser und
        meldet dir, wenn sich etwas ändert (neue Produkte, Preise, Stellen,
        Profil-/Unternehmensseiten — LinkedIn-Links nutzen automatisch deine
        Anmeldung). Frequenz min. alle 5 Minuten, max. wöchentlich.{" "}
        <strong>
          {s.activeCount} aktiv / max {s.cap}
        </strong>
        . Überzählige werden pausiert angelegt.
      </p>

      {snap == null ? (
        <p className="muted">Lädt…</p>
      ) : s.monitors.length === 0 ? (
        <p className="muted">Noch keine Links in Überwachung.</p>
      ) : (
        <ul className="scheduler-list">
          {s.monitors.map((m) => (
            <MonitorRow key={m.id} monitor={m} />
          ))}
        </ul>
      )}

      <div className="scheduler-create">
        {!createOpen ? (
          <button type="button" onClick={() => setCreateOpen(true)}>
            + Link zur Überwachung hinzufügen
          </button>
        ) : (
          <MonitorForm
            mode="create"
            onDone={() => setCreateOpen(false)}
            onCancel={() => setCreateOpen(false)}
          />
        )}
      </div>
    </section>
  );
}

function MonitorRow({ monitor }: { monitor: LinkMonitor }): JSX.Element {
  const [busy, setBusy] = useState(false);
  const [editing, setEditing] = useState(false);

  const guard = async (fn: () => Promise<unknown>): Promise<void> => {
    setBusy(true);
    try {
      await fn();
    } finally {
      setBusy(false);
    }
  };

  const onDelete = async (): Promise<void> => {
    if (
      !window.confirm(
        `Überwachung für „${monitor.label}" wirklich löschen? Verlauf geht verloren.`,
      )
    )
      return;
    await guard(() => window.api.linkMonitor.remove(monitor.id));
  };

  const onResume = async (): Promise<void> => {
    const r = await window.api.linkMonitor.resume(monitor.id);
    if (!r.ok) window.alert(r.error);
  };

  if (editing) {
    return (
      <li className="scheduler-row">
        <MonitorForm
          mode="edit"
          monitor={monitor}
          onDone={() => setEditing(false)}
          onCancel={() => setEditing(false)}
        />
      </li>
    );
  }

  const statusLabel = STATUS_LABEL[monitor.status] ?? monitor.status;
  return (
    <li className={`scheduler-row scheduler-row--${monitor.status}`}>
      <div className="scheduler-row__main">
        <div className="scheduler-row__header">
          <strong>{monitor.label}</strong>
          <span className={`pill pill--${monitor.status}`}>{statusLabel}</span>
          {monitor.isLinkedIn && <span className="pill">LinkedIn</span>}
        </div>
        <div className="muted scheduler-row__meta">
          <a
            className="lm-url"
            href={monitor.url}
            target="_blank"
            rel="noreferrer"
            title={monitor.url}
          >
            {monitor.url}
          </a>
        </div>
        <div className="muted scheduler-row__meta">
          {intervalLabel(monitor.intervalMinutes)}
          {monitor.lastCheckedAt && (
            <> · zuletzt geprüft {formatRelative(monitor.lastCheckedAt)}</>
          )}
          {monitor.lastOutcome && <> · {OUTCOME_LABEL[monitor.lastOutcome] ?? monitor.lastOutcome}</>}
        </div>
        {monitor.instructions && (
          <div className="muted scheduler-row__meta">
            Achten auf: <em>{monitor.instructions}</em>
          </div>
        )}
        {monitor.lastChangeSummary && (
          <div className="muted scheduler-row__meta">
            Letzte Änderung
            {monitor.lastChangedAt
              ? ` (${formatRelative(monitor.lastChangedAt)})`
              : ""}
            : <em>{monitor.lastChangeSummary}</em>
          </div>
        )}
      </div>
      <div className="scheduler-row__actions">
        <button
          type="button"
          disabled={busy}
          onClick={() => guard(() => window.api.linkMonitor.runNow(monitor.id))}
        >
          Jetzt prüfen
        </button>
        {monitor.status === "active" ? (
          <button
            type="button"
            disabled={busy}
            onClick={() => guard(() => window.api.linkMonitor.pause(monitor.id))}
          >
            Pause
          </button>
        ) : (
          <button
            type="button"
            disabled={busy}
            onClick={() => guard(onResume)}
          >
            Fortsetzen
          </button>
        )}
        <button type="button" disabled={busy} onClick={() => setEditing(true)}>
          Bearbeiten
        </button>
        <button
          type="button"
          disabled={busy}
          className="danger"
          onClick={onDelete}
        >
          Löschen
        </button>
      </div>
    </li>
  );
}

const STATUS_LABEL: Record<LinkMonitor["status"], string> = {
  active: "aktiv",
  paused: "pausiert",
  error: "Fehler",
};

const OUTCOME_LABEL: Record<string, string> = {
  ok: "keine Änderung",
  changed: "Änderung erkannt",
  timeout: "Timeout (Teilergebnis)",
  error: "Fehler",
};

// ---- Form (create + edit) -------------------------------------------------

type FreqOption = LinkMonitorFrequencyPreset;

const FREQ_OPTIONS: { value: FreqOption; label: string }[] = [
  { value: "5min", label: "Alle 5 Minuten" },
  { value: "15min", label: "Alle 15 Minuten" },
  { value: "hourly", label: "Stündlich" },
  { value: "daily", label: "Täglich" },
  { value: "weekly", label: "Wöchentlich" },
  { value: "custom", label: "Benutzerdefiniert (Minuten)" },
];

function MonitorForm({
  mode,
  monitor,
  onDone,
  onCancel,
}: {
  mode: "create" | "edit";
  monitor?: LinkMonitor;
  onDone: () => void;
  onCancel: () => void;
}): JSX.Element {
  const [url, setUrl] = useState(monitor?.url ?? "");
  const [instructions, setInstructions] = useState(monitor?.instructions ?? "");
  const [freq, setFreq] = useState<FreqOption>(monitor?.frequencyPreset ?? "daily");
  const [customMinutes, setCustomMinutes] = useState<number>(
    monitor?.intervalMinutes ?? LINK_MONITOR_PRESET_MINUTES.daily,
  );
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const onSubmit = async (e: FormEvent): Promise<void> => {
    e.preventDefault();
    setError(null);
    setBusy(true);
    try {
      const freqPayload =
        freq === "custom"
          ? { intervalMinutes: clamp(customMinutes) }
          : { frequencyPreset: freq };
      if (mode === "create") {
        const r = await window.api.linkMonitor.create({
          url: url.trim(),
          instructions: instructions.trim() || undefined,
          ...freqPayload,
        });
        if (!r.ok) {
          setError(r.error);
          return;
        }
      } else if (monitor) {
        const r = await window.api.linkMonitor.update(monitor.id, {
          url: url.trim(),
          instructions: instructions.trim(),
          ...freqPayload,
        });
        if (!r.ok) {
          setError(r.error);
          return;
        }
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
      <h4>{mode === "create" ? "Neuen Link überwachen" : "Überwachung bearbeiten"}</h4>
      <label>
        <span>Link (URL)</span>
        <input
          type="text"
          required
          value={url}
          onChange={(e) => setUrl(e.target.value)}
          placeholder="https://example.com/produkte"
        />
      </label>
      <label>
        <span>Worauf achten? (optional)</span>
        <textarea
          rows={2}
          value={instructions}
          onChange={(e) => setInstructions(e.target.value)}
          placeholder="z. B. Pagination durchgehen, auf neue Produkte achten"
        />
      </label>
      <div className="scheduler-form__row">
        <label>
          <span>Frequenz</span>
          <select
            value={freq}
            onChange={(e) => setFreq(e.target.value as FreqOption)}
          >
            {FREQ_OPTIONS.map((o) => (
              <option key={o.value} value={o.value}>
                {o.label}
              </option>
            ))}
          </select>
        </label>
        {freq === "custom" && (
          <label>
            <span>Minuten (5–10080)</span>
            <input
              type="number"
              min={LINK_MONITOR_MIN_INTERVAL_MINUTES}
              max={LINK_MONITOR_MAX_INTERVAL_MINUTES}
              value={customMinutes}
              onChange={(e) =>
                setCustomMinutes(clamp(parseInt(e.target.value, 10) || 0))
              }
            />
          </label>
        )}
      </div>
      {error && <div className="scheduler-form__error">Fehler: {error}</div>}
      <div className="scheduler-form__actions">
        <button type="submit" disabled={busy} className="primary">
          {mode === "create" ? "Überwachung starten" : "Speichern"}
        </button>
        <button type="button" onClick={onCancel} disabled={busy}>
          Abbrechen
        </button>
      </div>
    </form>
  );
}

// ---- Helpers --------------------------------------------------------------

function clamp(n: number): number {
  return Math.max(
    LINK_MONITOR_MIN_INTERVAL_MINUTES,
    Math.min(LINK_MONITOR_MAX_INTERVAL_MINUTES, Math.round(n)),
  );
}

function intervalLabel(minutes: number): string {
  if (minutes % (24 * 60) === 0) {
    const d = minutes / (24 * 60);
    return d === 7 ? "wöchentlich" : d === 1 ? "täglich" : `alle ${d} Tage`;
  }
  if (minutes % 60 === 0) {
    const h = minutes / 60;
    return h === 1 ? "stündlich" : `alle ${h} Stunden`;
  }
  return `alle ${minutes} Minuten`;
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

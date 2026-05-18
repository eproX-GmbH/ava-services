import { useEffect, useMemo, useState } from "react";
import { pullModelTracked, useOllamaStore } from "../store/ollama";
import { classifyOllamaPullError } from "../lib/ollama-pull-error";
import type { OllamaPullProgress } from "../../../shared/types";

// v0.1.220 — Status des Self-Updaters, geteilt vom OllamaUpdater.
type UpdaterState =
  | "idle"
  | "checking"
  | "downloading"
  | "installing"
  | "ready"
  | "error";

interface UpdaterFrame {
  state: UpdaterState;
  percent?: number;
  bytesPerSec?: number;
  message?: string;
  /** v0.1.221 — Version, die gerade heruntergeladen / installiert wird. */
  targetVersion?: string;
  /** v0.1.221 — Version, die erfolgreich installiert wurde (state=ready). */
  version?: string;
}

// Download Dock (Phase 8.k10c).
//
// Floating progress widget bottom-right, sibling to the routed app.
// Renders ANY in-flight or recently-completed Ollama pull, regardless
// of who started it (FirstRunWizard, Whoami's "Download" affordance,
// future agent-tool-driven pulls, …). The dock is the single shared
// surface so we don't end up with three places that all show the same
// progress bar slightly differently.
//
// Two visual states:
//
//   - Maximized: 360 px wide card with one row per pull, full
//     bytes/total/speed/ETA line, and a "Done · clear" affordance for
//     finished rows.
//
//   - Minimized: 56 px circular button with an SVG ring fill driven by
//     the *aggregate* completed-bytes / total-bytes across every active
//     row. We deliberately use byte-weighted aggregation rather than
//     "average percent" so a 600 MB embedding doesn't visually dominate
//     a 9.6 GB LLM that shares the dock.
//
// Lifecycle: the dock is always mounted. It returns null when there's
// nothing to show (no active pulls, no pinned-done rows). The user
// dismisses finished rows via the per-row clear or the "Clear all" link.

export function DownloadDock() {
  const pullProgress = useOllamaStore((s) => s.pullProgress);
  const pullRate = useOllamaStore((s) => s.pullRate);
  const activePulls = useOllamaStore((s) => s.activePulls);
  const dismissPull = useOllamaStore((s) => s.dismissPull);
  const status = useOllamaStore((s) => s.status);
  const [minimized, setMinimized] = useState(false);

  // Build the row list: every model the user has touched in this session
  // (active or pinned-done), ordered by status.required then by name so
  // the user sees the bundled-required models above any ad-hoc pulls
  // they kicked from Whoami.
  const rows = useMemo(
    () => buildRows(pullProgress, activePulls, status.required),
    [pullProgress, activePulls, status.required],
  );

  if (rows.length === 0) return null;

  const aggregate = computeAggregate(rows);
  const allDone = rows.every((r) => r.kind === "done" || r.kind === "failed");

  if (minimized) {
    return (
      <button
        type="button"
        className={`dl-dock dl-dock--mini ${allDone ? "dl-dock--ok" : ""}`}
        onClick={() => setMinimized(false)}
        aria-label={`${rows.length} Download${rows.length === 1 ? "" : "s"}, zum Aufklappen klicken`}
        title={summariseTooltip(rows, aggregate)}
      >
        <ProgressRing pct={aggregate.pct} done={allDone} />
        <span className="dl-dock__mini-count">{rows.length}</span>
      </button>
    );
  }

  return (
    <section className="dl-dock dl-dock--max" role="status" aria-label="Modell-Downloads">
      <header className="dl-dock__head">
        <strong>
          {allDone
            ? `Downloads abgeschlossen (${rows.length})`
            : `${rows.length} ${rows.length === 1 ? "Modell wird" : "Modelle werden"} geladen`}
        </strong>
        <span className="dl-dock__head-spacer" />
        {allDone && (
          <button
            type="button"
            className="link"
            onClick={() => rows.forEach((r) => dismissPull(r.modelName))}
            title="Alle abgeschlossenen Zeilen ausblenden"
          >
            Alle ausblenden
          </button>
        )}
        <button
          type="button"
          className="dl-dock__icon-btn"
          onClick={() => setMinimized(true)}
          aria-label="Minimieren"
          title="Minimieren"
        >
          ▾
        </button>
      </header>
      <ul className="dl-dock__list">
        {rows.map((r) => (
          <li key={r.modelName}>
            <DockRow
              row={r}
              bytesPerSec={pullRate[r.modelName]?.bytesPerSec ?? 0}
              onDismiss={() => dismissPull(r.modelName)}
            />
          </li>
        ))}
      </ul>
    </section>
  );
}

// -- Row rendering ----------------------------------------------------

type DockRowKind = "active" | "done" | "failed" | "queued" | "retrying";

interface DockRowData {
  modelName: string;
  kind: DockRowKind;
  completed: number;
  total: number;
  status?: string;
  errorMessage?: string;
  attempt?: number;
  maxAttempts?: number;
}

function DockRow({
  row,
  bytesPerSec,
  onDismiss,
}: {
  row: DockRowData;
  bytesPerSec: number;
  onDismiss: () => void;
}) {
  const pct = row.total > 0 ? Math.min(100, (row.completed / row.total) * 100) : 0;
  const showSpeed = row.kind === "active" && bytesPerSec > 0;
  const remaining = Math.max(row.total - row.completed, 0);
  const etaSec = showSpeed && bytesPerSec > 0 ? remaining / bytesPerSec : null;
  const attemptSuffix =
    row.attempt && row.maxAttempts && row.attempt > 1
      ? ` (Versuch ${row.attempt}/${row.maxAttempts})`
      : "";

  return (
    <div className="dl-dock__row">
      <div className="dl-dock__row-head">
        <code className="dl-dock__row-name">{row.modelName}</code>
        {row.kind === "failed" && (
          <button
            type="button"
            className="dl-dock__retry-btn"
            onClick={() => {
              // Re-invoke the same tracked pull. Ollama resumes from
              // existing partial layers, so the user doesn't lose the
              // bytes they already pulled. We swallow the rejection
              // because the dock will already render the failure state
              // if the next attempt also fails.
              void pullModelTracked(row.modelName).catch(() => undefined);
            }}
            title="Erneut versuchen, setzt am unterbrochenen Stand fort"
          >
            Erneut
          </button>
        )}
        {(row.kind === "done" || row.kind === "failed") && (
          <button
            type="button"
            className="dl-dock__icon-btn"
            onClick={onDismiss}
            aria-label="Ausblenden"
            title="Ausblenden"
          >
            ✕
          </button>
        )}
      </div>
      <div className="dl-dock__bar">
        <div
          className={`dl-dock__bar-fill ${
            row.kind === "failed"
              ? "bad"
              : row.kind === "done"
                ? "ok"
                : row.kind === "queued"
                  ? ""
                  : "warn"
          }`}
          style={{ width: `${row.kind === "done" ? 100 : pct}%` }}
        />
      </div>
      <div className="dl-dock__row-meter muted">
        {row.kind === "queued" && <span>Wartet…</span>}
        {row.kind === "retrying" && (
          <span className="warn">
            Verbinde erneut{attemptSuffix}
            {row.completed > 0 && row.total > 0 ? (
              <>
                {" "}· pausiert bei {formatBytes(row.completed)} /{" "}
                {formatBytes(row.total)}
              </>
            ) : null}
            …
          </span>
        )}
        {row.kind === "failed" && (() => {
          // v0.1.220 — Pull-Fehler humanisiert + bei
          // Version-Mismatch (alte Ollama-Binary) zusätzlich den
          // Self-Update-Knopf einblenden. Die rohe Meldung bleibt
          // unter <details> erreichbar.
          const cat = classifyOllamaPullError(row.errorMessage ?? row.status ?? "");
          if (!cat) {
            return (
              <span className="bad">
                Fehlgeschlagen{attemptSuffix}: {row.errorMessage ?? "Unbekannter Fehler"}
              </span>
            );
          }
          return (
            <div className="dl-dock__row-error">
              <span className="bad">
                Fehlgeschlagen{attemptSuffix}: {cat.friendly}
              </span>
              {cat.hint && (
                <span className="muted small">{cat.hint}</span>
              )}
              {cat.category === "version-mismatch" && (
                <OllamaUpdateAffordance
                  onSuccessRetry={() =>
                    void pullModelTracked(row.modelName).catch(() => undefined)
                  }
                />
              )}
              {cat.category !== "unknown" && row.errorMessage && (
                <details className="dl-dock__row-error-details">
                  <summary>Original-Fehlermeldung</summary>
                  <pre>{row.errorMessage}</pre>
                </details>
              )}
            </div>
          );
        })()}
        {row.kind === "done" && <span>Fertig ✓</span>}
        {row.kind === "active" && (
          <>
            {row.completed > 0 ? (
              <span>
                {formatBytes(row.completed)} / {formatBytes(row.total)} (
                {pct.toFixed(1)}%)
              </span>
            ) : (
              <span>{row.status ?? "Startet…"}</span>
            )}
            {showSpeed && (
              <>
                <span className="dl-dock__sep">·</span>
                <span>{formatBytes(bytesPerSec)}/s</span>
              </>
            )}
            {etaSec !== null && Number.isFinite(etaSec) && (
              <>
                <span className="dl-dock__sep">·</span>
                <span>ETA {formatDuration(etaSec)}</span>
              </>
            )}
          </>
        )}
      </div>
    </div>
  );
}

// -- SVG progress ring (minimized state) ------------------------------

function ProgressRing({ pct, done }: { pct: number; done: boolean }) {
  // Geometry: 56 px button, 22 px stroke radius, 4 px stroke. The
  // circumference is ~138.2 (2πr); we offset stroke-dashoffset by
  // (1-pct) * circumference to fill clockwise from 12 o'clock.
  const radius = 22;
  const circumference = 2 * Math.PI * radius;
  const clamped = Math.max(0, Math.min(100, pct));
  const offset = circumference * (1 - clamped / 100);
  return (
    <svg
      className="dl-dock__ring"
      viewBox="0 0 56 56"
      width="56"
      height="56"
      aria-hidden="true"
    >
      <circle
        cx="28"
        cy="28"
        r={radius}
        className="dl-dock__ring-track"
        fill="none"
        strokeWidth="4"
      />
      <circle
        cx="28"
        cy="28"
        r={radius}
        className={`dl-dock__ring-fill ${done ? "ok" : ""}`}
        fill="none"
        strokeWidth="4"
        strokeLinecap="round"
        strokeDasharray={circumference}
        strokeDashoffset={offset}
        // Rotate -90deg so 0% is at 12 o'clock instead of 3 o'clock.
        transform="rotate(-90 28 28)"
      />
    </svg>
  );
}

// -- Helpers ----------------------------------------------------------

interface RequiredSpec {
  name: string;
}

function buildRows(
  pullProgress: Record<string, OllamaPullProgress>,
  activePulls: Record<string, true>,
  required: ReadonlyArray<RequiredSpec>,
): DockRowData[] {
  // Models that have appeared in either the progress map (any frame
  // ever seen) or the activePulls map (clicked but no frame yet).
  const names = new Set<string>([
    ...Object.keys(pullProgress),
    ...Object.keys(activePulls),
  ]);
  if (names.size === 0) return [];

  const rows: DockRowData[] = [];
  for (const name of names) {
    const p = pullProgress[name];
    if (!p) {
      // Pull was started but no frame yet — render as "Queued".
      rows.push({
        modelName: name,
        kind: "queued",
        completed: 0,
        total: 0,
      });
      continue;
    }
    if (p.done) {
      rows.push({
        modelName: name,
        kind: p.errorMessage ? "failed" : "done",
        completed: p.completed ?? 0,
        total: p.total ?? 0,
        status: p.status,
        errorMessage: p.errorMessage,
        attempt: p.attempt,
        maxAttempts: p.maxAttempts,
      });
      continue;
    }
    rows.push({
      modelName: name,
      kind: p.retrying ? "retrying" : "active",
      completed: p.completed ?? 0,
      total: p.total ?? 0,
      status: p.status,
      attempt: p.attempt,
      maxAttempts: p.maxAttempts,
    });
  }

  // Stable ordering: required models in their catalog order first, then
  // any ad-hoc pulls (e.g. Whoami → "download Llama 3.1") alphabetically.
  // This keeps the bundled embedding/LLM rows pinned at the top during
  // first-run while extra rows append below.
  const requiredOrder = new Map<string, number>();
  required.forEach((r, i) => requiredOrder.set(r.name, i));
  rows.sort((a, b) => {
    const ai = requiredOrder.get(a.modelName);
    const bi = requiredOrder.get(b.modelName);
    if (ai !== undefined && bi !== undefined) return ai - bi;
    if (ai !== undefined) return -1;
    if (bi !== undefined) return 1;
    return a.modelName.localeCompare(b.modelName);
  });
  return rows;
}

function computeAggregate(rows: DockRowData[]): {
  completed: number;
  total: number;
  pct: number;
} {
  let completed = 0;
  let total = 0;
  for (const r of rows) {
    // For done rows, count their full size into both numerator and
    // denominator so the ring stays at 100% even if Ollama's last frame
    // didn't carry the final `total`.
    if (r.kind === "done") {
      const size = Math.max(r.total, r.completed, 1);
      completed += size;
      total += size;
      continue;
    }
    if (r.kind === "failed") {
      // Failed rows count as "done with no progress" so the ring doesn't
      // visually pretend the failure was successful — but we also don't
      // want a single failure to drag the ring back to ~0%, so we attribute
      // its "weight" to whatever bytes did make it through plus a token
      // 1 byte denominator.
      total += Math.max(r.total, r.completed, 1);
      completed += r.completed;
      continue;
    }
    completed += r.completed;
    total += r.total;
  }
  const pct = total > 0 ? Math.min(100, (completed / total) * 100) : 0;
  return { completed, total, pct };
}

function summariseTooltip(
  rows: DockRowData[],
  agg: { completed: number; total: number; pct: number },
): string {
  const active = rows.filter((r) => r.kind === "active" || r.kind === "queued");
  const done = rows.filter((r) => r.kind === "done").length;
  const failed = rows.filter((r) => r.kind === "failed").length;
  const parts: string[] = [];
  if (active.length > 0) {
    parts.push(
      `${active.length} aktiv · ${agg.pct.toFixed(0)}% (${formatBytes(agg.completed)}/${formatBytes(agg.total)})`,
    );
  }
  if (done > 0) parts.push(`${done} fertig`);
  if (failed > 0) parts.push(`${failed} fehlgeschlagen`);
  return parts.join(" · ");
}

function formatBytes(n: number): string {
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
  if (n < 1024 * 1024 * 1024) return `${(n / 1024 / 1024).toFixed(1)} MB`;
  return `${(n / 1024 / 1024 / 1024).toFixed(1)} GB`;
}

function formatDuration(sec: number): string {
  if (!Number.isFinite(sec) || sec < 0) return "";
  if (sec < 60) return `${Math.round(sec)}s`;
  if (sec < 3600) {
    const m = Math.floor(sec / 60);
    const s = Math.round(sec % 60);
    return s === 0 ? `${m}m` : `${m}m ${s}s`;
  }
  const h = Math.floor(sec / 3600);
  const m = Math.round((sec % 3600) / 60);
  return m === 0 ? `${h}h` : `${h}h ${m}m`;
}

// v0.1.220 — Inline-Komponente für den "Ollama jetzt aktualisieren"-Knopf
// im Download-Dock. Subscriben auf den OllamaUpdater-Status und
// rendern je nach State entsprechend.
function OllamaUpdateAffordance({
  onSuccessRetry,
}: {
  onSuccessRetry: () => void;
}) {
  const [updater, setUpdater] = useState<UpdaterFrame>({ state: "idle" });

  useEffect(() => {
    let cancelled = false;
    void window.api.ollama.getUpdaterState().then((s) => {
      if (!cancelled) setUpdater(s as UpdaterFrame);
    });
    const off = window.api.ollama.onUpdaterState((s) => {
      setUpdater(s as UpdaterFrame);
    });
    return () => {
      cancelled = true;
      off();
    };
  }, []);

  const trigger = async (): Promise<void> => {
    const result = await window.api.ollama.updateBinary();
    if (result.state === "ready") {
      // Wenig später nochmal versuchen, der Supervisor braucht ein paar
      // Sekunden um mit der neuen Binary frisch zu starten.
      setTimeout(onSuccessRetry, 1500);
    }
  };

  if (updater.state === "downloading") {
    const pct = updater.percent ?? 0;
    const speed = updater.bytesPerSec ?? 0;
    const versionLabel = updater.targetVersion
      ? ` ${updater.targetVersion}`
      : "";
    return (
      <div className="dl-dock__updater">
        <span className="muted small">
          Lade Ollama{versionLabel} herunter… {pct}%
          {speed > 0 ? ` · ${formatBytes(speed)}/s` : ""}
        </span>
      </div>
    );
  }
  if (updater.state === "checking") {
    return (
      <span className="muted small">
        Prüfe neueste Ollama-Version…
      </span>
    );
  }
  if (updater.state === "installing") {
    const versionLabel = updater.targetVersion
      ? ` ${updater.targetVersion}`
      : "";
    return (
      <span className="muted small">
        Installiere Ollama{versionLabel}…
      </span>
    );
  }
  if (updater.state === "ready") {
    const versionLabel = updater.version ? ` ${updater.version}` : "";
    return (
      <span className="muted small">
        Ollama{versionLabel} installiert. Versuche den Download in Kürze
        erneut…
      </span>
    );
  }
  if (updater.state === "error") {
    return (
      <div className="dl-dock__updater">
        <span className="bad small">
          Update fehlgeschlagen: {updater.message ?? "Unbekannter Fehler"}
        </span>
        <button
          type="button"
          className="dl-dock__retry-btn"
          onClick={() => void trigger()}
        >
          Erneut versuchen
        </button>
      </div>
    );
  }
  return (
    <button
      type="button"
      className="dl-dock__retry-btn"
      onClick={() => void trigger()}
    >
      Ollama jetzt aktualisieren
    </button>
  );
}

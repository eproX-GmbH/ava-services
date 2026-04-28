import { useState } from "react";
import { useOllamaStore } from "../store/ollama";
import type {
  OllamaModelSpec,
  OllamaPullProgress,
} from "../../../shared/types";

// First-run wizard (D7).
//
// Shown on top of the app shell when the supervisor reports missing
// required models. A single "Download all" button kicks off pulls for
// each missing model in sequence — sequential, not parallel, because
// Ollama's pull throughput is bounded by network anyway and serial pulls
// give a cleaner progress story (one bar advances at a time).
//
// The wizard does not block sign-in: auth runs first so we know the user
// before committing ~4GB of disk to model downloads. If the supervisor
// is in `error` state we surface that instead of a download UI — there's
// nothing useful to do until the binary is reachable.

interface MemoryProbe {
  writable: boolean;
  reason?: string;
  path: string;
}

export function FirstRunWizard({
  memoryProbe,
}: { memoryProbe?: MemoryProbe | null } = {}) {
  const status = useOllamaStore((s) => s.status);
  const pullProgress = useOllamaStore((s) => s.pullProgress);
  const pullRate = useOllamaStore((s) => s.pullRate);
  const [running, setRunning] = useState(false);
  const [errorMessage, setErrorMessage] = useState<string | null>(null);

  if (status.state === "error") {
    return (
      <div className="first-run">
        <div className="first-run__card">
          <h1>Local model runtime unavailable</h1>
          <p className="bad">{status.errorMessage ?? "Unknown error"}</p>
          <p className="muted">
            Reinstall the app, or set <code>OLLAMA_BIN</code> to a working
            Ollama binary if you're running a development build. The rest of
            the app stays disabled until this clears.
          </p>
        </div>
      </div>
    );
  }

  if (status.state === "starting" || status.state === "idle") {
    return (
      <div className="first-run">
        <div className="first-run__card">
          <h1>Starting local model runtime…</h1>
          <p className="muted">
            This usually takes a few seconds on first launch.
          </p>
        </div>
      </div>
    );
  }

  const onDownloadAll = async () => {
    setRunning(true);
    setErrorMessage(null);
    try {
      // Sequential. The per-model progress is broadcast over IPC so we
      // don't need to thread it through the await chain.
      for (const model of status.missing) {
        await window.api.ollama.pullModel(model.name);
      }
    } catch (err) {
      setErrorMessage(err instanceof Error ? err.message : String(err));
    } finally {
      setRunning(false);
    }
  };

  // Memory-dir probe failure is non-blocking — we still let the user
  // download models and use the app. We just flag that transcripts won't
  // persist so they aren't surprised after a restart.
  const memoryWarning =
    memoryProbe && !memoryProbe.writable ? (
      <p className="warn">
        Conversation memory is disabled — couldn't write to{" "}
        <code>{memoryProbe.path}</code>
        {memoryProbe.reason ? <> ({memoryProbe.reason})</> : null}. The agent
        will still work, but transcripts won't survive a restart.
      </p>
    ) : null;

  return (
    <div className="first-run">
      <div className="first-run__card">
        <h1>Download local models</h1>
        {memoryWarning}
        <p className="muted">
          AVA Desktop runs its language and embedding models locally via Ollama.
          We need to download {status.missing.length}{" "}
          {status.missing.length === 1 ? "model" : "models"} before you can
          continue. This happens once per machine.
        </p>

        <ul className="first-run__list">
          {status.missing.map((model) => (
            <li key={model.name}>
              <ModelRow
                model={model}
                progress={pullProgress[model.name]}
                bytesPerSec={pullRate[model.name]?.bytesPerSec ?? 0}
                running={running}
              />
            </li>
          ))}
        </ul>

        {errorMessage && <p className="bad">{errorMessage}</p>}

        <button
          type="button"
          onClick={onDownloadAll}
          disabled={running || status.missing.length === 0}
        >
          {running
            ? "Downloading…"
            : status.missing.length === 0
              ? "All models present ✓"
              : `Download all (${status.missing.length})`}
        </button>
      </div>
    </div>
  );
}

function ModelRow({
  model,
  progress,
  bytesPerSec,
  running,
}: {
  model: OllamaModelSpec;
  progress: OllamaPullProgress | undefined;
  /** Smoothed download rate from the renderer-side EMA. 0 means
   *  "not transferring right now" (queued, paused, finishing up). */
  bytesPerSec: number;
  running: boolean;
}) {
  const total = progress?.total ?? model.approxBytes;
  const completed = progress?.completed ?? 0;
  const pct = total > 0 ? Math.min(100, (completed / total) * 100) : 0;
  const done = progress?.done === true && !progress.errorMessage;
  const failed = progress?.done === true && Boolean(progress.errorMessage);

  // The "byte progress" line is the one the user actually scans for —
  // they want to see numbers move. We always show it once a pull frame
  // exists (even if Ollama hasn't reported `total` yet, falling back to
  // the catalog's approxBytes), so the user immediately sees this isn't
  // stuck. While idle/queued we hide the line and just show the size.
  const showBytes = running && !failed && !done && completed > 0;
  // Speed must sustain >0 to display — see the EMA reset rules in the
  // store. We also skip "bytes/sec" once we're in the final post-stream
  // phase ("verifying digest", "extracting") where data has stopped
  // flowing but the row is still active.
  const showSpeed = showBytes && bytesPerSec > 0;
  const remaining = Math.max(total - completed, 0);
  const etaSec = showSpeed && bytesPerSec > 0 ? remaining / bytesPerSec : null;

  return (
    <div className="first-run__model">
      <div className="first-run__model-head">
        <span className="first-run__model-name">
          <code>{model.name}</code>{" "}
          <span className="muted">({model.role})</span>
        </span>
        <span className="muted first-run__model-status">
          {failed
            ? `Failed: ${progress?.errorMessage}`
            : done
              ? "Done ✓"
              : running
                ? (progress?.status ?? "Queued")
                : `≈${formatBytes(model.approxBytes)} download`}
        </span>
      </div>
      <div className="first-run__bar">
        <div
          className={`first-run__bar-fill ${
            failed ? "bad" : done ? "ok" : running ? "warn" : ""
          }`}
          style={{ width: `${done ? 100 : pct}%` }}
        />
      </div>
      {showBytes && (
        <div className="first-run__model-meter muted">
          <span>
            {formatBytes(completed)} / {formatBytes(total)} ({pct.toFixed(1)}%)
          </span>
          {showSpeed && (
            <>
              <span className="first-run__model-sep">·</span>
              <span>{formatBytes(bytesPerSec)}/s</span>
            </>
          )}
          {etaSec !== null && Number.isFinite(etaSec) && (
            <>
              <span className="first-run__model-sep">·</span>
              <span>ETA {formatDuration(etaSec)}</span>
            </>
          )}
        </div>
      )}
    </div>
  );
}

function formatBytes(n: number): string {
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
  if (n < 1024 * 1024 * 1024) return `${(n / 1024 / 1024).toFixed(1)} MB`;
  return `${(n / 1024 / 1024 / 1024).toFixed(1)} GB`;
}

function formatDuration(sec: number): string {
  if (!Number.isFinite(sec) || sec < 0) return "—";
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

import { create } from "zustand";
import type { OllamaPullProgress, OllamaStatus } from "../../../shared/types";

// Ollama supervisor mirror (D7).
//
// Same pattern as the auth store: main owns the truth (the child process
// handle, the model catalog, the live `/api/tags` poll), the renderer
// keeps a synchronous-readable mirror here. Status pushes from main flip
// `ready` on first arrival so App.tsx can wait for a real status before
// deciding whether to show the FirstRunWizard.
//
// We also track the most recent pull-progress frame per model so the
// wizard can render a progress bar without subscribing in every component.

/**
 * Smoothed download-rate snapshot, computed renderer-side from the
 * coalesced `OllamaPullProgress` stream the supervisor emits at ~5 Hz.
 *
 * We use an exponential moving average rather than instantaneous
 * frame-to-frame deltas because Ollama's HTTP/2 stream tends to chunk —
 * one frame can carry 30 MB while the next carries 0, which makes a
 * naive `Δbytes / Δt` jump between "120 MB/s" and "0 MB/s" every tick.
 * `bytesPerSec` is meant for human-readable display; the underlying
 * `completed` field stays authoritative for the bar geometry.
 */
interface OllamaPullRate {
  bytesPerSec: number;
  /** Wall-clock of the most recent contributing frame. Used to age out
   *  the rate when a stream stalls so we don't keep showing "12 MB/s"
   *  forever after the network quiesces. */
  updatedAt: number;
  /** Last `completed` byte count we saw, so the next setPullProgress
   *  can compute Δbytes without remembering the prior frame separately. */
  lastCompleted: number;
}

interface OllamaState {
  ready: boolean;
  status: OllamaStatus;
  /** Most recent progress frame keyed by model name. Final frames stay
   *  pinned until a fresh pull starts so the wizard can show "✓ done". */
  pullProgress: Record<string, OllamaPullProgress>;
  /** Renderer-derived smoothed download rate per model. See
   *  {@link OllamaPullRate}. Cleared when a pull starts fresh (a
   *  completed=0 frame arriving after a `done:true` for the same model). */
  pullRate: Record<string, OllamaPullRate>;
  /**
   * Models the renderer has explicitly asked main to pull. Used by the
   * Download Dock (Phase 8.k10c) to know what to render even before the
   * first progress frame arrives — the pullModel IPC call resolves on
   * the *final* frame, so without this set the dock would show nothing
   * during the latency between click and first frame. Cleared once we
   * see a `done` frame.
   */
  activePulls: Record<string, true>;

  setStatus: (status: OllamaStatus) => void;
  setPullProgress: (progress: OllamaPullProgress) => void;
  /**
   * Mark a model pull as in-flight. Called by `pullModelTracked` (the
   * thin renderer wrapper around the preload IPC) right before it
   * invokes the IPC, so the dock can show a "Queued / 0%" row instead
   * of nothing during the gap before the first progress frame.
   */
  markPullStarted: (modelName: string) => void;
  /**
   * Discard a finished pull from the dock entirely (renders nothing
   * until the next pullStart). Triggered by the user-facing "clear
   * completed" button. Doesn't touch pullRate, since that's free.
   */
  dismissPull: (modelName: string) => void;
}

// EMA smoothing factor. 0.3 keeps the display responsive (~3-frame
// half-life at our 5 Hz flush cadence ≈ 600 ms) without the wild swings
// you get from raw frame-to-frame deltas.
const RATE_EMA_ALPHA = 0.3;

const INITIAL_STATUS: OllamaStatus = {
  state: "idle",
  host: null,
  required: [],
  installed: [],
  missing: [],
  errorMessage: null,
};

export const useOllamaStore = create<OllamaState>((setState) => ({
  ready: false,
  status: INITIAL_STATUS,
  pullProgress: {},
  pullRate: {},
  activePulls: {},
  markPullStarted: (modelName) =>
    setState((s) => ({
      activePulls: { ...s.activePulls, [modelName]: true },
      // Wipe any stale "done" frame from a previous run so the dock
      // shows a fresh "queued" row rather than the prior pull's tail.
      pullProgress: (() => {
        const next = { ...s.pullProgress };
        delete next[modelName];
        return next;
      })(),
    })),
  dismissPull: (modelName) =>
    setState((s) => {
      const nextProgress = { ...s.pullProgress };
      delete nextProgress[modelName];
      const nextActive = { ...s.activePulls };
      delete nextActive[modelName];
      return { pullProgress: nextProgress, activePulls: nextActive };
    }),
  setStatus: (status) => setState({ status, ready: true }),
  setPullProgress: (progress) =>
    setState((s) => {
      const now = Date.now();
      const prevRate = s.pullRate[progress.modelName];
      const completed = progress.completed ?? 0;

      // Detect "fresh pull starting after a previous done" — drop the old
      // rate so we don't anchor on a stale 0 B/s reading from the tail of
      // the previous run.
      const prevWasDone = s.pullProgress[progress.modelName]?.done === true;
      const isReset = prevWasDone && completed === 0;

      let nextRate: OllamaPullRate | undefined = prevRate;
      if (isReset || !prevRate) {
        // First frame of this pull: just seed the baseline. We don't have
        // a Δt yet, so leave bytesPerSec at 0 — the next frame will fill it.
        nextRate = { bytesPerSec: 0, updatedAt: now, lastCompleted: completed };
      } else if (progress.done) {
        // Final frame: stop smoothing, hold the rate at 0 so the UI can
        // collapse to "Done ✓" without a phantom speed.
        nextRate = { bytesPerSec: 0, updatedAt: now, lastCompleted: completed };
      } else {
        const dtSec = Math.max((now - prevRate.updatedAt) / 1000, 0.001);
        const dBytes = Math.max(completed - prevRate.lastCompleted, 0);
        // Skip frames that didn't actually advance bytes — those are usually
        // status-string-only updates ("verifying digest") and would falsely
        // pull the EMA toward 0.
        if (dBytes > 0) {
          const instant = dBytes / dtSec;
          const smoothed =
            RATE_EMA_ALPHA * instant +
            (1 - RATE_EMA_ALPHA) * prevRate.bytesPerSec;
          nextRate = {
            bytesPerSec: smoothed,
            updatedAt: now,
            lastCompleted: completed,
          };
        }
      }

      // When a pull resolves (done:true), drop it from activePulls so
      // the dock can decide whether to keep the row pinned (it does, for
      // the "✓ done" affordance) without conflating "still running" with
      // "just finished".
      let nextActive = s.activePulls;
      if (progress.done && s.activePulls[progress.modelName]) {
        nextActive = { ...s.activePulls };
        delete nextActive[progress.modelName];
      }

      return {
        pullProgress: { ...s.pullProgress, [progress.modelName]: progress },
        pullRate: nextRate
          ? { ...s.pullRate, [progress.modelName]: nextRate }
          : s.pullRate,
        activePulls: nextActive,
      };
    }),
}));

/**
 * Tracked wrapper around the preload's `pullModel` IPC. Use this from
 * the renderer instead of `window.api.ollama.pullModel` directly so the
 * Download Dock sees the row immediately (the IPC's promise resolves on
 * the *final* frame; without this wrapper the dock would be blank
 * during the click-to-first-frame gap, which can be a few seconds while
 * Ollama resolves the manifest).
 */
export async function pullModelTracked(
  modelName: string,
): Promise<OllamaPullProgress> {
  useOllamaStore.getState().markPullStarted(modelName);
  try {
    return await window.api.ollama.pullModel(modelName);
  } catch (err) {
    // The supervisor emits a final progress frame on failure, so the
    // store is already up-to-date — we just need to make sure the row
    // leaves "queued/active" state if Ollama returned an HTTP error
    // before any frame at all (rare but possible). Synthesise a final
    // frame so the dock can render the failure message.
    const message = err instanceof Error ? err.message : String(err);
    useOllamaStore.getState().setPullProgress({
      modelName,
      status: "error",
      done: true,
      errorMessage: message,
    });
    throw err;
  }
}

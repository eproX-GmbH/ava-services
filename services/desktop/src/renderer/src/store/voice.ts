import { create } from "zustand";
import type {
  VoiceModelDownloadProgress,
  VoiceStatus,
} from "../../../shared/types";

// Voice / whisper sidecar mirror (Phase 8.n1).
//
// Same pattern as the ollama / alerts stores: main owns the truth
// (sidecar lifecycle, model file on disk, in-flight download), the
// renderer keeps a synchronous-readable mirror here. Bootstraps via
// `getStatus()` once on mount and refreshes on every
// `voice:status:changed` push from main.
//
// The download progress is folded into the same store so the
// FirstRunWizard / Settings panel only has to subscribe once.

interface VoiceState {
  ready: boolean;
  status: VoiceStatus;
  /** Smoothed bytes/sec we compute renderer-side from the coalesced
   *  ~5 Hz progress frames main emits. Same approach the Ollama store
   *  uses — exponential moving average so an HTTP/2 chunk that brings
   *  300 MB doesn't read as "instant infinity". */
  bytesPerSec: number;
  setStatus: (s: VoiceStatus) => void;
  setProgress: (p: VoiceModelDownloadProgress) => void;
  download: () => Promise<void>;
  cancel: () => Promise<void>;
  remove: () => Promise<void>;
}

const RATE_EMA_ALPHA = 0.3;

const INITIAL_STATUS: VoiceStatus = {
  state: "idle",
  binaryPath: null,
  model: null,
  download: null,
  errorMessage: null,
};

export const useVoiceStore = create<VoiceState>((set, get) => {
  // Hidden-from-state working set for the EMA.
  let lastFrameAt = 0;
  let lastBytes = 0;

  return {
    ready: false,
    status: INITIAL_STATUS,
    bytesPerSec: 0,
    setStatus: (status) => {
      // Reset rate state when a download starts/ends — otherwise we
      // carry a phantom "120 MB/s" over from a finished pull.
      if (status.state !== "downloading") {
        lastFrameAt = 0;
        lastBytes = 0;
        set({ ready: true, status, bytesPerSec: 0 });
      } else {
        set({ ready: true, status });
      }
    },
    setProgress: (p) => {
      const now = Date.now();
      let bytesPerSec = get().bytesPerSec;
      if (lastFrameAt > 0 && p.completed > lastBytes) {
        const dtSec = (now - lastFrameAt) / 1000;
        if (dtSec > 0) {
          const sample = (p.completed - lastBytes) / dtSec;
          bytesPerSec =
            bytesPerSec === 0
              ? sample
              : RATE_EMA_ALPHA * sample +
                (1 - RATE_EMA_ALPHA) * bytesPerSec;
        }
      }
      lastFrameAt = now;
      lastBytes = p.completed;
      set((s) => ({
        status: { ...s.status, download: p },
        bytesPerSec,
      }));
    },
    download: async () => {
      await window.api.voice.downloadModel();
    },
    cancel: async () => {
      await window.api.voice.cancelDownload();
    },
    remove: async () => {
      await window.api.voice.deleteModel();
    },
  };
});

let bound = false;

export function bindVoiceBridge(): () => void {
  if (bound) return () => {};
  bound = true;
  void window.api.voice.getStatus().then(useVoiceStore.getState().setStatus);
  const offStatus = window.api.voice.onStatusChanged(
    useVoiceStore.getState().setStatus,
  );
  const offProgress = window.api.voice.onProgress(
    useVoiceStore.getState().setProgress,
  );
  return () => {
    offStatus();
    offProgress();
    bound = false;
  };
}

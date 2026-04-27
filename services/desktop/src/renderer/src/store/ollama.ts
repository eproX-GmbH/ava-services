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

interface OllamaState {
  ready: boolean;
  status: OllamaStatus;
  /** Most recent progress frame keyed by model name. Final frames stay
   *  pinned until a fresh pull starts so the wizard can show "✓ done". */
  pullProgress: Record<string, OllamaPullProgress>;

  setStatus: (status: OllamaStatus) => void;
  setPullProgress: (progress: OllamaPullProgress) => void;
}

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
  setStatus: (status) => setState({ status, ready: true }),
  setPullProgress: (progress) =>
    setState((s) => ({
      pullProgress: { ...s.pullProgress, [progress.modelName]: progress },
    })),
}));

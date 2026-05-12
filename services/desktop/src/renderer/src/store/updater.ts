import { create } from "zustand";
import type { UpdateStatus } from "../../../shared/types";

// Auto-updater mirror (Phase 8.u4).
//
// Same pattern as the other supervisor mirrors: main owns the truth
// (electron-updater state machine), renderer keeps a synchronous
// snapshot here. The Settings panel reads this to render the
// "Updates" section + the renderer-level banner shown when
// state === "ready".

const INITIAL: UpdateStatus = {
  state: "idle",
  currentVersion: "",
  latestVersion: null,
  progress: null,
  errorMessage: null,
  silentInstallFailedFromVersion: null,
};

interface UpdaterState {
  status: UpdateStatus;
  setStatus: (s: UpdateStatus) => void;
}

export const useUpdaterStore = create<UpdaterState>((setState) => ({
  status: INITIAL,
  setStatus: (status) => setState({ status }),
}));

export function bindUpdaterBridge(): () => void {
  void window.api.updater.getStatus().then((s) => {
    useUpdaterStore.getState().setStatus(s);
  });
  return window.api.updater.onStatusChanged((s) =>
    useUpdaterStore.getState().setStatus(s),
  );
}

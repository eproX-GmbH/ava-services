import { create } from "zustand";
import type { ProducerStatus } from "../../../shared/types";

// Local producer mirror (Phase 8.v1.1).
//
// Same pattern as the other supervisor mirrors: main owns truth,
// renderer keeps a synchronous-readable map keyed by producer name.
// The initial list arrives via `list()`; per-producer diffs land
// via `producer-status:changed` and the bridge updates a single
// entry without touching the rest.

interface ProducerState {
  ready: boolean;
  byName: Record<string, ProducerStatus>;
  setAll: (statuses: ProducerStatus[]) => void;
  setOne: (status: ProducerStatus) => void;
}

export const useProducersStore = create<ProducerState>((setState) => ({
  ready: false,
  byName: {},
  setAll: (statuses) => {
    const byName: Record<string, ProducerStatus> = {};
    for (const s of statuses) byName[s.name] = s;
    setState({ byName, ready: true });
  },
  setOne: (status) =>
    setState((s) => ({
      byName: { ...s.byName, [status.name]: status },
      ready: true,
    })),
}));

/**
 * Bind the renderer mirror to the main-process push channel.
 * Returns the unsubscribe handle App.tsx calls on unmount.
 */
export function bindProducersBridge(): () => void {
  void window.api.producers.list().then((list) => {
    useProducersStore.getState().setAll(list);
  });
  return window.api.producers.onStatusChanged((s) =>
    useProducersStore.getState().setOne(s),
  );
}

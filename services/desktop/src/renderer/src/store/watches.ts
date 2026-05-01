import { create } from "zustand";
import type { Watch } from "../../../shared/types";
import { WATCH_CAP_DEFAULT } from "../../../shared/types";

// Watch mirror (Phase 8.t2).
//
// Same pattern as the alerts / profile / freshness stores. Bootstraps
// via `list()` once on mount + refreshes on every `watches:changed`
// push. Exposes derived values the topbar chip needs:
// - activeCount
// - capacity colour bucket (green / orange / red)

export type CapacityBucket = "green" | "orange" | "red";

interface WatchesState {
  ready: boolean;
  watches: Watch[];
  set: (watches: Watch[]) => void;
  refresh: () => Promise<void>;
  remove: (id: string) => Promise<void>;
  setEnabled: (id: string, enabled: boolean) => Promise<void>;
}

export const useWatchesStore = create<WatchesState>((set) => ({
  ready: false,
  watches: [],
  set: (watches) => set({ ready: true, watches }),
  refresh: async () => {
    const list = await window.api.watches.list();
    set({ ready: true, watches: list });
  },
  remove: async (id) => {
    await window.api.watches.remove(id);
  },
  setEnabled: async (id, enabled) => {
    await window.api.watches.setEnabled(id, enabled);
  },
}));

let bound = false;
export function bindWatchesBridge(): () => void {
  if (bound) return () => {};
  bound = true;
  void useWatchesStore.getState().refresh();
  const off = window.api.watches.onChanged(useWatchesStore.getState().set);
  return () => {
    off();
    bound = false;
  };
}

/** Derived helpers — kept outside the store so subscribers can pick
 *  exactly the slice they need. */
export function activeWatches(watches: Watch[]): Watch[] {
  return watches.filter((w) => w.enabled);
}

export function capacityBucket(
  active: number,
  cap = WATCH_CAP_DEFAULT,
): CapacityBucket {
  if (cap <= 0) return "green";
  const pct = active / cap;
  if (pct >= 0.9) return "red";
  if (pct > 0.5) return "orange";
  return "green";
}

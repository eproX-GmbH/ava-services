import { create } from "zustand";
import type { Alert } from "../../../shared/types";

// Alerts mirror (Phase 8.f1).
//
// Same pattern as the ollama / auth stores: main owns the truth (the
// JSONL file under userData/agent/alerts.jsonl), the renderer keeps a
// synchronous-readable mirror here. We bootstrap by calling
// `window.api.alerts.list()` once on mount and re-fetch whenever main
// pushes the `alerts:changed` event.
//
// We pull the unread count off the list rather than calling the
// dedicated IPC again — the list already carries every needed flag
// (seenAt). Saves one IPC roundtrip per push.

interface AlertsState {
  ready: boolean;
  alerts: Alert[];
  unreadCount: number;
  refresh: () => Promise<void>;
  markSeen: (id: string) => Promise<void>;
  dismiss: (id: string) => Promise<void>;
  triggerNow: () => Promise<void>;
}

function deriveUnread(alerts: Alert[]): number {
  return alerts.filter((a) => a.dismissedAt === null && a.seenAt === null)
    .length;
}

export const useAlertsStore = create<AlertsState>((set, get) => ({
  ready: false,
  alerts: [],
  unreadCount: 0,

  refresh: async () => {
    const list = await window.api.alerts.list();
    set({ ready: true, alerts: list, unreadCount: deriveUnread(list) });
  },

  markSeen: async (id) => {
    await window.api.alerts.markSeen(id);
    // Optimistic patch — the main-side broadcast will arrive shortly and
    // re-sync if for some reason our local mutation was wrong.
    set((s) => {
      const alerts = s.alerts.map((a) =>
        a.id === id && a.seenAt === null
          ? { ...a, seenAt: new Date().toISOString() }
          : a,
      );
      return { alerts, unreadCount: deriveUnread(alerts) };
    });
  },

  dismiss: async (id) => {
    await window.api.alerts.dismiss(id);
    set((s) => {
      const alerts = s.alerts.filter((a) => a.id !== id);
      return { alerts, unreadCount: deriveUnread(alerts) };
    });
  },

  triggerNow: async () => {
    await window.api.alerts.triggerNow();
    // The heartbeat broadcasts `alerts:changed` on every persisted row;
    // the listener wired in App.tsx will refresh us. Calling refresh
    // here too as a fallback (the broadcast can race against this
    // resolve) is cheap.
    void get().refresh();
  },
}));

// One-time wiring — call this from App.tsx at boot. Lives here (not in
// App.tsx) so the subscription handle is owned by the store module.
let unsubscribe: (() => void) | null = null;

export function bindAlertsBridge(): () => void {
  if (unsubscribe) return unsubscribe;
  void useAlertsStore.getState().refresh();
  const dispose = window.api.alerts.onChanged(() => {
    void useAlertsStore.getState().refresh();
  });
  unsubscribe = () => {
    dispose();
    unsubscribe = null;
  };
  return unsubscribe;
}

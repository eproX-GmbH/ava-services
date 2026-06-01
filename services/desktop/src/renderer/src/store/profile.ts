import { create } from "zustand";
import type { UserProfile } from "../../../shared/types";

// User profile mirror (Phase 8.t1).
//
// Same pattern as the alerts / freshness stores: main owns the JSON
// file, renderer keeps a synchronous-readable mirror. Updated via the
// `profile:changed` push so two windows + the agent's own writes stay
// in sync.

const INITIAL: UserProfile = {
  bio: "",
  role: null,
  industries: [],
  geographies: [],
  topics: [],
  tone: null,
  signalInterests: "",
  profileSkipped: false,
  updatedAt: null,
};

interface ProfileState {
  ready: boolean;
  profile: UserProfile;
  set: (profile: UserProfile) => void;
  refresh: () => Promise<void>;
  save: (patch: Partial<UserProfile>) => Promise<void>;
  clear: () => Promise<void>;
}

export const useProfileStore = create<ProfileState>((set) => ({
  ready: false,
  profile: INITIAL,
  set: (profile) => set({ ready: true, profile }),
  refresh: async () => {
    const profile = await window.api.profile.get();
    set({ ready: true, profile });
  },
  save: async (patch) => {
    const next = await window.api.profile.set(patch);
    set({ profile: next });
  },
  clear: async () => {
    const next = await window.api.profile.clear();
    set({ profile: next });
  },
}));

let bound = false;
export function bindProfileBridge(): () => void {
  if (bound) return () => {};
  bound = true;
  void useProfileStore.getState().refresh();
  const off = window.api.profile.onChanged(useProfileStore.getState().set);
  return () => {
    off();
    bound = false;
  };
}

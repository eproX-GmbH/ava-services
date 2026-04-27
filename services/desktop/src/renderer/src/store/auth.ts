import { create } from "zustand";
import type { AuthStatus } from "../../../shared/types";

// Auth state mirror.
//
// The main process owns the truth (token, refresh timer, keychain). The
// renderer keeps a *mirror* here so React components can render against
// it synchronously — pushed via the `auth-status:changed` IPC event.
//
// Async token reads (the gateway client calls `window.api.auth.
// getAccessToken()` per request) bypass this store on purpose: by the
// time React re-renders, a request already in flight may have a stale
// token, so we always ask main for the freshest one.

interface AuthState extends AuthStatus {
  ready: boolean;
  set: (status: AuthStatus) => void;
}

const SIGNED_OUT: AuthStatus = {
  signedIn: false,
  accessToken: null,
  expiresAt: null,
  actorId: null,
  tenantId: null,
  scopes: [],
};

export const useAuthStore = create<AuthState>((setState) => ({
  ...SIGNED_OUT,
  ready: false,
  set: (status) => setState({ ...status, ready: true }),
}));

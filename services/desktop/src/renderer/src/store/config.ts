import { create } from "zustand";
import type { AppConfig } from "../../../preload";

// App config = the values the renderer needs to talk to the outside world.
// Today: gateway URL + (eventually) auth token. Kept in Zustand rather
// than React Context because the gateway client (a plain module) needs
// synchronous read access to `gatewayUrl` outside any React tree.

interface ConfigState extends Partial<AppConfig> {
  ready: boolean;
  set: (cfg: AppConfig) => void;
}

export const useConfigStore = create<ConfigState>((setState) => ({
  ready: false,
  set: (cfg) => setState({ ...cfg, ready: true }),
}));

// Snapshot accessor for non-React modules (the gateway client below uses it).
export function getGatewayUrl(): string {
  const { gatewayUrl } = useConfigStore.getState();
  if (!gatewayUrl) throw new Error("gateway URL not loaded yet");
  return gatewayUrl;
}

export function getAccessToken(): string | null {
  return useConfigStore.getState().accessToken ?? null;
}

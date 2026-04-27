import { create } from "zustand";
import type { AppConfig } from "../../../shared/types";

// Static boot config (gateway URL). Populated once on App mount.
//
// Note: the access token is *not* in this store — it lives in the main
// process and is fetched on-demand by the gateway client so requests
// always carry a fresh-enough token. See ./auth.ts for the auth mirror.

interface ConfigState extends Partial<AppConfig> {
  ready: boolean;
  set: (cfg: AppConfig) => void;
}

export const useConfigStore = create<ConfigState>((setState) => ({
  ready: false,
  set: (cfg) => setState({ ...cfg, ready: true }),
}));

export function getGatewayUrl(): string {
  const { gatewayUrl } = useConfigStore.getState();
  if (!gatewayUrl) throw new Error("gateway URL not loaded yet");
  return gatewayUrl;
}

import { contextBridge, ipcRenderer } from "electron";

// Preload bridge.
//
// Runs in an isolated context with access to a small slice of Node API
// (just `electron`'s ipcRenderer here). Anything we put on `window.api` is
// the only thing the renderer can call into the main process — we keep
// the surface tiny on purpose.
//
// Pattern: every method here corresponds to a single ipcMain.handle in
// the main process. If you need a new capability, add the channel name
// to both ends so the contract stays explicit.

export interface AppConfig {
  gatewayUrl: string;
  accessToken: string | null;
}

const api = {
  getConfig: (): Promise<AppConfig> => ipcRenderer.invoke("app:getConfig"),
} as const;

contextBridge.exposeInMainWorld("api", api);

export type Api = typeof api;

import { contextBridge, ipcRenderer } from "electron";
import type { AuthStatus, AppConfig } from "../shared/types";
export type { AppConfig, AuthStatus } from "../shared/types";

// Preload bridge.
//
// Runs in an isolated context with access to a small slice of Node API
// (just `electron`'s ipcRenderer). Anything we expose on `window.api` is
// the only thing the renderer can call into the main process — we keep
// the surface tiny on purpose.
//
// Channels match `ipcMain.handle(...)` calls in main/index.ts. Adding a
// capability means adding the channel name in both places.

const api = {
  getConfig: (): Promise<AppConfig> => ipcRenderer.invoke("app:getConfig"),

  // Auth.
  auth: {
    getStatus: (): Promise<AuthStatus> => ipcRenderer.invoke("auth:getStatus"),
    /** Returns a fresh-enough access token, or null if signed out. */
    getAccessToken: (): Promise<string | null> =>
      ipcRenderer.invoke("auth:getAccessToken"),
    signIn: (): Promise<void> => ipcRenderer.invoke("auth:signIn"),
    signOut: (): Promise<void> => ipcRenderer.invoke("auth:signOut"),
    /** Subscribe to status changes (login / logout / silent refresh). */
    onStatusChanged: (cb: (status: AuthStatus) => void): (() => void) => {
      const handler = (_e: Electron.IpcRendererEvent, status: AuthStatus) =>
        cb(status);
      ipcRenderer.on("auth-status:changed", handler);
      return () => ipcRenderer.removeListener("auth-status:changed", handler);
    },
  },
} as const;

contextBridge.exposeInMainWorld("api", api);

export type Api = typeof api;

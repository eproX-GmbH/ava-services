import { app, BrowserWindow, ipcMain, shell } from "electron";
import { join } from "node:path";
import { Auth, type AuthStatus } from "./auth";

// Main process.
//
// Responsibilities:
//   1. Single BrowserWindow with secure defaults
//      (contextIsolation, sandbox, no Node in renderer).
//   2. OIDC Authorization Code + PKCE flow in `Auth` (./auth.ts).
//   3. IPC bridge: renderer can request status, sign in / out, and pull
//      a fresh access token before each gateway call.
//
// Auth status is *pushed* to every window via `auth-status:changed` so
// renderer code can react without polling.

const GATEWAY_URL = process.env.GATEWAY_URL ?? "http://localhost:8080";

// OIDC config. Defaults aimed at the dev Keycloak compose service; in a
// packaged build these come from the build-time env (see electron-builder
// extraResources or a runtime config file in app.getPath('userData')).
const AUTH_ISSUER =
  process.env.AUTH_ISSUER ?? "http://auth.localhost/realms/ava";
const AUTH_CLIENT_ID = process.env.AUTH_CLIENT_ID ?? "ava-desktop";

const auth = new Auth(AUTH_ISSUER, AUTH_CLIENT_ID);

function broadcastAuthStatus(status: AuthStatus): void {
  for (const win of BrowserWindow.getAllWindows()) {
    win.webContents.send("auth-status:changed", status);
  }
}
auth.on("status", broadcastAuthStatus);

function createMainWindow(): BrowserWindow {
  const win = new BrowserWindow({
    width: 1280,
    height: 800,
    minWidth: 960,
    minHeight: 600,
    show: false,
    autoHideMenuBar: true,
    webPreferences: {
      preload: join(__dirname, "../preload/index.js"),
      contextIsolation: true,
      sandbox: true,
      nodeIntegration: false,
    },
  });

  win.on("ready-to-show", () => win.show());

  // External links open in the user's browser, not inside the app.
  win.webContents.setWindowOpenHandler(({ url }) => {
    void shell.openExternal(url);
    return { action: "deny" };
  });

  if (process.env["ELECTRON_RENDERER_URL"]) {
    void win.loadURL(process.env["ELECTRON_RENDERER_URL"]);
  } else {
    void win.loadFile(join(__dirname, "../renderer/index.html"));
  }
  return win;
}

app.whenReady().then(async () => {
  // ---- IPC contract ---------------------------------------------------------
  //
  // `app:getConfig` returns *static* boot config — gateway URL only. The
  // access token is no longer included here; renderer fetches it on demand
  // via `auth:getAccessToken` so it always gets a fresh-enough one.
  ipcMain.handle("app:getConfig", () => ({ gatewayUrl: GATEWAY_URL }));

  ipcMain.handle("auth:getStatus", () => auth.getStatus());
  ipcMain.handle("auth:getAccessToken", () => auth.getAccessToken());
  ipcMain.handle("auth:signIn", () => auth.signIn());
  ipcMain.handle("auth:signOut", () => auth.signOut());

  // Try silent restore from the OS-keychain–stored refresh token before
  // showing any UI — if it works the renderer never sees a sign-in screen.
  await auth.tryRestoreSession();

  createMainWindow();

  app.on("activate", () => {
    if (BrowserWindow.getAllWindows().length === 0) createMainWindow();
  });
});

app.on("window-all-closed", () => {
  if (process.platform !== "darwin") app.quit();
});

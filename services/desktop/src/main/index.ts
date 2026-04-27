import { app, BrowserWindow, ipcMain, shell } from "electron";
import { join } from "node:path";

// Main process.
//
// Responsibilities for this v0 scaffold:
//   1. Create a single BrowserWindow with secure defaults
//      (contextIsolation, sandbox, no Node in renderer).
//   2. Load the renderer (dev: vite dev server URL injected by electron-vite;
//      prod: bundled HTML on disk).
//   3. Expose `appConfig` via IPC so the renderer learns the gateway URL
//      without baking it into the bundle (env-driven, swap per environment).
//
// Out of scope for this commit (tracked in todos):
//   - Keycloak OIDC PKCE flow (token acquisition lives in main; renderer
//     only ever sees the access token via the preload bridge).
//   - Auto-updater, crash reporting, deep-links — Step 7 hardening.
//   - Spawning local NATS / services (D1/D5 — deferred until cloud→local
//     migration actually happens).

// Gateway URL: env override wins, otherwise default to local dev port.
// db-gateway's .env.example sets PORT=8080.
const GATEWAY_URL = process.env.GATEWAY_URL ?? "http://localhost:8080";

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

  // electron-vite sets ELECTRON_RENDERER_URL in dev so we get HMR.
  if (process.env["ELECTRON_RENDERER_URL"]) {
    void win.loadURL(process.env["ELECTRON_RENDERER_URL"]);
  } else {
    void win.loadFile(join(__dirname, "../renderer/index.html"));
  }
  return win;
}

app.whenReady().then(() => {
  // Single IPC channel for "what does the renderer need to know about the
  // outside world?". Keeping it as a single getter (rather than per-key
  // channels) means the preload bridge stays a single function — easier
  // to audit and to extend later (auth tokens, feature flags).
  ipcMain.handle("app:getConfig", () => ({
    gatewayUrl: GATEWAY_URL,
    // Auth bearer token will land here once the OIDC flow ships. Renderer
    // treats the absence as "not signed in".
    accessToken: null as string | null,
  }));

  createMainWindow();

  app.on("activate", () => {
    if (BrowserWindow.getAllWindows().length === 0) createMainWindow();
  });
});

app.on("window-all-closed", () => {
  // Standard behaviour: keep the app alive on macOS, quit elsewhere.
  if (process.platform !== "darwin") app.quit();
});

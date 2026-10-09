// Electron-Umsetzung der Plattform-Schicht (src/core/platform.ts).
//
// Wird beim Import gesetzt und muss deshalb der ERSTE Import in
// src/main/index.ts sein: Einige Stores lesen ihren Pfad schon beim Laden des
// Moduls, und ohne gesetzte Plattform fiele der Zugriff auf die Node-Fassung
// zurück (~/.ava statt des Electron-userData).

import { app, BrowserWindow, Notification, powerMonitor, safeStorage, shell } from "electron";
import { setPlatform, type Platform } from "../core/platform";

function hauptfensterNachVorn(): void {
  try {
    app.focus({ steal: true });
    const wins = BrowserWindow.getAllWindows().filter((w) => !w.isDestroyed());
    const main =
      wins.find((x) => (x as unknown as { __avaMainWindow?: boolean }).__avaMainWindow) ?? wins[0];
    if (main) {
      if (main.isMinimized()) main.restore();
      main.show();
      main.focus();
      // Windows gibt den Fokus nach einem Login-Fenster sonst nicht an die Textfelder zurueck.
      main.webContents.focus();
    }
  } catch {
    /* kosmetisch */
  }
}

export const electronPlatform: Platform = {
  kind: "electron",
  paths: {
    get: (name) => app.getPath(name),
    get isPackaged() {
      return app.isPackaged;
    },
    version: () => app.getVersion(),
    appPath: () => app.getAppPath(),
    resources: () => process.resourcesPath ?? null,
    locale: () => app.getLocale(),
  },
  credentials: {
    isEncryptionAvailable: () => safeStorage.isEncryptionAvailable(),
    encryptString: (plain) => safeStorage.encryptString(plain),
    decryptString: (data) => safeStorage.decryptString(data),
  },
  notifier: {
    isSupported: () => Notification.isSupported(),
    show(req) {
      if (!Notification.isSupported()) return false;
      try {
        const n = new Notification({
          title: req.title,
          body: req.body,
          silent: req.silent ?? false,
          // Nur macOS: "critical" durchbricht Fokus-Modi.
          urgency: req.urgent ? "critical" : "normal",
        });
        if (req.onClick) n.on("click", req.onClick);
        n.show();
        return true;
      } catch (err) {
        console.warn("[platform] Benachrichtigung fehlgeschlagen:", err);
        return false;
      }
    },
  },
  opener: {
    openExternal: (url) => shell.openExternal(url),
    openPath: (p) => shell.openPath(p),
    showItemInFolder: (p) => shell.showItemInFolder(p),
  },
  spawner: {
    // Die Electron-Binary dient als Node-Interpreter.
    nodeCommand: () => ({ command: process.execPath, env: { ELECTRON_RUN_AS_NODE: "1" } }),
  },
  windows: {
    hasWindows: () => BrowserWindow.getAllWindows().some((w) => !w.isDestroyed()),
    isAnyFocused: () => BrowserWindow.getFocusedWindow() !== null,
    broadcast(channel, ...args) {
      for (const win of BrowserWindow.getAllWindows()) {
        try {
          if (!win.isDestroyed()) win.webContents.send(channel, ...args);
        } catch {
          /* zerstörtes Fenster */
        }
      }
    },
    focusMain: hauptfensterNachVorn,
  },
  power: {
    isOnBatteryPower: () => powerMonitor.isOnBatteryPower(),
    on: (event, handler) => {
      (powerMonitor as unknown as NodeJS.EventEmitter).on(event, handler);
    },
  },
  lifecycle: {
    relaunch: () => {
      app.relaunch();
      app.exit(0);
    },
    exit: (code) => app.exit(code),
    onBeforeQuit: (handler) => {
      app.on("before-quit", handler);
    },
  },
};

setPlatform(electronPlatform);

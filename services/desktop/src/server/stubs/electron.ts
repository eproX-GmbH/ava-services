// Ersatz für das Modul `electron` im Server-Bündel (docs/PLAN_AVA_CLOUD.md §12, R3).
//
// Einige Module unter src/main (Login-Fenster, LinkedIn, Updater, Protokolle)
// importieren `electron` noch, obwohl der Kopf sie im Server nicht ausübt. Der
// Bundler (scripts/build-server.mjs) leitet den Import hierher. Alles, was ein
// Fenster oder den Desktop braucht, wirft mit klarer Meldung; Ereignis-Quellen
// (app, powerMonitor) sind stumme Emitter, damit Registrierungen nicht scheitern.

import { EventEmitter } from "node:events";

const fehlt = (was: string) => (): never => {
  throw new Error(`Electron-API ${was} ist im Server nicht verfügbar`);
};

export const app = Object.assign(new EventEmitter(), {
  isPackaged: false,
  getPath: fehlt("app.getPath"),
  setPath: () => {},
  getVersion: () => process.env.AVA_VERSION ?? "0.0.0-server",
  getName: () => "AVA",
  getAppPath: () => process.cwd(),
  getLocale: () => "de-DE",
  isReady: () => true,
  whenReady: () => Promise.resolve(),
  focus: () => {},
  quit: () => process.exit(0),
  exit: (code = 0) => process.exit(code),
  relaunch: () => {},
  isDefaultProtocolClient: () => false,
  setAsDefaultProtocolClient: () => false,
  requestSingleInstanceLock: () => true,
});

export class BrowserWindow {
  constructor() {
    throw new Error("Electron-API BrowserWindow ist im Server nicht verfügbar (kein Fenster)");
  }
  static getAllWindows(): BrowserWindow[] {
    return [];
  }
  static getFocusedWindow(): BrowserWindow | null {
    return null;
  }
  static fromId(): BrowserWindow | null {
    return null;
  }
  static fromWebContents(): BrowserWindow | null {
    return null;
  }
}

export class Notification {
  static isSupported(): boolean {
    return false;
  }
  on(): this {
    return this;
  }
  show(): void {}
}

export const safeStorage = {
  isEncryptionAvailable: () => false,
  encryptString: fehlt("safeStorage.encryptString"),
  decryptString: fehlt("safeStorage.decryptString"),
};

export const shell = {
  openExternal: async () => {},
  openPath: async () => "Kein Desktop",
  showItemInFolder: () => {},
};

export const powerMonitor = Object.assign(new EventEmitter(), {
  isOnBatteryPower: () => false,
});

const stummeSession = {
  setPermissionRequestHandler: () => {},
  setPermissionCheckHandler: () => {},
  on: () => {},
  webRequest: { onBeforeSendHeaders: () => {} },
  cookies: { get: async () => [], set: async () => {}, remove: async () => {} },
};
export const session = {
  defaultSession: stummeSession,
  fromPartition: () => stummeSession,
};

export const protocol = {
  registerSchemesAsPrivileged: () => {},
  handle: () => {},
};

export const net = {
  fetch: (input: string | URL | Request, init?: RequestInit) => fetch(input, init),
  request: fehlt("net.request"),
};

export const nativeImage = {
  createFromBuffer: fehlt("nativeImage.createFromBuffer"),
  createFromPath: fehlt("nativeImage.createFromPath"),
};

export const dialog = {
  showOpenDialog: fehlt("dialog.showOpenDialog"),
  showSaveDialog: fehlt("dialog.showSaveDialog"),
  showMessageBox: fehlt("dialog.showMessageBox"),
};

export const ipcMain = {
  handle: () => {},
  on: () => {},
  removeHandler: () => {},
};

export const systemPreferences = {
  getMediaAccessStatus: () => "unsupported",
  askForMediaAccess: async () => false,
};

export default { app, BrowserWindow, Notification, safeStorage, shell, powerMonitor, session, protocol, net, nativeImage, dialog, ipcMain, systemPreferences };

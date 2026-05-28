// v0.1.330 — Persistent BrowserWindow für den LinkedIn-Scraper.
//
// Bisheriges Design (bis v0.1.329): pro Scan ein FRISCHES BrowserWindow
// per `new BrowserWindow({...})`, am Ende per `win.destroy()` zerlegt.
// Real-Run-Symptom: jeder Scan blockiert den Main-Thread für 150–400ms
// während Chromium den Render-Process spawnt + die `persist:linkedin`-
// Partition initialisiert. Bei stündlichen Scans = mehrfach täglich
// ein für den User sichtbarer Mini-Freeze („AVA hängt kurz").
//
// Neues Design:
//   - Genau EINEN persistent BrowserWindow zum App-Start lazy
//     warm-laufen lassen (Pre-Warm aus dem Scheduler heraus, mit
//     setImmediate-Yield damit der Boot nicht beeinflusst wird).
//   - Die teuren Setup-Schritte (UA, Headers, WebRTC-Policy,
//     onBeforeSendHeaders-Hook, did-start-navigation-Stealth-Inject)
//     laufen GENAU EINMAL pro App-Lifetime.
//   - Pro Scan: Navigation auf about:blank → State-Reset
//     (localStorage/sessionStorage clear, scrollTop=0) → Navigation
//     auf LinkedIn-Feed. KEIN neuer BrowserWindow.
//   - App-Quit: `destroyScraperWindow()` aus dem before-quit Hook.
//
// Anti-Bot-Überlegung: real User halten ihre LinkedIn-Tab den ganzen
// Tag offen, mit gleichem UA + gleicher Session. Unsere persistent-
// Window-Strategie ahmt das nach. Vorher (frisches Fenster + persist-
// Partition) war der Mix eigentlich verdächtiger: gleiche Cookies aber
// jedes Mal ein neu gespawnter Renderer-Process mit identischen Headern.

import { BrowserWindow } from "electron";
import { read as readSettings } from "./store";
import { buildStealthInjection } from "./stealth";

let scraperWindow: BrowserWindow | null = null;
/** In-Flight-Promise damit zwei parallele `ensureScraperWindow()`-Calls
 *  nicht doppelt setupen. */
let prewarmInFlight: Promise<BrowserWindow> | null = null;
/** Marker: true sobald das One-Time-Setup für das aktuelle Window
 *  fertig ist (UA, Listener, Header-Hook). */
let setupComplete = false;

/**
 * Pre-Warm. Idempotent. Liefert das Window zurück; legt es an wenn
 * noch nicht da. Wird vom Scheduler beim App-Boot über setImmediate
 * aufgerufen damit die ~200ms-Konstruktion außerhalb des kritischen
 * Boot-Pfades stattfindet.
 */
export function prewarmScraperWindow(): Promise<BrowserWindow> {
  if (scraperWindow && !scraperWindow.isDestroyed() && setupComplete) {
    return Promise.resolve(scraperWindow);
  }
  if (prewarmInFlight) return prewarmInFlight;
  prewarmInFlight = (async (): Promise<BrowserWindow> => {
    const settings = readSettings();
    const fp = settings.fingerprint;
    if (!fp) {
      // Sollte nicht passieren — der Settings-Store füllt fingerprint
      // auf erstem read mit einem Default. Defensiv.
      throw new Error("LinkedIn fingerprint missing — cannot prewarm window");
    }
    const debugWindow = process.env.AVA_LINKEDIN_DEBUG_WINDOW === "1";

    // Window-Konstruktion: das ist der ~200ms-Block. Läuft jetzt
    // EINMAL pro App-Lifetime statt EINMAL pro Scan.
    console.log("[linkedin/window] pre-warming persistent BrowserWindow");
    const win = new BrowserWindow({
      show: false,
      width: fp.viewport.width,
      height: fp.viewport.height,
      x: debugWindow ? undefined : -2000,
      y: debugWindow ? undefined : -2000,
      skipTaskbar: !debugWindow,
      focusable: debugWindow,
      frame: debugWindow,
      webPreferences: {
        partition: "persist:linkedin",
        contextIsolation: true,
        nodeIntegration: false,
        sandbox: true,
        offscreen: false,
      },
    });
    if (!debugWindow) {
      try {
        win.setOpacity(0);
      } catch {
        /* ignore */
      }
      try {
        // v0.1.309 — showInactive() statt show:true: paint-but-no-focus.
        // Bringt die AVA-App nicht in den Vordergrund.
        win.showInactive();
      } catch {
        /* ignore */
      }
    } else {
      win.show();
    }

    // === One-Time-Setup (ehemals pro Scan) ===
    win.webContents.setUserAgent(fp.userAgent);
    win.webContents.session.setUserAgent(fp.userAgent);
    win.webContents.setWindowOpenHandler(() => ({ action: "deny" }));

    try {
      const sess = win.webContents.session as Electron.Session & {
        setWebRTCIPHandlingPolicy?: (p: string) => void;
        setLocale?: (l: string) => void;
      };
      sess.setWebRTCIPHandlingPolicy?.("default_public_interface_only");
      sess.setLocale?.(fp.locale);
    } catch (err) {
      console.warn(
        "[linkedin/window] webrtc/locale setup skipped:",
        err instanceof Error ? err.message : String(err),
      );
    }

    try {
      const acceptLang = `${fp.locale}, en-US;q=0.9, en;q=0.8`;
      win.webContents.session.webRequest.onBeforeSendHeaders(
        { urls: ["*://*.linkedin.com/*"] },
        (details, callback) => {
          const headers = { ...details.requestHeaders };
          headers["Accept-Language"] = acceptLang;
          callback({ requestHeaders: headers });
        },
      );
    } catch (err) {
      console.warn(
        "[linkedin/window] Accept-Language hook skipped:",
        err instanceof Error ? err.message : String(err),
      );
    }

    // Stealth-Inject auf jeder Navigation (auch SPA-Routen).
    const stealthJs = buildStealthInjection(fp);
    const reinjectStealth = (): void => {
      if (!win.isDestroyed()) {
        win.webContents
          .executeJavaScript(stealthJs, false)
          .catch(() => undefined);
      }
    };
    win.webContents.on("did-start-navigation", reinjectStealth);
    win.webContents.on("dom-ready", reinjectStealth);

    // Landen auf about:blank, damit das Fenster „lebt" ohne Last.
    try {
      await win.loadURL("about:blank");
      await win.webContents.executeJavaScript(stealthJs, false);
    } catch (err) {
      console.warn(
        "[linkedin/window] initial about:blank load failed:",
        err instanceof Error ? err.message : String(err),
      );
    }

    scraperWindow = win;
    setupComplete = true;
    console.log("[linkedin/window] pre-warm complete");
    return win;
  })().finally(() => {
    prewarmInFlight = null;
  });
  return prewarmInFlight;
}

/**
 * Get-Window für Scans. Lazy-fallback wenn pre-warm noch nicht durch
 * ist (z. B. manueller Scan direkt nach App-Start). Wartet auf den
 * In-Flight-Pre-Warm wenn einer läuft.
 */
export async function getScraperWindow(): Promise<BrowserWindow> {
  if (scraperWindow && !scraperWindow.isDestroyed() && setupComplete) {
    return scraperWindow;
  }
  return await prewarmScraperWindow();
}

/**
 * Zwischen-Scan-Reset. Räumt Page-State im persistenten Window auf
 * BEVOR der nächste Scan startet, damit es sich verhält wie eine
 * frische Session:
 *   - localStorage / sessionStorage clear
 *   - scroll position zurück auf 0
 *   - Navigation auf about:blank um DOM komplett zu entladen
 *
 * COOKIES werden NICHT gelöscht — die enthalten die LinkedIn-
 * Anmeldung und müssen über die ganze App-Lifetime bestehen
 * bleiben (genau wie ein echter User der eingeloggt bleibt).
 */
export async function resetScraperWindowForNextScan(): Promise<void> {
  if (!scraperWindow || scraperWindow.isDestroyed()) return;
  try {
    await scraperWindow.webContents
      .executeJavaScript(
        `(function() {
          try { localStorage.clear(); } catch(e) {}
          try { sessionStorage.clear(); } catch(e) {}
          try { window.scrollTo(0, 0); } catch(e) {}
        })()`,
        false,
      )
      .catch(() => undefined);
    await scraperWindow.loadURL("about:blank");
  } catch (err) {
    console.warn(
      "[linkedin/window] reset failed (non-fatal):",
      err instanceof Error ? err.message : String(err),
    );
  }
}

/** App-Quit-Hook. Räumt das persistent Window auf. */
export function destroyScraperWindow(): void {
  if (scraperWindow && !scraperWindow.isDestroyed()) {
    try {
      scraperWindow.destroy();
    } catch {
      /* ignore */
    }
  }
  scraperWindow = null;
  setupComplete = false;
}

// 2026-09-12 — Harte Download-Sperre fuer alle Browser-Sitzungen der App.
//
// Anlass (Sicherheits-Rueckmeldung eines Testers): AVA oeffnet im Hintergrund
// fremde Websites (Radar-Mini-Profile, Link-Monitor, LinkedIn, Website-
// Producer). Egal was eine Seite oder ein Agent dort anklickt: es darf NIE
// eine Datei auf die Platte geschrieben werden. Ausnahmen nur fuer Domains,
// von denen wir wissentlich Dateien holen (Handelsregister, Unternehmens-
// register); diese bedienen ausschliesslich die Selenium-Producer, nicht
// diese Electron-Fenster, die Liste ist hier trotzdem massgeblich.
//
// Regeln je Sitzung (session.on("will-download")):
//   * Hintergrund-Fenster: JEDER Download wird abgebrochen, ausser Host auf
//     der Allowlist.
//   * Sichtbares Hauptfenster: nur blob:/data: (von der App selbst erzeugte
//     Exporte wie CSV) oder Allowlist-Hosts; alles andere abgebrochen.
// Dazu fuer Hintergrund-Fenster: keine neuen Fenster (window.open), keine
// Navigation auf Nicht-http(s)-Schemata, keine Berechtigungen.

import { app, type BrowserWindow, type Session, type WebContents } from "electron";

export const DOWNLOAD_ALLOW_HOSTS = ["handelsregister.de", "unternehmensregister.de"];

const guardedSessions = new WeakSet<Session>();
const backgroundContents = new WeakSet<WebContents>();
let blockedCount = 0;
let onBlocked: ((info: { url: string; host: string; hintergrund: boolean }) => void) | null = null;

export function setDownloadBlockedListener(cb: typeof onBlocked): void {
  onBlocked = cb;
}

export function downloadGuardStats(): { blocked: number } {
  return { blocked: blockedCount };
}

function hostErlaubt(host: string): boolean {
  const h = host.toLowerCase();
  return DOWNLOAD_ALLOW_HOSTS.some((a) => h === a || h.endsWith(`.${a}`));
}

/** Download-Sperre auf einer Sitzung installieren (idempotent). */
export function guardSession(ses: Session, isDefault = false): void {
  if (guardedSessions.has(ses)) return;
  guardedSessions.add(ses);
  ses.on("will-download", (event, item, wc) => {
    const url = item.getURL();
    let host = "";
    let scheme = "";
    try {
      const u = new URL(url);
      host = u.hostname;
      scheme = u.protocol.replace(":", "");
    } catch {
      /* unparsbar → sperren */
    }
    const hintergrund = backgroundContents.has(wc) || (wc.getType?.() !== "window");
    const appEigen = !hintergrund && (scheme === "blob" || scheme === "data");
    if (appEigen || (host && hostErlaubt(host))) return;
    event.preventDefault();
    blockedCount++;
    console.warn(`[download-guard] Download blockiert (${hintergrund ? "Hintergrund" : "Hauptfenster"}): ${url.slice(0, 200)}`);
    try {
      onBlocked?.({ url, host, hintergrund });
    } catch {
      /* best-effort */
    }
  });
  // Hintergrund-Sitzungen brauchen keinerlei Web-Berechtigungen. Die
  // Standard-Sitzung (Hauptfenster) behaelt ihren eigenen Handler (index.ts).
  if (!isDefault) {
    ses.setPermissionRequestHandler((_wc, _permission, callback) => callback(false));
  }
}

/** Ein unsichtbares Arbeitsfenster absichern: Download-Sperre, keine
 *  Popups, nur http(s)-Navigation, keine Berechtigungen. */
export function hardenBackgroundWindow(win: BrowserWindow): void {
  const wc = win.webContents;
  backgroundContents.add(wc);
  guardSession(wc.session);
  wc.setWindowOpenHandler(() => ({ action: "deny" }));
  wc.on("will-navigate", (event, url) => {
    if (!/^https?:/i.test(url) && !/^about:blank$/i.test(url) && !/^data:/i.test(url)) event.preventDefault();
  });
  wc.on("will-redirect", (event, url) => {
    if (!/^https?:/i.test(url)) event.preventDefault();
  });
}

/** Beim App-Start auf alle bekannten Sitzungen anwenden. */
export function guardAllKnownSessions(sessionModule: typeof import("electron").session): void {
  guardSession(sessionModule.defaultSession, true);
  for (const part of ["persist:linkedin", "persist:link-monitor", "persist:openai-oauth", "ava-bg-fetch"]) {
    try {
      guardSession(sessionModule.fromPartition(part));
    } catch {
      /* Partition existiert erst spaeter → guardSession beim Erzeugen */
    }
  }
  void app;
}

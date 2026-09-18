// Externe Links gehoeren in den Browser des Nutzers, nie in die App.
//
// Anlass (2026-09-18): Ein Klick auf eine Firmen-Website ersetzte AVA durch
// die Seite. Das Fenster hatte danach keine Adressleiste, keinen
// Zurueck-Knopf und keine Moeglichkeit, zur App zurueckzukommen.
//
// Die Ursache war eine Luecke, kein falscher Aufruf: `setWindowOpenHandler`
// war laengst gesetzt, der faengt aber nur `window.open` und
// `target="_blank"`. Ein gewoehnliches `<a href="https://…">` loest
// stattdessen eine echte Navigation des Fensters aus — und dafuer gab es
// keinen Wachposten. Von den Ankern im Renderer trifft das etliche.
//
// Deshalb sitzt die Regel hier im Hauptprozess und nicht an den einzelnen
// Ankern: Sie gilt damit fuer jeden Link, auch fuer die, die spaeter dazu
// kommen, und fuer Markdown-Inhalte, die der Agent erzeugt.

import { shell, type BrowserWindow, type WebContents } from "electron";

/** Schemata, die im Browser bzw. Mail-Programm des Nutzers landen duerfen.
 *  Alles andere (javascript:, file:, data:) wird verworfen — ein Link aus
 *  fremdem Inhalt darf nicht bestimmen, was das Betriebssystem oeffnet. */
const ERLAUBT = /^(https?|mailto|tel):/i;

export function extern(url: string): void {
  if (!ERLAUBT.test(url)) {
    console.warn(`[links] nicht geoeffnet (Schema nicht erlaubt): ${url.slice(0, 120)}`);
    return;
  }
  void shell.openExternal(url).catch((err) => {
    console.warn("[links] konnte nicht geoeffnet werden:", err);
  });
}

/** Was mit einer Adresse geschehen soll. Als eigene, reine Funktion, damit
 *  die Regel geprueft werden kann, ohne ein Fenster zu oeffnen. */
export type Entscheidung = "im-fenster" | "nach-aussen" | "verwerfen";

/**
 * `aktuell` ist die Adresse, die das Fenster gerade zeigt. Im
 * Entwicklungsbetrieb ist das der Vite-Server, im Paket die ausgelieferte
 * Datei — deshalb wird verglichen statt fest verdrahtet.
 */
export function entscheide(ziel: string, aktuell: string): Entscheidung {
  let z: URL;
  try {
    z = new URL(ziel);
  } catch {
    return "verwerfen";
  }
  try {
    const a = new URL(aktuell);
    // Dieselbe Herkunft (Vite-Server) oder dasselbe Verzeichnis im
    // Dateisystem: das ist die App selbst, hier darf navigiert werden.
    //
    // Beim Dateisystem reicht "beides file:" NICHT. Sonst waere
    // file:///etc/passwd aus einer Agent-Antwort heraus eine erlaubte
    // Navigation — das Fenster wuerde die Datei anzeigen. Verglichen wird
    // deshalb das Verzeichnis der ausgelieferten Oberflaeche.
    if (z.protocol === "file:" && a.protocol === "file:") {
      const verzeichnis = a.pathname.slice(0, a.pathname.lastIndexOf("/") + 1);
      return verzeichnis.length > 1 && z.pathname.startsWith(verzeichnis)
        ? "im-fenster"
        : "verwerfen";
    }
    if (z.origin === a.origin && z.origin !== "null") return "im-fenster";
  } catch {
    /* Fenster ohne brauchbare Adresse: dann eben nicht im Fenster. */
  }
  return ERLAUBT.test(ziel) ? "nach-aussen" : "verwerfen";
}

/**
 * Fuer Fenster, die die App selbst zeigen (Hauptfenster, Anmeldefenster).
 *
 * Nicht zu verwechseln mit `hardenBackgroundWindow` aus download-guard.ts:
 * dort wird alles verworfen, weil jene Fenster fremde Seiten zum Auslesen
 * laden. Hier zeigt das Fenster unsere eigene Oberflaeche, und ein Klick
 * des Nutzers soll etwas bewirken — nur eben draussen.
 */
export function leiteLinksNachAussen(win: BrowserWindow): void {
  const wc: WebContents = win.webContents;

  // window.open und target="_blank"
  wc.setWindowOpenHandler(({ url }) => {
    extern(url);
    return { action: "deny" };
  });

  // Gewoehnliche Anker: das Fenster darf die App nicht verlassen.
  wc.on("will-navigate", (event, url) => {
    if (entscheide(url, wc.getURL()) === "im-fenster") return;
    event.preventDefault();
    extern(url);
  });

  // Eine erlaubte Navigation, die anschliessend nach draussen umgeleitet
  // wird (Verkuerzer, Anmeldeumleitungen), darf die App ebenso wenig
  // ersetzen.
  wc.on("will-redirect", (event, url) => {
    if (entscheide(url, wc.getURL()) === "im-fenster") return;
    event.preventDefault();
    extern(url);
  });
}

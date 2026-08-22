// v0.1.414 — Screenshots der Link-Überwachungs-Läufe.
//
// Bei jedem Lauf wird nach dem vollständigen Laden ein PNG abgelegt. Im
// Verlauf (Audit-Trail) ist es damit nachprüfbar, ob die Seite WIRKLICH
// geladen hat — oder ob nur ein Cookie-Banner, eine Bot-Sperre oder eine
// Login-Wand sichtbar war.
//
// Ablage unter dem bestehenden Screenshot-Root, damit das schon
// registrierte `ava-screenshot://`-Protokoll die Dateien ausliefert:
//
//   userData/screenshots/link-monitor/<monitorId>/<ts>-run.png
//
// Das Protokoll erwartet exakt drei Segmente — Producer, Run, Datei —
// deshalb passt dieses Layout ohne Änderung am Protokoll-Handler.

import { app } from "electron";
import { existsSync, mkdirSync } from "node:fs";
import { promises as fs } from "node:fs";
import { join } from "node:path";

/** Wie viele Läufe je Monitor aufbewahrt werden. */
const KEEP_PER_MONITOR = 10;

const PRODUCER_SEGMENT = "link-monitor";

function rootDir(): string {
  return join(app.getPath("userData"), "screenshots", PRODUCER_SEGMENT);
}

/** Slashes/Dotdot entfernen — identisch zum Protokoll-Handler. */
function sanitize(s: string): string {
  return s.replace(/[/\\]|\.\./g, "_");
}

/**
 * PNG speichern und die `ava-screenshot://`-URL zurückgeben, die der
 * Renderer direkt in ein <img src=...> stecken kann. Gibt null zurück,
 * wenn das Schreiben scheitert — ein fehlender Screenshot darf den Lauf
 * nie beeinflussen.
 */
export async function saveRunScreenshot(
  monitorId: string,
  png: Buffer,
): Promise<string | null> {
  try {
    const monitorSeg = sanitize(monitorId);
    const dir = join(rootDir(), monitorSeg);
    if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
    const filename = `${Date.now()}-run.png`;
    await fs.writeFile(join(dir, filename), png);
    await pruneMonitor(dir);
    return `ava-screenshot://${PRODUCER_SEGMENT}/${monitorSeg}/${filename}`;
  } catch (err) {
    console.warn("[link-monitor] Screenshot speichern fehlgeschlagen:", err);
    return null;
  }
}

/** Nur die jüngsten KEEP_PER_MONITOR Aufnahmen behalten. */
async function pruneMonitor(dir: string): Promise<void> {
  try {
    const files = (await fs.readdir(dir)).filter((f) => f.endsWith(".png"));
    if (files.length <= KEEP_PER_MONITOR) return;
    // Dateinamen beginnen mit dem Zeitstempel → lexikografisch = zeitlich.
    files.sort();
    for (const old of files.slice(0, files.length - KEEP_PER_MONITOR)) {
      await fs.unlink(join(dir, old)).catch(() => undefined);
    }
  } catch {
    /* Aufräumen ist best-effort */
  }
}

/** Alle Aufnahmen eines Monitors entfernen (beim Löschen der Überwachung). */
export async function deleteMonitorScreenshots(
  monitorId: string,
): Promise<void> {
  try {
    await fs.rm(join(rootDir(), sanitize(monitorId)), {
      recursive: true,
      force: true,
    });
  } catch {
    /* best-effort */
  }
}

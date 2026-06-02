// Aufräumen verwaister Temp-Artefakte (v0.1.366).
//
// Befund: Nutzer-Platten füllen sich über `…/Temp/ava-handelsregister-
// downloads`. Der lokale `structured-content`-Producer lädt beim Scrapen
// Handelsregister-Dokumente (Gesellschafterlisten, SI-Dateien) über
// Chromes Download-Manager in `os.tmpdir()/ava-handelsregister-downloads`
// und entfernt sie per-Datei NACH der Verarbeitung. Das ist best-effort:
// stürzt der Producer ab (z. B. der MAX_PATH-Crash-Loop vor v0.1.363) oder
// schlägt der unlink fehl, bleiben die Dateien liegen und summieren sich
// auf zig GB. Ein Verzeichnis-weiter Sweep fehlte.
//
// Da die Producer als Kindprozesse des Desktops mit demselben User /
// derselben TMPDIR laufen, kann der Desktop denselben Ordner aufräumen.
// Wir tun das beim Boot und danach stündlich — mit einer Altersschwelle,
// damit eine GERADE laufende Download/Transkription nicht abgeräumt wird.

import { existsSync, readdirSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

/** Producer-Download-Ordner (Haupt-Platzfresser im Temp). Muss zum
 *  `AVA_HR_DOWNLOAD_DIR`-Default in structured-content/src/infrastructure/
 *  di.ts passen. */
export function handelsregisterTempDir(): string {
  return process.env.AVA_HR_DOWNLOAD_DIR || join(tmpdir(), "ava-handelsregister-downloads");
}

/** Default-Altersschwelle: nur Artefakte älter als 30 min entfernen. Ein
 *  Handelsregister-Download / eine Whisper-Transkription ist nach Sekunden
 *  durch — alles Ältere gilt als verwaist. */
const DEFAULT_MAX_AGE_MS = 30 * 60 * 1000;

function ageMs(path: string, now: number): number {
  try {
    return now - statSync(path).mtimeMs;
  } catch {
    return Number.POSITIVE_INFINITY; // unlesbar → als „alt" behandeln
  }
}

/**
 * Entfernt verwaiste AVA-Temp-Artefakte:
 *   - Inhalt von `…/Temp/ava-handelsregister-downloads` (Producer-Downloads)
 *   - Stale `ava-whisper-*.wav` (Sprach-zu-Text-Zwischendateien)
 *   - Stale `ava-skill-import-*`-Verzeichnisse (Skill-Import-Staging)
 *
 * Best-effort: jede Fehlerquelle wird verschluckt — der Sweep darf den
 * Boot/Lauf nie blockieren. Gibt die Summe der freigegebenen Bytes zurück.
 */
export function sweepManagedTemp(
  opts: { maxAgeMs?: number } = {},
): { freedBytes: number; removed: number } {
  const maxAge = opts.maxAgeMs ?? DEFAULT_MAX_AGE_MS;
  const now = Date.now();
  let freedBytes = 0;
  let removed = 0;

  // 1. Handelsregister-Download-Ordner: alle Einträge älter als maxAge.
  const hrDir = handelsregisterTempDir();
  if (existsSync(hrDir)) {
    for (const name of safeReaddir(hrDir)) {
      const p = join(hrDir, name);
      if (ageMs(p, now) < maxAge) continue;
      const size = sizeOf(p);
      if (tryRemove(p)) {
        freedBytes += size;
        removed += 1;
      }
    }
  }

  // 2./3. Stale ava-whisper-*.wav + ava-skill-import-* direkt im TMPDIR.
  const tmp = tmpdir();
  for (const name of safeReaddir(tmp)) {
    const isWhisper = name.startsWith("ava-whisper-") && name.endsWith(".wav");
    const isSkillImport = name.startsWith("ava-skill-import-");
    if (!isWhisper && !isSkillImport) continue;
    const p = join(tmp, name);
    if (ageMs(p, now) < maxAge) continue;
    const size = sizeOf(p);
    if (tryRemove(p)) {
      freedBytes += size;
      removed += 1;
    }
  }

  if (removed > 0) {
    console.log(
      `[temp-sweep] removed ${removed} stale temp artefact(s), freed ~${(freedBytes / 1024 / 1024).toFixed(0)} MB`,
    );
  }
  return { freedBytes, removed };
}

// ---- Helfer ---------------------------------------------------------------

function safeReaddir(p: string): string[] {
  try {
    return readdirSync(p);
  } catch {
    return [];
  }
}
function sizeOf(p: string): number {
  try {
    const st = statSync(p);
    if (st.isFile()) return st.size;
    if (st.isDirectory()) return dirSize(p);
    return 0;
  } catch {
    return 0;
  }
}
function dirSize(path: string): number {
  let total = 0;
  for (const name of safeReaddir(path)) {
    const p = join(path, name);
    try {
      const st = statSync(p);
      if (st.isDirectory()) total += dirSize(p);
      else if (st.isFile()) total += st.size;
    } catch {
      /* skip */
    }
  }
  return total;
}
function tryRemove(p: string): boolean {
  try {
    rmSync(p, { recursive: true, force: true });
    return true;
  } catch {
    return false;
  }
}

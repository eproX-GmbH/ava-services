// Startsperre waehrend eines laufenden Updates (Befund 2026-11-10, ShipIt_stderr.log:
// "Aborting update attempt because there are 1 running instances of the target app").
// Waehrend ShipIt das neue AVA.app einspielt, ist AVA rund eine Minute weg. Wer in
// dieser Zeit auf das AVA-Symbol klickt, startet die ALTE Version; ShipIt sieht sie
// laufen und bricht die Installation ab. Deshalb beendet sich eine AVA, die startet,
// solange ihr eigenes Update installiert wird, sofort wieder und sagt Bescheid.
//
// Gesperrt wird nur, wenn alles zusammenpasst: Update-Flag dieses Kontos ist frisch,
// es wurde von DERSELBEN Version geschrieben (die frisch aktualisierte AVA, die
// ShipIt selbst startet, hat eine andere Version und darf immer laufen), und ShipIt
// fuer AVA laeuft noch. Faellt eine Bedingung weg, startet AVA normal.

import { spawn, spawnSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { paths } from "../core/platform";
import { getUpdatingFlagPath } from "./watchdog";
import { writeLineSync } from "./file-logger";

/** Aelter als das gilt ein Flag als Rest eines abgebrochenen Updates. */
const FLAG_MAX_ALTER_MS = 15 * 60_000;

export function updateSperrtStart(o: { flagInhalt: string | null; version: string; shipItLaeuft: boolean; jetzt: number }): boolean {
  if (!o.flagInhalt || !o.shipItLaeuft) return false;
  let flag: { ts?: unknown; version?: unknown };
  try {
    flag = JSON.parse(o.flagInhalt) as { ts?: unknown; version?: unknown };
  } catch {
    return false; // altes Flag (nur Zeitstempel) ohne Version: nie sperren
  }
  if (typeof flag.ts !== "number" || typeof flag.version !== "string") return false;
  return flag.version === o.version && o.jetzt - flag.ts >= 0 && o.jetzt - flag.ts < FLAG_MAX_ALTER_MS;
}

function shipItLaeuft(): boolean {
  return spawnSync("/usr/bin/pgrep", ["-f", "com.ava.desktop.ShipIt"]).status === 0;
}

export function pruefeUpdateStartSperre(): void {
  if (process.platform !== "darwin") return;
  const flagPfad = getUpdatingFlagPath();
  const flagInhalt = existsSync(flagPfad) ? readFileSync(flagPfad, "utf8") : null;
  if (!flagInhalt) return;
  if (!updateSperrtStart({ flagInhalt, version: paths().version(), shipItLaeuft: shipItLaeuft(), jetzt: Date.now() })) return;
  writeLineSync("WARN ", "[update] Start waehrend laufender Installation → beende mich sofort, damit ShipIt nicht abbricht");
  try {
    spawn("/usr/bin/osascript", ["-e", 'display notification "AVA wird gerade aktualisiert und startet gleich von selbst neu." with title "AVA"'], {
      detached: true,
      stdio: "ignore",
    }).unref();
  } catch {
    /* Hinweis ist nur Komfort */
  }
  process.exit(0);
}

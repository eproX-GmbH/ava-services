// v0.1.395 — Lokaler Verarbeitungs-Schalter (Play/Pause).
//
// Eine rein LOKALE, nutzergesteuerte Pause der gesamten Verarbeitung auf
// dieser Maschine — ohne Einfluss auf andere Nutzer (die Producer laufen
// compute-local). Pausiert:
//   - die lokalen Producer (sie konsumieren keine AMQP-Events mehr; ein
//     bereits laufender Schritt läuft zu Ende, danach Stillstand), UND
//   - den KI-Agenten: Import-/Retry-Tools brechen ab, solange pausiert.
//
// Dieses Modul hält nur den Zustand + Persistenz + ein Event. Das tatsächliche
// Stoppen/Starten der Producer (inkl. Reachability-Gating) macht index.ts als
// Reaktion auf das `changed`-Event — so bleibt die Producer-Lifecycle-Logik
// an einer Stelle und es gibt keine zyklische Abhängigkeit.

import { EventEmitter } from "node:events";
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { app } from "electron";

function statePath(): string {
  return join(app.getPath("userData"), "processing-control.json");
}

class ProcessingControl extends EventEmitter {
  private paused = false;
  private loaded = false;

  /** Beim Boot einmal aus der Datei laden (vor dem Producer-Start). */
  load(): void {
    if (this.loaded) return;
    this.loaded = true;
    try {
      const raw = readFileSync(statePath(), "utf8");
      const obj = JSON.parse(raw) as { paused?: unknown };
      this.paused = obj.paused === true;
    } catch {
      this.paused = false; // Datei fehlt / unlesbar → Standard: läuft
    }
  }

  isPaused(): boolean {
    return this.paused;
  }

  /**
   * Zustand setzen. Persistiert und emittiert `changed` NUR bei echter
   * Änderung, damit index.ts nicht unnötig Producer neu-startet.
   */
  setPaused(next: boolean): void {
    if (next === this.paused) return;
    this.paused = next;
    try {
      writeFileSync(statePath(), JSON.stringify({ paused: next }), "utf8");
    } catch (err) {
      console.warn(
        "[processing-control] persist failed:",
        err instanceof Error ? err.message : String(err),
      );
    }
    this.emit("changed", next);
  }
}

export const processingControl = new ProcessingControl();

/** Convenience für die Agent-Tools. */
export function isProcessingPaused(): boolean {
  return processingControl.isPaused();
}

/** Einheitliche Fehlermeldung, wenn der Agent bei Pause etwas starten will. */
export const PROCESSING_PAUSED_MESSAGE =
  "Die Verarbeitung ist aktuell pausiert (Play/Pause-Schalter oben in " +
  "Meine Firmen bzw. im Vorgang). Solange pausiert, kann ich keine neue " +
  "Recherche oder Import-Verarbeitung starten. Bitte zuerst wieder auf " +
  "Fortsetzen stellen.";

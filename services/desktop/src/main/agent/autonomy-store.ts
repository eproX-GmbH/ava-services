// v0.1.468 — Globaler Autonomie-Modus (Claude-Code-Muster: ein Modus-
// Schalter direkt am Chat-Eingabefeld, gilt ueberall).
//
// Ersetzt die kanal-spezifischen Vollmacht-Settings aus v0.1.462
// (Telegram-Select, Mail-Checkbox): EIN Modus fuer Chat, Telegram und
// Mail. Abstufung wie PLAN_VOLLMACHT.md:
//
//   "manual"   — Immer fragen (Default; bisheriges Verhalten)
//   "additive" — Neues anlegen laeuft ohne Rueckfrage (Notiz,
//                Aktivitaet, Aufgabe, Neuanlage, Verknuepfung)
//   "mutating" — zusaetzlich Bestehendes aendern (Updates, Enrich/Sync)
//
// Destruktives (Loeschen, Mail an Nicht-Allowlist) bleibt in JEDEM
// Modus bestaetigungspflichtig — dafuer gibt es bewusst keine Stufe.
//
// Datei: userData/agent/autonomy.json — steht in der agentDeletes-
// Positivliste des Werksresets.

import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { app } from "electron";
import type { AutonomyLevel } from "../../shared/types";

export type AutonomyMode = "manual" | "additive" | "mutating";

export class AutonomyStore {
  private readonly dir: string;
  private readonly path: string;
  private cached: AutonomyMode | null = null;

  constructor(dir?: string) {
    this.dir = dir ?? join(app.getPath("userData"), "agent");
    this.path = join(this.dir, "autonomy.json");
  }

  getMode(): AutonomyMode {
    if (this.cached) return this.cached;
    try {
      if (existsSync(this.path)) {
        const parsed = JSON.parse(readFileSync(this.path, "utf8")) as {
          mode?: string;
        };
        this.cached =
          parsed.mode === "additive" || parsed.mode === "mutating"
            ? parsed.mode
            : "manual";
        return this.cached;
      }
    } catch {
      /* korrupt → Default */
    }
    this.cached = "manual";
    return this.cached;
  }

  setMode(mode: AutonomyMode): AutonomyMode {
    const clean: AutonomyMode =
      mode === "additive" || mode === "mutating" ? mode : "manual";
    this.cached = clean;
    try {
      mkdirSync(this.dir, { recursive: true });
      writeFileSync(this.path, JSON.stringify({ mode: clean }), "utf8");
    } catch (err) {
      console.warn("[autonomy] persist failed:", err);
    }
    return clean;
  }

  /** Modus → Vollmacht-Stufe der confirmAction-Mechanik. */
  asLevel(): AutonomyLevel {
    const m = this.getMode();
    return m === "manual" ? "none" : m;
  }
}

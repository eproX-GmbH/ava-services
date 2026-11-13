// Register-Delta S6 / Burggraben-Punkt 4 (docs/PLAN_BURGGRABEN.md 5.3): Einstellungen
// fuers Mithelfen. Ohne ausdrueckliche Entscheidung des Nutzers gilt der Standard des
// Sitzes: bezahlter Sitz (Pro, Max, Ultra, Enterprise) = an, Free oder unbekannt = aus.
// Ein gespeichertes `aktiv` (an oder aus) hat immer Vorrang und wird nie vom Standard
// ueberschrieben. Ohne Electron-Abhaengigkeiten, damit es sich testen laesst.

import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { MithelfenSettings } from "../../shared/register-delta-types";

export type MithelfenQuelle = "standard" | "nutzer";

export class MithelfenSettingsStore {
  private readonly file: string;
  private roh: Partial<MithelfenSettings> | null = null;
  /**
   * @param standard Standard fuer `aktiv`, wenn der Nutzer nie entschieden hat:
   *   true = bezahlter Sitz, false = Free, null = noch unbekannt (zaehlt als aus).
   */
  constructor(dir: string, private readonly standard: () => boolean | null = () => null) {
    mkdirSync(dir, { recursive: true });
    this.file = join(dir, "settings.json");
  }
  private lese(): Partial<MithelfenSettings> {
    if (this.roh) return this.roh;
    try {
      const raw = JSON.parse(readFileSync(this.file, "utf8")) as Partial<MithelfenSettings>;
      this.roh = raw && typeof raw === "object" ? raw : {};
    } catch {
      this.roh = {}; /* Erststart */
    }
    return this.roh;
  }
  get(): MithelfenSettings {
    const raw = this.lese();
    const aktiv = typeof raw.aktiv === "boolean" ? raw.aktiv : this.standard() === true;
    return { aktiv, nurNetzbetrieb: raw.nurNetzbetrieb !== false, nurRegister: raw.nurRegister === true };
  }
  /** Woher `aktiv` stammt: vom Nutzer gesetzt oder aus dem Standard des Sitzes. */
  quelle(): MithelfenQuelle {
    return typeof this.lese().aktiv === "boolean" ? "nutzer" : "standard";
  }
  standardWert(): boolean | null {
    return this.standard();
  }
  set(patch: Partial<MithelfenSettings>): MithelfenSettings {
    const next = { ...this.lese(), ...patch };
    this.roh = next;
    writeFileSync(this.file, JSON.stringify(next, null, 2), "utf8");
    return this.get();
  }
}

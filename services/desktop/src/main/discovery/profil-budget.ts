// 2026-11-20 (Joyce): Im kostenlosen Plan sieht der Nutzer nur zwei Radar-Treffer.
// Den ganzen Kandidaten-Rueckstand zu profilieren, verbrennt dort Rechenzeit und
// KI-Aufrufe fuer nichts. Deshalb ein festes Wochenkontingent an Mini-Profilen
// (ICP-Branchen zuerst, siehe profiler.ts); bezahlte Plaene bleiben unbegrenzt.
//
// Gezaehlt wird jeder bearbeitete Kandidat (auch Fehlschlaege, die kosten ebenfalls),
// rollierend ueber 7 Tage und dateibasiert, damit ein Neustart das Kontingent nicht
// zuruecksetzt.

import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { paths } from "../../core/platform";
import { istVollzugriff } from "./list";

export const FREE_PROFILE_PRO_WOCHE = 30;
const FENSTER_MS = 7 * 24 * 3600_000;

export const FREE_PROFIL_HINWEIS =
  `Mini-Profile: Wochenkontingent im kostenlosen Plan erreicht (${FREE_PROFILE_PRO_WOCHE} pro Woche). ` +
  "Im Plan Pro werden alle Kandidaten profiliert.";

export class ProfilBudget {
  private readonly datei: string;
  private stempel: number[] | null = null;

  constructor(dir?: string) {
    const d = dir ?? join(paths().get("userData"), "discovery");
    this.datei = join(d, "profil-budget.json");
  }

  private laden(): number[] {
    if (this.stempel) return this.stempel;
    try {
      const roh = JSON.parse(readFileSync(this.datei, "utf8")) as { stempel?: unknown };
      this.stempel = Array.isArray(roh.stempel) ? roh.stempel.filter((x): x is number => typeof x === "number") : [];
    } catch {
      this.stempel = [];
    }
    return this.stempel;
  }

  private aufraeumen(): number[] {
    const grenze = Date.now() - FENSTER_MS;
    this.stempel = this.laden().filter((t) => t > grenze);
    return this.stempel;
  }

  /** Wie viele Kandidaten jetzt noch profiliert werden duerfen; null = unbegrenzt. */
  rest(tier: string | null | undefined): number | null {
    if (istVollzugriff(tier)) return null;
    return Math.max(0, FREE_PROFILE_PRO_WOCHE - this.aufraeumen().length);
  }

  /** Bearbeitete Kandidaten verbuchen (nur im kostenlosen Plan noetig). */
  verbuchen(tier: string | null | undefined, anzahl: number): void {
    if (istVollzugriff(tier) || anzahl <= 0) return;
    const jetzt = Date.now();
    const s = this.aufraeumen();
    for (let i = 0; i < anzahl; i++) s.push(jetzt);
    try {
      mkdirSync(join(this.datei, ".."), { recursive: true });
      writeFileSync(this.datei, JSON.stringify({ stempel: s }));
    } catch (err) {
      console.warn("[profil-budget] nicht gespeichert:", err);
    }
  }
}

let geteilt: ProfilBudget | null = null;
/** Eine Instanz fuer Worker und Chat-Werkzeug, damit beide dasselbe Kontingent zaehlen. */
export function profilBudget(): ProfilBudget {
  geteilt ??= new ProfilBudget();
  return geteilt;
}

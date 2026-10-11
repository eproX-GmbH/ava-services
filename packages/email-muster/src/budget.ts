// Tages-Deckel fuer SMTP-Pruefungen je Geraet (docs/PLAN_EMAIL_VERIFIZIERUNG.md
// §3.4, offene Frage 4: ein gemeinsames Budget, Reputation ist geraeteweit).
// Der Producer company-email und der Desktop-Hintergrund-Job zaehlen in dieselbe
// Datei; der Desktop gibt den Pfad per AVA_EMAIL_BUDGET_FILE an den Producer.
// Ohne Datei zaehlt das Budget nur im Speicher (Tests, Entwicklung).

import { mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";

export const TAGES_DECKEL = 50;

interface Stand {
  day: string;
  count: number;
}

export class TagesBudget {
  private speicher: Stand = { day: "", count: 0 };

  constructor(
    private readonly datei: string | null,
    readonly deckel: number = TAGES_DECKEL,
    private readonly heute: () => string = () => new Date().toISOString().slice(0, 10),
  ) {}

  private lese(): Stand {
    const tag = this.heute();
    let s = this.speicher;
    if (this.datei) {
      try {
        const roh = JSON.parse(readFileSync(this.datei, "utf8")) as Partial<Stand>;
        s = { day: String(roh.day ?? ""), count: Number(roh.count ?? 0) || 0 };
      } catch {
        s = { day: tag, count: 0 };
      }
    }
    return s.day === tag ? s : { day: tag, count: 0 };
  }

  private schreibe(s: Stand): void {
    this.speicher = s;
    if (!this.datei) return;
    try {
      mkdirSync(dirname(this.datei), { recursive: true });
      // Erst Hilfsdatei, dann umbenennen: der andere Prozess liest nie eine halbe Datei.
      const tmp = `${this.datei}.${process.pid}.tmp`;
      writeFileSync(tmp, JSON.stringify(s), "utf8");
      renameSync(tmp, this.datei);
    } catch {
      /* best-effort; der Speicherstand gilt weiter */
    }
  }

  verbraucht(): number {
    return this.lese().count;
  }

  frei(): number {
    return Math.max(0, this.deckel - this.verbraucht());
  }

  verbrauche(n: number): void {
    if (n <= 0) return;
    const s = this.lese();
    this.schreibe({ day: s.day, count: s.count + n });
  }
}

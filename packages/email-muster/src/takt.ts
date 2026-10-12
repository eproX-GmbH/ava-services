// Verifizierungsrate (docs/PLAN_EMAIL_VERIFIZIERUNG.md §8.5): hoechstens N
// RCPT-TO-Anfragen je Stunde aus diesem Prozess, gleitendes Fenster. Die Rate
// stellt die Person selbst ein (email-muster.json, `pruefungenJeStunde`); sie
// ersetzt den frueheren festen Tages-Deckel. Erreicht die Stunde ihr Soll,
// wartet der Lauf, statt Adressen als "offen" liegen zu lassen.

/** Standardrate: schnell genug fuer einen Import (eine Firma mit 20 Personen in ~4 Minuten), unauffaellig je Mailserver. */
export const PRUEFUNGEN_JE_STUNDE_STANDARD = 300;
export const PRUEFUNGEN_JE_STUNDE_MIN = 10;
export const PRUEFUNGEN_JE_STUNDE_MAX = 3600;

/** Rate aus einer Einstellung lesen; ungueltig/fehlend = Standard, sonst in die Grenzen gefasst. */
export function pruefungenJeStunde(wert: unknown): number {
  const n = typeof wert === "number" ? wert : typeof wert === "string" ? Number(wert) : NaN;
  if (!Number.isFinite(n) || n <= 0) return PRUEFUNGEN_JE_STUNDE_STANDARD;
  return Math.min(PRUEFUNGEN_JE_STUNDE_MAX, Math.max(PRUEFUNGEN_JE_STUNDE_MIN, Math.round(n)));
}

export interface Takt {
  /** Wartet, bis `n` Anfragen erlaubt sind, und bucht sie. */
  warten(n: number): Promise<void>;
}

export class Taktgeber implements Takt {
  private readonly zeiten: number[] = [];

  constructor(
    private jeStunde: number = PRUEFUNGEN_JE_STUNDE_STANDARD,
    private readonly jetzt: () => number = Date.now,
    private readonly schlafen: (ms: number) => Promise<void> = (ms) => new Promise((r) => setTimeout(r, ms)),
  ) {}

  /** Rate nachziehen (die Person aendert die Einstellung bei laufendem Producer). */
  setzeRate(jeStunde: number): void {
    this.jeStunde = pruefungenJeStunde(jeStunde);
  }

  rate(): number {
    return this.jeStunde;
  }

  /** Anfragen in der letzten Stunde. */
  verbraucht(): number {
    const grenze = this.jetzt() - 3_600_000;
    while (this.zeiten.length && this.zeiten[0]! < grenze) this.zeiten.shift();
    return this.zeiten.length;
  }

  frei(): number {
    return Math.max(0, this.jeStunde - this.verbraucht());
  }

  async warten(n: number): Promise<void> {
    const bedarf = Math.max(1, Math.min(n, this.jeStunde));
    for (;;) {
      if (this.frei() >= bedarf) break;
      // So lange, bis genug alte Eintraege aus dem Fenster fallen.
      const freizugeben = bedarf - this.frei();
      const faelligAb = this.zeiten[freizugeben - 1]! + 3_600_000;
      await this.schlafen(Math.max(1000, faelligAb - this.jetzt() + 500));
    }
    const now = this.jetzt();
    for (let i = 0; i < bedarf; i++) this.zeiten.push(now);
  }
}

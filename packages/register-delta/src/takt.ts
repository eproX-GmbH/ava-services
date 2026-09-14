// Taktgeber: hoechstens N Abfragen je Stunde (Nutzungsordnung des
// Registerportals: 60), gleichmaessig verteilt mit etwas Streuung, damit die
// Abfragen nicht im Sekundentakt kommen. Zaehlt ueber ein gleitendes Fenster.

export class Taktgeber {
  private readonly zeiten: number[] = [];
  private readonly mindestAbstandMs: number;

  constructor(
    private readonly jeStunde = 60,
    private readonly jetzt: () => number = Date.now,
    private readonly schlafen: (ms: number) => Promise<void> = (ms) => new Promise((r) => setTimeout(r, ms)),
  ) {
    this.mindestAbstandMs = Math.ceil(3_600_000 / Math.max(1, jeStunde));
  }

  /** Anzahl Abfragen in der letzten Stunde. */
  verbraucht(): number {
    const grenze = this.jetzt() - 3_600_000;
    while (this.zeiten.length && this.zeiten[0] < grenze) this.zeiten.shift();
    return this.zeiten.length;
  }

  frei(): number {
    return Math.max(0, this.jeStunde - this.verbraucht());
  }

  /** Wartet, bis die naechste Abfrage erlaubt ist, und bucht sie. */
  async warten(): Promise<void> {
    for (;;) {
      const n = this.verbraucht();
      const letzte = this.zeiten[this.zeiten.length - 1];
      const now = this.jetzt();
      if (n >= this.jeStunde) {
        await this.schlafen(Math.max(1000, this.zeiten[0] + 3_600_000 - now + 500));
        continue;
      }
      const seitLetzter = letzte === undefined ? Infinity : now - letzte;
      if (seitLetzter < this.mindestAbstandMs) {
        await this.schlafen(this.mindestAbstandMs - seitLetzter + Math.floor(Math.random() * 800));
        continue;
      }
      this.zeiten.push(this.jetzt());
      return;
    }
  }
}

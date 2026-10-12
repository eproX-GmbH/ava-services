// Verifizierungsrate (docs/PLAN_EMAIL_VERIFIZIERUNG.md §8.5): N RCPT-TO-Anfragen
// je Stunde aus diesem Prozess, GLEICHMAESSIG ueber die Stunde verteilt (bei 300
// alle 12 s eine Anfrage; eine Verbindung mit 6 Anfragen reserviert 72 s), kein
// Burst mit anschliessender Pause. Die Rate stellt die Person selbst ein
// (email-muster.json, `pruefungenJeStunde`); sie ersetzt den frueheren festen
// Tages-Deckel. Statt Adressen "offen" liegen zu lassen, wartet der Lauf.

/** Standardrate: alle 12 s eine Anfrage — eine Firma mit 20 Personen in ~6 Minuten, unauffaellig je Mailserver. */
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
  /** Zeitpunkt, ab dem die naechste Anfrage erlaubt ist. */
  private freiAb = 0;
  /** Gebuchte Anfragen (fuer Auskunft/Tests). */
  private gebucht = 0;

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

  /** Abstand je Anfrage in ms (bei 300/h = 12 000). */
  abstandMs(): number {
    return Math.ceil(3_600_000 / Math.max(1, this.jeStunde));
  }

  verbraucht(): number {
    return this.gebucht;
  }

  /** Wartezeit bis zur naechsten erlaubten Anfrage (0 = sofort). */
  wartezeitMs(): number {
    return Math.max(0, this.freiAb - this.jetzt());
  }

  /**
   * Wartet, bis die naechste Anfrage erlaubt ist, und reserviert `n` Slots:
   * die uebernaechste Verbindung darf erst nach n × Abstand. Die erste Anfrage
   * eines Prozesses geht sofort; danach fliesst es gleichmaessig.
   */
  async warten(n: number): Promise<void> {
    const bedarf = Math.max(1, n);
    const wartezeit = this.wartezeitMs();
    if (wartezeit > 0) await this.schlafen(wartezeit);
    const now = this.jetzt();
    this.freiAb = Math.max(now, this.freiAb) + bedarf * this.abstandMs();
    this.gebucht += bedarf;
  }
}

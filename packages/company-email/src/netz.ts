// Port-25-Erreichbarkeit (viele Nutzernetze und Fly-Instanzen sperren
// ausgehend Port 25). Beim Start und alle 6 Stunden pruefen; scheitert eine
// echte Pruefung am Netz, gilt es bis zur naechsten Pruefung als gesperrt.

import { pruefePort25 } from "@ava/email-muster";

export const NETZ_RECHECK_MS = 6 * 3600_000;

export class NetzStatus {
  private stand: { erreichbar: boolean; grund: string; at: number } | null = null;
  private laufend: Promise<void> | null = null;

  constructor(
    private readonly pruefe: () => Promise<{ erreichbar: boolean; grund: string }> = () => pruefePort25(),
    private readonly jetzt: () => number = () => Date.now(),
  ) {}

  ok(): boolean {
    return this.stand?.erreichbar === true;
  }

  grund(): string {
    return this.stand?.grund ?? "noch nicht geprueft";
  }

  async aktualisiere(): Promise<void> {
    if (this.stand && this.jetzt() - this.stand.at < NETZ_RECHECK_MS) return;
    if (!this.laufend) {
      this.laufend = this.pruefe()
        .then((r) => {
          this.stand = { ...r, at: this.jetzt() };
        })
        .catch((e: unknown) => {
          this.stand = { erreichbar: false, grund: e instanceof Error ? e.message : String(e), at: this.jetzt() };
        })
        .finally(() => {
          this.laufend = null;
        });
    }
    await this.laufend;
  }

  /** Frische Gegenprobe (ohne Wartefrist): liegt es am Netz oder nur an einem Mailserver? */
  async pruefeErneut(): Promise<boolean> {
    this.stand = null;
    await this.aktualisiere();
    return this.ok();
  }

  gesperrt(grund: string): void {
    this.stand = { erreichbar: false, grund, at: this.jetzt() };
  }
}

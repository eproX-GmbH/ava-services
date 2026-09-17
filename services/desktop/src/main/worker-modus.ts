// Worker-Modus: AVA arbeitet ausschliesslich Handelsregister-Jobs ab
// (Register-Delta "Mithelfen", strukturierter Registerinhalt und spaeter
// Gesellschafterlisten) und laesst alles andere ruhen.
//
// Gedacht fuer Rechner, die nebenher als Verarbeiter laufen sollen: kein
// Herzschlag, keine Vorgaenge, keine Producer, keine Workflows, keine
// Mail-Verarbeitung, kein Radar. Die App bleibt bedienbar, damit der Modus
// wieder ausgeschaltet werden kann.
//
// Aufbau: Dienste melden sich beim Start der App hier an und geben an, wie sie
// anhalten und wieder anlaufen. Der Modus haelt sie an und laesst sie beim
// Ausschalten wieder an. Dienste, die aus anderen Gruenden ruhen (Feature aus,
// Einstellung aus), duerfen beim Wiederanlauf selbst entscheiden: dafuer
// bekommt jeder Dienst ein `darfLaufen`, das vor dem Anlauf gefragt wird.

import { EventEmitter } from "node:events";

export type WorkerModusDienst = {
  /** Kurzname fuer das Protokoll, z. B. "Herzschlag". */
  name: string;
  anhalten: () => void | Promise<void>;
  anlaufen: () => void | Promise<void>;
  /** Fehlt oder true: Dienst darf nach dem Ausschalten wieder anlaufen. */
  darfLaufen?: () => boolean;
};

class WorkerModus extends EventEmitter {
  private an = false;
  private dienste: WorkerModusDienst[] = [];
  private log: (zeile: string) => void = () => {};

  protokoll(log: (zeile: string) => void): void {
    this.log = log;
  }

  aktiv(): boolean {
    return this.an;
  }

  anmelden(dienst: WorkerModusDienst): void {
    this.dienste.push(dienst);
    // Dienste, die erst spaeter im Start anlaufen (Mail, geplante Aufgaben,
    // Link-Beobachter), wuerden sonst im Worker-Modus weiterlaufen, weil das
    // Anwenden vor ihrer Anmeldung lag.
    if (this.an) {
      try {
        void dienst.anhalten();
      } catch (err) {
        this.log(`Worker-Modus: ${dienst.name} anhalten fehlgeschlagen: ${err instanceof Error ? err.message : String(err)}`);
      }
    }
  }

  /** Namen der angemeldeten Dienste (Diagnose, Einstellungen). */
  angemeldet(): string[] {
    return this.dienste.map((d) => d.name);
  }

  /**
   * Modus setzen. Ein Wechsel haelt alle Dienste an oder laesst sie wieder
   * anlaufen; ein Fehler eines einzelnen Dienstes darf die anderen nie
   * aufhalten, sonst bleibt die App in einem halben Zustand stehen.
   */
  async setzen(an: boolean): Promise<void> {
    if (an === this.an) return;
    this.an = an;
    this.log(`Worker-Modus ${an ? "an" : "aus"}: ${this.dienste.length} Dienste`);
    await this.anwenden();
    this.emit("changed", an);
  }

  /** Soll-Zustand herstellen (auch beim Start der App aufzurufen). */
  async anwenden(): Promise<void> {
    for (const d of this.dienste) {
      try {
        if (this.an) {
          await d.anhalten();
        } else if (d.darfLaufen?.() !== false) {
          await d.anlaufen();
        }
      } catch (err) {
        this.log(`Worker-Modus: ${d.name} ${this.an ? "anhalten" : "anlaufen"} fehlgeschlagen: ${err instanceof Error ? err.message : String(err)}`);
      }
    }
  }
}

export const workerModus = new WorkerModus();

/** Kurzform fuer Stellen, die nur wissen muessen, ob gerade nur Register laeuft. */
export function nurRegisterVerarbeitung(): boolean {
  return workerModus.aktiv();
}

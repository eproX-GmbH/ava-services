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

/** Hoechstzeit je Dienst. Laenger darf kein Anhalten den Start aufhalten. */
const DIENST_FRIST_MS = 3000;

/**
 * Laesst einen Aufruf nicht laenger als `ms` dauern. Wirkt nur gegen haengende
 * Zusagen; blockiert ein Dienst die Ereignisschleife synchron, hilft allein die
 * Protokollzeile davor, ihn zu erkennen.
 */
async function mitFrist(fn: () => void | Promise<void>, ms: number, was: string): Promise<void> {
  let zeiger: NodeJS.Timeout | undefined;
  try {
    await Promise.race([
      Promise.resolve().then(fn),
      new Promise<never>((_, ab) => {
        zeiger = setTimeout(() => ab(new Error(`Frist von ${ms} ms ueberschritten`)), ms);
        zeiger.unref?.();
      }),
    ]);
  } finally {
    if (zeiger) clearTimeout(zeiger);
  }
  void was;
}

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

  /**
   * Soll-Zustand herstellen (auch beim Start der App aufzurufen).
   *
   * Drei Vorkehrungen, alle aus dem Vorfall vom 2026-09-18 (v0.1.678 startete
   * im Worker-Modus nicht mehr, die App hing beim Anwenden und der Wachhund
   * startete sie endlos neu):
   *   1. Es wird ueber eine Kopie der Liste gelaufen. Meldet sich waehrend des
   *      Anwendens ein Dienst an, waechst die Liste sonst mit und die Schleife
   *      kommt nie zum Ende.
   *   2. Jeder Dienst bekommt eine Frist. Ein haengender Dienst haelt damit
   *      nicht mehr den Start der App auf.
   *   3. Vor und nach jedem Dienst wird eine Zeile geschrieben. Blockiert ein
   *      Dienst die Ereignisschleife, steht sein Name als letzter im Protokoll.
   *      Deshalb muss die Protokollfunktion synchron schreiben.
   */
  async anwenden(): Promise<void> {
    const liste = [...this.dienste];
    for (const d of liste) {
      const was = this.an ? "anhalten" : "anlaufen";
      if (!this.an && d.darfLaufen?.() === false) continue;
      this.log(`> ${d.name} ${was}`);
      try {
        await mitFrist(() => (this.an ? d.anhalten() : d.anlaufen()), DIENST_FRIST_MS, `${d.name} ${was}`);
        this.log(`< ${d.name} ${was}`);
      } catch (err) {
        this.log(`! ${d.name} ${was} fehlgeschlagen: ${err instanceof Error ? err.message : String(err)}`);
      }
    }
    this.log(`fertig (${liste.length} Dienste, Modus ${this.an ? "an" : "aus"})`);
  }
}

export const workerModus = new WorkerModus();

/** Kurzform fuer Stellen, die nur wissen muessen, ob gerade nur Register laeuft. */
export function nurRegisterVerarbeitung(): boolean {
  return workerModus.aktiv();
}

/**
 * Fuer lange Schleifen: true, sobald das, was gerade laeuft, aufhoeren soll.
 *
 * Notwendig, weil `anhalten` nur den Zeitgeber loescht. Eine Arbeit, die beim
 * Einschalten schon lief, arbeitet sonst ihre ganze Liste zu Ende — am
 * 2026-09-18 waren das zwoelf Minuten Mini-Profile mit 41 Modellaufrufen und
 * Radar-Treffern per Telegram, obwohl der Modus laengst an war. Wer eine
 * Schleife ueber Einheiten laeuft, fragt hier zwischen zwei Einheiten nach.
 */
export function arbeitAbbrechen(): boolean {
  return workerModus.aktiv();
}

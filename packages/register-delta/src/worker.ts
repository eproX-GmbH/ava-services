// Worker-Schleife: Job leasen, ausfuehren, melden. Laeuft, bis stop()
// gerufen wird. Bei Portal-Sperre eine Stunde Pause; ohne Jobs Wartezeit.

import { GatewayClient, type Job, type JobArt } from "./gateway-client";
import { fuehreJobAus, MAX_ABFRAGEN_JE_JOB, type InsolvenzSchnittstelle, type PortalSchnittstelle } from "./jobs";
import { Taktgeber } from "./takt";

export type WorkerOptionen = {
  workerId: string;
  workerArt: "desktop" | "betreiber";
  gateway: GatewayClient;
  portal: () => Promise<PortalSchnittstelle & { schliessen(): Promise<void> }>;
  /** Insolvenzportal (I3); ohne Angabe werden insolvenz-Jobs nicht geleast. */
  insolvenz?: () => Promise<InsolvenzSchnittstelle & { schliessen(): Promise<void> }>;
  abfragenJeStunde?: number;
  arten?: JobArt[];
  leerlaufMs?: number;
  log?: (zeile: string) => void;
  /** Soll gerade pausiert werden (Chat aktiv, Akku, Nutzer will nicht)? */
  pausiert?: () => boolean;
  onJob?: (job: Job, ergebnis: Record<string, unknown>) => void;
  /** Wird bei jeder Zustandsaenderung gerufen (Desktop: Statuskarte). */
  onZustand?: (zustand: WorkerStatus) => void;
};

export type WorkerStatus = {
  laeuft: boolean;
  aktuellerJob: Job | null;
  jobsErledigt: number;
  abfragenLetzteStunde: number;
  gesperrtBis: string | null;
  letzterFehler: string | null;
};

export class RegisterWorker {
  private stopSignal = false;
  private laufPromise: Promise<void> | null = null;
  private readonly takt: Taktgeber;
  private readonly log: (z: string) => void;
  private status: WorkerStatus = { laeuft: false, aktuellerJob: null, jobsErledigt: 0, abfragenLetzteStunde: 0, gesperrtBis: null, letzterFehler: null };

  constructor(private readonly o: WorkerOptionen) {
    this.takt = new Taktgeber(o.abfragenJeStunde ?? 60);
    this.log = o.log ?? (() => {});
  }

  zustand(): WorkerStatus {
    return { ...this.status, abfragenLetzteStunde: this.takt.verbraucht() };
  }

  private melde(): void {
    try {
      this.o.onZustand?.(this.zustand());
    } catch {
      /* Zuhoerer-Fehler nicht in die Schleife tragen */
    }
  }

  start(): void {
    if (this.laufPromise) return;
    this.stopSignal = false;
    this.status.laeuft = true;
    this.melde();
    this.laufPromise = this.schleife().finally(() => {
      this.status.laeuft = false;
      this.laufPromise = null;
      this.melde();
    });
  }

  async stop(): Promise<void> {
    this.stopSignal = true;
    await this.laufPromise;
  }

  private async schleife(): Promise<void> {
    let portal: (PortalSchnittstelle & { schliessen(): Promise<void> }) | null = null;
    let insolvenz: (InsolvenzSchnittstelle & { schliessen(): Promise<void> }) | null = null;
    const arten = this.o.arten ?? (this.o.insolvenz ? undefined : (["front", "bekanntmachungen", "refresh"] as JobArt[]));
    try {
      while (!this.stopSignal) {
        if (this.o.pausiert?.() || (this.status.gesperrtBis && Date.parse(this.status.gesperrtBis) > Date.now())) {
          await this.warte(30_000);
          continue;
        }
        let job: Job | null = null;
        try {
          job = await this.o.gateway.lease(this.o.workerId, this.o.workerArt, arten);
        } catch (err) {
          this.status.letzterFehler = String(err instanceof Error ? err.message : err);
          this.log(`lease fehlgeschlagen: ${this.status.letzterFehler}`);
          await this.warte(60_000);
          continue;
        }
        if (!job) {
          await this.warte(this.o.leerlaufMs ?? 5 * 60_000);
          continue;
        }
        this.status.aktuellerJob = job;
        this.melde();
        this.log(`job ${job.id} ${job.art} ${job.schluessel}`);
        try {
          portal ??= await this.o.portal();
          const ergebnis = await fuehreJobAus(job, {
            workerId: this.o.workerId,
            portal,
            insolvenz: this.o.insolvenz
              ? async () => {
                  insolvenz ??= await this.o.insolvenz!(); // eslint-disable-line @typescript-eslint/no-non-null-assertion
                  return insolvenz;
                }
              : undefined,
            takt: this.takt,
            maxAbfragenJeJob: MAX_ABFRAGEN_JE_JOB,
            log: this.log,
            abbrechen: () => this.stopSignal || Boolean(this.o.pausiert?.()),
          });
          const antwort = await this.o.gateway.ergebnis(job.id, ergebnis);
          this.status.jobsErledigt++;
          this.status.letzterFehler = null;
          this.o.onJob?.(job, antwort);
          if (ergebnis.gesperrt) {
            this.status.gesperrtBis = new Date(Date.now() + 3_600_000).toISOString();
            this.log("Portal gesperrt, eine Stunde Pause");
            await portal.schliessen();
            portal = null;
          }
        } catch (err) {
          const grund = err instanceof Error ? err.message : String(err);
          this.status.letzterFehler = grund;
          this.log(`job ${job.id} fehlgeschlagen: ${grund}`);
          try {
            await this.o.gateway.fehler(job.id, this.o.workerId, grund);
          } catch {
            /* Lease laeuft aus */
          }
          // Browser neu starten, falls er haengt.
          if (portal) {
            await portal.schliessen();
            portal = null;
          }
          const ip = insolvenz as (InsolvenzSchnittstelle & { schliessen(): Promise<void> }) | null;
          if (ip) {
            await ip.schliessen();
            insolvenz = null;
          }
          await this.warte(30_000);
        } finally {
          this.status.aktuellerJob = null;
          this.melde();
        }
      }
    } finally {
      if (portal) await portal.schliessen();
      const ip = insolvenz as (InsolvenzSchnittstelle & { schliessen(): Promise<void> }) | null;
      if (ip) await ip.schliessen();
    }
  }

  private warte(ms: number): Promise<void> {
    return new Promise((r) => {
      const t = setInterval(() => {
        if (this.stopSignal) {
          clearInterval(t);
          r();
        }
      }, 500);
      setTimeout(() => {
        clearInterval(t);
        r();
      }, ms);
    });
  }
}

// Register-Delta S6 — Desktop-Worker "Mithelfen" (docs/PLAN_STAMMDATEN_DELTA.md).
//
// Startet das vendierte Paket @ava/register-delta (resources/p/rd/dist/cli.js)
// als Kindprozess, so wie die Producer: eigener Chrome per Selenium, eigene IP
// des Nutzers, Budget 60 Abfragen je Stunde. Bearer-Token kommt aus einer
// Datei (0600) im userData-Verzeichnis, die bei jeder Erneuerung neu
// geschrieben wird; der Kindprozess liest sie vor jedem Gateway-Aufruf.
// Pausen: Einstellung aus, Organisation sperrt, abgemeldet, Akku (wenn
// gewuenscht). Logs landen im Producer-Log-Puffer unter "register-delta".

import { EventEmitter } from "node:events";
import { spawn, type ChildProcess } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, writeFileSync, chmodSync } from "node:fs";
import { hostname } from "node:os";
import { join } from "node:path";
import { powerMonitor } from "electron";
import type { MithelfenSettings, MithelfenStatus } from "../../shared/register-delta-types";
import { producerLogBuffer } from "../producer-log-buffer";
import { featureEnabled, onOrgPolicyChange } from "../org-policy";
import { resolveProducerDirUnder } from "../producer-dirs";

const LOG_NAME = "register-delta";
const STATUS_MARKER = "__AVA_RD_STATUS__";
const TOKEN_INTERVAL_MS = 5 * 60_000;

export class MithelfenSettingsStore {
  private readonly file: string;
  private cache: MithelfenSettings | null = null;
  constructor(dir: string) {
    mkdirSync(dir, { recursive: true });
    this.file = join(dir, "settings.json");
  }
  get(): MithelfenSettings {
    if (this.cache) return this.cache;
    let raw: Partial<MithelfenSettings> = {};
    try {
      raw = JSON.parse(readFileSync(this.file, "utf8"));
    } catch {
      /* Erststart */
    }
    this.cache = { aktiv: raw.aktiv === true, nurNetzbetrieb: raw.nurNetzbetrieb !== false };
    return this.cache;
  }
  set(patch: Partial<MithelfenSettings>): MithelfenSettings {
    const next = { ...this.get(), ...patch };
    this.cache = next;
    writeFileSync(this.file, JSON.stringify(next, null, 2), "utf8");
    return next;
  }
}

export interface MithelfenSupervisorOptions {
  userDataDir: string;
  resourcesRoot: string;
  gatewayUrl: string;
  getAccessToken: () => Promise<string | null>;
  getActorId: () => string | null;
  settings: MithelfenSettingsStore;
}

type KindZustand = {
  laeuft: boolean;
  aktuellerJob: { id: string; art: string; schluessel: string } | null;
  jobsErledigt: number;
  abfragenLetzteStunde: number;
  gesperrtBis: string | null;
  letzterFehler: string | null;
};

export class MithelfenSupervisor extends EventEmitter {
  private child: ChildProcess | null = null;
  private tokenTimer: NodeJS.Timeout | null = null;
  private signedIn = false;
  private zustand: KindZustand = { laeuft: false, aktuellerJob: null, jobsErledigt: 0, abfragenLetzteStunde: 0, gesperrtBis: null, letzterFehler: null };
  private readonly tokenFile: string;
  private stopping = false;

  constructor(private readonly o: MithelfenSupervisorOptions) {
    super();
    const dir = join(o.userDataDir, "register-delta");
    mkdirSync(dir, { recursive: true });
    this.tokenFile = join(dir, "worker.token");
    onOrgPolicyChange(() => void this.abgleichen("policy"));
    powerMonitor.on("on-battery", () => void this.abgleichen("akku"));
    powerMonitor.on("on-ac", () => void this.abgleichen("netz"));
  }

  private log(line: string): void {
    producerLogBuffer.push(LOG_NAME, "stdout", `[mithelfen] ${line}\n`);
  }

  private entry(): string | null {
    const dir = resolveProducerDirUnder(this.o.resourcesRoot, LOG_NAME);
    if (!dir) return null;
    const e = join(dir, "dist", "cli.js");
    return existsSync(e) ? e : null;
  }

  private workerId(): string | null {
    const actor = this.o.getActorId();
    if (!actor) return null;
    return `desktop-${actor.slice(0, 8)}-${hostname().replace(/[^A-Za-z0-9.-]/g, "").slice(0, 40)}`;
  }

  /** Grund, warum gerade nicht gearbeitet werden soll (null = arbeiten). */
  private pausenGrund(): MithelfenStatus["pausenGrund"] {
    const s = this.o.settings.get();
    if (!s.aktiv) return "aus";
    if (!featureEnabled("stammdaten.mithelfen")) return "organisation";
    if (!this.signedIn) return "abgemeldet";
    if (!this.entry()) return "nicht_installiert";
    if (s.nurNetzbetrieb && powerMonitor.isOnBatteryPower()) return "akku";
    if (this.zustand.gesperrtBis && Date.parse(this.zustand.gesperrtBis) > Date.now()) return "gesperrt";
    return null;
  }

  status(): MithelfenStatus {
    const s = this.o.settings.get();
    return {
      aktiv: s.aktiv,
      nurNetzbetrieb: s.nurNetzbetrieb,
      orgErlaubt: featureEnabled("stammdaten.mithelfen"),
      laeuft: this.child !== null,
      pausenGrund: this.pausenGrund(),
      aktuellerJob: this.zustand.aktuellerJob,
      jobsErledigt: this.zustand.jobsErledigt,
      abfragenLetzteStunde: this.zustand.abfragenLetzteStunde,
      gesperrtBis: this.zustand.gesperrtBis,
      letzterFehler: this.zustand.letzterFehler,
      workerId: this.workerId(),
    };
  }

  setSignedIn(signedIn: boolean): void {
    this.signedIn = signedIn;
    void this.abgleichen(signedIn ? "angemeldet" : "abgemeldet");
  }

  setSettings(patch: Partial<MithelfenSettings>): MithelfenStatus {
    this.o.settings.set(patch);
    void this.abgleichen("einstellung");
    return this.status();
  }

  /** Soll-Zustand herstellen: starten oder stoppen. */
  async abgleichen(grund: string): Promise<void> {
    const pause = this.pausenGrund();
    if (pause === null && !this.child) {
      this.log(`start (${grund})`);
      await this.start();
    } else if (pause !== null && pause !== "gesperrt" && this.child) {
      this.log(`stop (${grund}: ${pause})`);
      await this.stop();
    }
    this.emit("status", this.status());
  }

  private async schreibeToken(): Promise<boolean> {
    const token = await this.o.getAccessToken();
    if (!token) return false;
    writeFileSync(this.tokenFile, token, { encoding: "utf8", mode: 0o600 });
    try {
      chmodSync(this.tokenFile, 0o600);
    } catch {
      /* Windows */
    }
    return true;
  }

  private async start(): Promise<void> {
    const entry = this.entry();
    const workerId = this.workerId();
    if (!entry || !workerId) return;
    if (!(await this.schreibeToken())) return;
    this.stopping = false;
    const child = spawn(process.execPath, [entry], {
      cwd: join(entry, "..", ".."),
      env: {
        ...process.env,
        ELECTRON_RUN_AS_NODE: "1",
        GATEWAY_URL: this.o.gatewayUrl,
        WORKER_ID: workerId,
        WORKER_ART: "desktop",
        WORKER_TOKEN_FILE: this.tokenFile,
        ABFRAGEN_JE_STUNDE: "60",
        REGISTER_DELTA_STATUS: "1",
      },
      stdio: ["ignore", "pipe", "pipe"],
    });
    this.child = child;
    this.zustand.letzterFehler = null;
    const verarbeite = (kanal: "stdout" | "stderr", chunk: Buffer) => {
      const text = chunk.toString("utf8");
      for (const line of text.split("\n")) {
        const i = line.indexOf(STATUS_MARKER);
        if (i >= 0) {
          try {
            const z = JSON.parse(line.slice(i + STATUS_MARKER.length)) as Partial<KindZustand>;
            this.zustand = { ...this.zustand, ...z, aktuellerJob: z.aktuellerJob ? { id: String(z.aktuellerJob.id), art: z.aktuellerJob.art, schluessel: z.aktuellerJob.schluessel } : null };
            this.emit("status", this.status());
          } catch {
            /* unvollstaendige Zeile */
          }
        }
      }
      producerLogBuffer.push(LOG_NAME, kanal, text.replace(new RegExp(`${STATUS_MARKER}.*\\n?`, "g"), ""));
    };
    child.stdout?.on("data", (c: Buffer) => verarbeite("stdout", c));
    child.stderr?.on("data", (c: Buffer) => verarbeite("stderr", c));
    child.on("exit", (code, signal) => {
      this.log(`beendet (code ${code ?? "-"}, signal ${signal ?? "-"})`);
      this.child = null;
      this.zustand.aktuellerJob = null;
      if (this.tokenTimer) clearInterval(this.tokenTimer);
      this.tokenTimer = null;
      if (!this.stopping) {
        this.zustand.letzterFehler = `Worker unerwartet beendet (code ${code ?? "-"})`;
        setTimeout(() => void this.abgleichen("neustart"), 60_000);
      }
      this.emit("status", this.status());
    });
    this.tokenTimer = setInterval(() => void this.schreibeToken(), TOKEN_INTERVAL_MS);
  }

  async stop(): Promise<void> {
    const child = this.child;
    if (!child) return;
    this.stopping = true;
    if (this.tokenTimer) clearInterval(this.tokenTimer);
    this.tokenTimer = null;
    await new Promise<void>((resolve) => {
      const t = setTimeout(() => {
        try {
          child.kill("SIGKILL");
        } catch {
          /* weg */
        }
        resolve();
      }, 10_000);
      child.once("exit", () => {
        clearTimeout(t);
        resolve();
      });
      try {
        child.kill("SIGTERM");
      } catch {
        clearTimeout(t);
        resolve();
      }
    });
    this.child = null;
  }
}

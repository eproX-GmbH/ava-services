// Gateway-Routen /v1/register-jobs/* (services/db-gateway/src/routes/v1/register-jobs.ts).

import { createHmac } from "node:crypto";
import type { Bekanntmachung, Treffer } from "./parser";

export type JobArt = "front" | "bekanntmachungen" | "refresh" | "insolvenz";
export const ALLE_JOB_ARTEN: JobArt[] = ["front", "bekanntmachungen", "refresh", "insolvenz"];

export type Job = {
  id: string;
  art: JobArt;
  schluessel: string;
  payload: Record<string, unknown>;
  prioritaet: number;
  leaseUntil: string | null;
  versuche: number;
  abfragenJeStunde: number;
};

export type TrefferMeldung = {
  gericht: string;
  art: string;
  nummer: number;
  zusatz: string;
  frueher: string;
  /** true = zur Nummer existiert auch ein aktuelles Blatt, Id bekommt _F<ALTGERICHT>. */
  frueherSuffix?: boolean;
  bundesland: string;
  name: string;
  sitz: string;
  status: Treffer["status"];
  historie: Array<{ name: string; sitz: string; order: number }>;
};

export type InsolvenzMeldung = { companyId: string; aktenzeichen: string; insolvenzgericht: string; datum: string; gegenstand: string; text: string };

export type Ergebnis = {
  workerId: string;
  abfragen: number;
  gesperrt?: boolean;
  treffer: TrefferMeldung[];
  front?: { maxNummer: number; offeneLuecken: number[]; zusaetze?: string[] };
  /** insolvenz: Veroeffentlichungen plus alle in diesem Job geprueften Firmen. */
  insolvenz?: { meldungen: InsolvenzMeldung[]; geprueft: string[] };
  bekanntmachungen?: Array<Omit<Bekanntmachung, "tagIso" | "kopf" | "geparst">>;
};

export type GatewayClientOptionen = {
  baseUrl: string;
  /** Desktop: Bearer-Token der Keycloak-Sitzung → Routen /v1/register-jobs/*. */
  token?: () => Promise<string>;
  /** Betreiber-Worker: HMAC-Geheimnis des internen Kanals → Routen /internal/register-jobs/*. */
  hmacSecret?: string;
  fetchImpl?: typeof fetch;
};

export class GatewayClient {
  private readonly f: typeof fetch;
  constructor(private readonly opt: GatewayClientOptionen) {
    this.f = opt.fetchImpl ?? fetch;
  }

  private get praefix(): string {
    return this.opt.hmacSecret ? "/internal" : "/v1";
  }

  private async call<T>(method: "GET" | "POST", path: string, body?: unknown): Promise<{ status: number; data: T | null }> {
    const headers: Record<string, string> = { "content-type": "application/json" };
    let raw: string | undefined = body === undefined ? undefined : JSON.stringify(body);
    if (this.opt.hmacSecret) {
      raw ??= "{}";
      headers["x-internal-signature"] = createHmac("sha256", this.opt.hmacSecret).update(raw, "utf8").digest("hex");
    } else if (this.opt.token) {
      headers.authorization = `Bearer ${await this.opt.token()}`;
    } else {
      throw new Error("GatewayClient: token oder hmacSecret noetig");
    }
    // Nach einem langen Job (15 Minuten Leerlauf) ist die Verbindung vom Proxy
    // geschlossen; der erste Versuch scheitert mit "fetch failed". Einmal
    // wiederholen; Ergebnis-Meldungen sind serverseitig idempotent.
    let res: Response;
    try {
      res = await this.f(`${this.opt.baseUrl.replace(/\/$/, "")}${path}`, { method, headers, body: raw });
    } catch (err) {
      if (!(err instanceof TypeError)) throw err;
      await new Promise((r) => setTimeout(r, 1500));
      res = await this.f(`${this.opt.baseUrl.replace(/\/$/, "")}${path}`, { method, headers, body: raw });
    }
    if (res.status === 204) return { status: 204, data: null };
    const text = await res.text();
    if (!res.ok) throw new Error(`gateway ${method} ${path} → ${res.status} ${text.slice(0, 200)}`);
    return { status: res.status, data: text ? (JSON.parse(text) as T) : null };
  }

  async lease(workerId: string, workerArt: "desktop" | "betreiber", arten?: JobArt[]): Promise<Job | null> {
    // Arten immer ausdruecklich melden: das Gateway gibt insolvenz-Jobs nur an Worker, die sie kennen.
    const r = await this.call<Job>("POST", `${this.praefix}/register-jobs/lease`, { workerId, workerArt, arten: arten ?? ALLE_JOB_ARTEN });
    return r.data;
  }

  async ergebnis(jobId: string, ergebnis: Ergebnis): Promise<Record<string, unknown>> {
    return (await this.call<Record<string, unknown>>("POST", `${this.praefix}/register-jobs/${jobId}/ergebnis`, ergebnis)).data ?? {};
  }

  async fehler(jobId: string, workerId: string, grund: string, abfragen = 0): Promise<void> {
    await this.call("POST", `${this.praefix}/register-jobs/${jobId}/fehler`, { workerId, grund, abfragen });
  }

  async status(): Promise<Record<string, unknown>> {
    return (await this.call<Record<string, unknown>>("GET", "/v1/register-jobs/status")).data ?? {};
  }
}

// Gateway-Routen /v1/register-jobs/* (services/db-gateway/src/routes/v1/register-jobs.ts).

import type { Bekanntmachung, Treffer } from "./parser";

export type JobArt = "front" | "bekanntmachungen" | "refresh";

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
  bundesland: string;
  name: string;
  sitz: string;
  status: Treffer["status"];
  historie: Array<{ name: string; sitz: string; order: number }>;
};

export type Ergebnis = {
  workerId: string;
  abfragen: number;
  gesperrt?: boolean;
  treffer: TrefferMeldung[];
  front?: { maxNummer: number; offeneLuecken: number[]; zusaetze?: string[] };
  bekanntmachungen?: Array<Omit<Bekanntmachung, "tagIso" | "kopf" | "geparst">>;
};

export type GatewayClientOptionen = {
  baseUrl: string;
  /** Liefert ein gueltiges Bearer-Token (Desktop: Keycloak-Session; Fallback: Dienstkonto). */
  token: () => Promise<string>;
  fetchImpl?: typeof fetch;
};

export class GatewayClient {
  private readonly f: typeof fetch;
  constructor(private readonly opt: GatewayClientOptionen) {
    this.f = opt.fetchImpl ?? fetch;
  }

  private async call<T>(method: "GET" | "POST", path: string, body?: unknown): Promise<{ status: number; data: T | null }> {
    const res = await this.f(`${this.opt.baseUrl.replace(/\/$/, "")}${path}`, {
      method,
      headers: { "content-type": "application/json", authorization: `Bearer ${await this.opt.token()}` },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    if (res.status === 204) return { status: 204, data: null };
    const text = await res.text();
    if (!res.ok) throw new Error(`gateway ${method} ${path} → ${res.status} ${text.slice(0, 200)}`);
    return { status: res.status, data: text ? (JSON.parse(text) as T) : null };
  }

  async lease(workerId: string, workerArt: "desktop" | "betreiber", arten?: JobArt[]): Promise<Job | null> {
    const r = await this.call<Job>("POST", "/v1/register-jobs/lease", { workerId, workerArt, arten });
    return r.data;
  }

  async ergebnis(jobId: string, ergebnis: Ergebnis): Promise<Record<string, unknown>> {
    return (await this.call<Record<string, unknown>>("POST", `/v1/register-jobs/${jobId}/ergebnis`, ergebnis)).data ?? {};
  }

  async fehler(jobId: string, workerId: string, grund: string, abfragen = 0): Promise<void> {
    await this.call("POST", `/v1/register-jobs/${jobId}/fehler`, { workerId, grund, abfragen });
  }

  async status(): Promise<Record<string, unknown>> {
    return (await this.call<Record<string, unknown>>("GET", "/v1/register-jobs/status")).data ?? {};
  }
}

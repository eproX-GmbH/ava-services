// Gateway-Zugriffe des Producers (Bearer PRODUCER_GATEWAY_TOKEN wie die anderen
// Producer). Gespeichert wird ueber die vorhandenen Routen
// services/db-gateway/src/routes/v1/email-patterns.ts — company-email braucht
// keinen eigenen Persist-Bus-Typ.
//
// Ein 401 wird mit "status 401" geloggt: Der ProducerSupervisor erkennt das,
// holt ein frisches Token und startet den Producer neu (Token lebt 15 Minuten).

import type { AbgeleiteteAdresse, KontakteAntwort, MusterSpeichern, ServerMuster, SpeicherErgebnis } from "@ava/email-muster";
import { logger } from "./log";

export interface StageStand {
  updatedAt: string | null;
}

export interface GatewayClient {
  holeKontakte(companyId: string): Promise<KontakteAntwort>;
  holeStand(companyId: string): Promise<Record<string, StageStand> | null>;
  holeMuster(domain: string): Promise<ServerMuster | null>;
  speichereMuster(domain: string, body: MusterSpeichern): Promise<void>;
  speichereAdresse(companyId: string, a: AbgeleiteteAdresse): Promise<SpeicherErgebnis>;
}

export class GatewayFehler extends Error {
  constructor(
    readonly status: number,
    readonly pfad: string,
    readonly text: string,
  ) {
    super(`gateway ${pfad}: status ${status}${text ? ` ${text.slice(0, 200)}` : ""}`);
  }
}

type Fetch = typeof fetch;

export function makeGatewayClient(opts: { url: string; token: string | null; fetch?: Fetch; timeoutMs?: number }): GatewayClient {
  const f = opts.fetch ?? fetch;
  const timeoutMs = opts.timeoutMs ?? 15_000;

  async function anfrage(pfad: string, init: { method?: string; body?: unknown } = {}): Promise<{ status: number; json: unknown; text: string }> {
    if (!opts.token) throw new Error("PRODUCER_GATEWAY_TOKEN fehlt (setzt der ProducerSupervisor)");
    const res = await f(`${opts.url}${pfad}`, {
      method: init.method ?? "GET",
      headers: { authorization: `Bearer ${opts.token}`, ...(init.body !== undefined ? { "content-type": "application/json" } : {}) },
      ...(init.body !== undefined ? { body: JSON.stringify(init.body) } : {}),
      signal: AbortSignal.timeout(timeoutMs),
    });
    const text = await res.text();
    let json: unknown = null;
    try {
      json = text ? JSON.parse(text) : null;
    } catch {
      json = null;
    }
    if (res.status === 401) {
      logger.error(`gateway ${pfad}: status 401 invalid_token — Producer wird mit frischem Token neu gestartet`);
      throw new GatewayFehler(401, pfad, text);
    }
    return { status: res.status, json, text };
  }

  async function lies<T>(pfad: string): Promise<T | null> {
    const r = await anfrage(pfad);
    if (r.status === 404) return null;
    if (r.status < 200 || r.status >= 300) throw new GatewayFehler(r.status, pfad, r.text);
    return r.json as T;
  }

  return {
    async holeKontakte(companyId) {
      return (await lies<KontakteAntwort>(`/v1/companies/${encodeURIComponent(companyId)}/contacts`)) ?? {};
    },
    async holeStand(companyId) {
      const r = await lies<{ stages?: Record<string, StageStand> }>(`/v1/companies/${encodeURIComponent(companyId)}/state`);
      return r?.stages ?? null;
    },
    async holeMuster(domain) {
      return lies<ServerMuster>(`/v1/email-patterns/${encodeURIComponent(domain)}`);
    },
    async speichereMuster(domain, body) {
      const pfad = `/v1/email-patterns/${encodeURIComponent(domain)}`;
      const r = await anfrage(pfad, { method: "PUT", body });
      if (r.status < 200 || r.status >= 300) throw new GatewayFehler(r.status, pfad, r.text);
    },
    async speichereAdresse(companyId, a) {
      const pfad = `/v1/companies/${encodeURIComponent(companyId)}/contacts/derived-email`;
      const r = await anfrage(pfad, { method: "POST", body: a });
      if (r.status >= 200 && r.status < 300) return "gespeichert";
      // 409: gefundene/verifizierte Adresse vorhanden — die bleibt.
      if (r.status === 409) return "vorhanden";
      // 400/404/422: Domain passt nicht zur Firma, Person nicht (mehr) in der Firma …
      if (r.status === 400 || r.status === 404 || r.status === 422) {
        logger.info(`${a.email}: vom Gateway abgewiesen (status ${r.status} ${r.text.slice(0, 120)})`);
        return "abgewiesen";
      }
      throw new GatewayFehler(r.status, pfad, r.text);
    },
  };
}

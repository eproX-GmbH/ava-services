// Kopf-Relais (docs/PLAN_AVA_CLOUD.md §11.2, Weg B): Der laufende AVA-Kopf des
// Nutzers (Desktop-App oder Server) verbindet sich AUSGEHEND per WebSocket mit
// dem Gateway und meldet seine Werkzeugliste an. Der MCP-Endpunkt (routes/mcp.ts)
// zeigt diese Werkzeuge zusätzlich zu den eigenen und reicht `tools/call` hierher
// durch. Der Gateway speichert nichts davon; er vermittelt nur.
//
// Verbindung: `GET /kopf-relais?access_token=<Keycloak-JWT>` mit Upgrade. Die
// Prüfung des Tokens läuft über die normale Auth-Middleware (app.request auf
// /v1/kopf-relais/wer), damit Aussteller, Audience und Scopes gelten wie überall.
// Ein Konto hat höchstens einen Kopf: Verbindet sich ein zweiter, wird der erste
// mit Code 4001 abgelöst (Desktop und Server sollen nicht gleichzeitig antworten).
//
// Nachrichten (JSON):
//   Kopf → Gateway:  { typ: "hallo", version, werkzeuge: [{ name, description, inputSchema }] }
//                    { typ: "ergebnis", id, text, isError? }
//   Gateway → Kopf:  { typ: "aufruf", id, name, args }
// Lebenszeichen über WebSocket-Ping alle 30 s; ohne Pong wird getrennt.

import type { IncomingMessage, Server } from "node:http";
import type { Duplex } from "node:stream";
import { randomUUID } from "node:crypto";
import { WebSocketServer, type WebSocket } from "ws";
import { logger } from "./logger";

export interface KopfWerkzeug {
  name: string;
  description: string;
  inputSchema: Record<string, unknown>;
}

interface KopfVerbindung {
  ws: WebSocket;
  actorId: string;
  tenantId: string;
  version: string;
  werkzeuge: KopfWerkzeug[];
  seit: number;
  lebt: boolean;
  offen: Map<string, { resolve: (v: { text: string; isError?: boolean }) => void; timer: NodeJS.Timeout }>;
}

export interface KopfIdentitaet {
  actorId: string;
  tenantId: string;
}

const MAX_WERKZEUGE = 400;
const MAX_NACHRICHT_BYTES = 2 * 1024 * 1024;
const PING_MS = 30_000;
export const AUFRUF_TIMEOUT_MS = 120_000;

export class KopfRelais {
  private readonly koepfe = new Map<string, KopfVerbindung>();
  private wss: WebSocketServer | null = null;
  private pingTimer: NodeJS.Timeout | null = null;

  constructor(private readonly pfad: string = "/kopf-relais") {}

  /** Hängt sich an den HTTP-Server; `pruefe` liefert die Identität zum Token oder null. */
  attach(server: Server, pruefe: (token: string) => Promise<KopfIdentitaet | null>): void {
    this.wss = new WebSocketServer({ noServer: true, maxPayload: MAX_NACHRICHT_BYTES });
    server.on("upgrade", (req: IncomingMessage, socket: Duplex, head: Buffer) => {
      const url = new URL(req.url ?? "/", "http://ava.local");
      if (url.pathname !== this.pfad) return; // andere Upgrades gehen uns nichts an
      const token = url.searchParams.get("access_token") ?? "";
      void pruefe(token)
        .then((wer) => {
          if (!wer) {
            socket.write("HTTP/1.1 401 Unauthorized\r\nConnection: close\r\n\r\n");
            socket.destroy();
            return;
          }
          this.wss!.handleUpgrade(req, socket, head, (ws) => this.annehmen(ws, wer));
        })
        .catch((err) => {
          logger.warn({ err: err instanceof Error ? err.message : String(err) }, "[kopf-relais] Pruefung fehlgeschlagen");
          socket.destroy();
        });
    });
    this.pingTimer = setInterval(() => {
      for (const k of this.koepfe.values()) {
        if (!k.lebt) {
          logger.info({ actorId: k.actorId }, "[kopf-relais] kein Pong, trenne");
          k.ws.terminate();
          continue;
        }
        k.lebt = false;
        try {
          k.ws.ping();
        } catch {
          /* beim nächsten Durchlauf weg */
        }
      }
    }, PING_MS);
    this.pingTimer.unref();
  }

  private annehmen(ws: WebSocket, wer: KopfIdentitaet): void {
    const alt = this.koepfe.get(wer.actorId);
    if (alt) {
      logger.info({ actorId: wer.actorId }, "[kopf-relais] zweiter Kopf, alter wird abgeloest");
      try {
        alt.ws.close(4001, "Ein anderer AVA-Kopf hat sich verbunden");
      } catch {
        /* egal */
      }
      this.aufraeumen(alt, "abgeloest");
    }
    const k: KopfVerbindung = { ws, actorId: wer.actorId, tenantId: wer.tenantId, version: "?", werkzeuge: [], seit: Date.now(), lebt: true, offen: new Map() };
    this.koepfe.set(wer.actorId, k);
    ws.on("pong", () => {
      k.lebt = true;
    });
    ws.on("message", (daten) => this.nachricht(k, daten.toString()));
    ws.on("close", () => this.aufraeumen(k, "geschlossen"));
    ws.on("error", (err) => logger.warn({ actorId: k.actorId, err: err.message }, "[kopf-relais] Fehler"));
    logger.info({ actorId: k.actorId }, "[kopf-relais] Kopf verbunden");
  }

  private nachricht(k: KopfVerbindung, roh: string): void {
    let n: { typ?: string; id?: string; text?: string; isError?: boolean; version?: string; werkzeuge?: unknown };
    try {
      n = JSON.parse(roh);
    } catch {
      return;
    }
    if (n.typ === "hallo") {
      const liste = Array.isArray(n.werkzeuge) ? n.werkzeuge : [];
      k.werkzeuge = liste
        .filter((w): w is KopfWerkzeug => !!w && typeof w === "object" && typeof (w as KopfWerkzeug).name === "string" && typeof (w as KopfWerkzeug).description === "string")
        .slice(0, MAX_WERKZEUGE)
        .map((w) => ({ name: w.name.slice(0, 80), description: w.description.slice(0, 4000), inputSchema: (w.inputSchema && typeof w.inputSchema === "object" ? w.inputSchema : { type: "object" }) as Record<string, unknown> }));
      k.version = typeof n.version === "string" ? n.version.slice(0, 40) : "?";
      logger.info({ actorId: k.actorId, version: k.version, werkzeuge: k.werkzeuge.length }, "[kopf-relais] Werkzeugliste");
      return;
    }
    if (n.typ === "ergebnis" && typeof n.id === "string") {
      const warte = k.offen.get(n.id);
      if (!warte) return;
      k.offen.delete(n.id);
      clearTimeout(warte.timer);
      warte.resolve({ text: typeof n.text === "string" ? n.text : "", ...(n.isError ? { isError: true } : {}) });
    }
  }

  private aufraeumen(k: KopfVerbindung, grund: string): void {
    if (this.koepfe.get(k.actorId) === k) this.koepfe.delete(k.actorId);
    for (const [id, warte] of k.offen) {
      clearTimeout(warte.timer);
      warte.resolve({ text: `Die Verbindung zur AVA des Nutzers ist abgebrochen (${grund}).`, isError: true });
      k.offen.delete(id);
    }
    logger.info({ actorId: k.actorId, grund }, "[kopf-relais] Kopf getrennt");
  }

  verbunden(actorId: string): boolean {
    return this.koepfe.has(actorId);
  }

  werkzeugeFuer(actorId: string): KopfWerkzeug[] {
    return this.koepfe.get(actorId)?.werkzeuge ?? [];
  }

  stand(actorId: string): { verbunden: boolean; version?: string; werkzeuge?: number; seit?: string } {
    const k = this.koepfe.get(actorId);
    return k ? { verbunden: true, version: k.version, werkzeuge: k.werkzeuge.length, seit: new Date(k.seit).toISOString() } : { verbunden: false };
  }

  aufrufen(actorId: string, name: string, args: Record<string, unknown>, timeoutMs = AUFRUF_TIMEOUT_MS): Promise<{ text: string; isError?: boolean }> {
    const k = this.koepfe.get(actorId);
    if (!k) return Promise.resolve({ text: "Die AVA des Nutzers ist gerade nicht verbunden (Desktop-App oder Server laeuft nicht).", isError: true });
    const id = randomUUID();
    return new Promise((resolve) => {
      const timer = setTimeout(() => {
        k.offen.delete(id);
        resolve({ text: `Die AVA des Nutzers hat nicht innerhalb von ${Math.round(timeoutMs / 1000)} s geantwortet.`, isError: true });
      }, timeoutMs);
      k.offen.set(id, { resolve, timer });
      try {
        k.ws.send(JSON.stringify({ typ: "aufruf", id, name, args }));
      } catch (err) {
        clearTimeout(timer);
        k.offen.delete(id);
        resolve({ text: `Senden an die AVA des Nutzers fehlgeschlagen: ${err instanceof Error ? err.message : String(err)}`, isError: true });
      }
    });
  }
}

export const kopfRelais = new KopfRelais();

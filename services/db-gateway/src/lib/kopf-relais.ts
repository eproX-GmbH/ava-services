// Kopf-Relais (docs/PLAN_AVA_CLOUD.md §11.2 und §13): Die laufenden AVAs des
// Nutzers (Desktop-App, Server) verbinden sich AUSGEHEND per WebSocket mit dem
// Gateway. Jede meldet ihre Instanz (feste ID, Art, Name), einen Zustandsbericht
// und ihre Werkzeugliste. Der MCP-Endpunkt (routes/mcp.ts) reicht `tools/call`
// an eine Instanz durch; Instanzen können sich über das Relais gegenseitig
// Nachrichten schicken (Umzug, §13.3). Der Gateway speichert nichts davon; er
// vermittelt nur und hält die Liste im Speicher.
//
// Verbindung: `GET /kopf-relais?access_token=<Keycloak-JWT>` mit Upgrade; die
// Prüfung läuft über die normale Auth-Middleware (/v1/kopf-relais/wer).
// Mehrere Instanzen je Konto sind erlaubt; dieselbe Instanz-ID ersetzt ihre
// alte Verbindung (Wiederverbinden).
//
// Nachrichten (JSON):
//   Kopf → Gateway:  { typ: "hallo", version, instanz: { id, art, name, flyApp? }, werkzeuge, zustand }
//                    { typ: "zustand", zustand }
//                    { typ: "ergebnis", id, text, isError? }
//                    { typ: "an", ziel: <instanzId>, nachricht }
//   Gateway → Kopf:  { typ: "aufruf", id, name, args }
//                    { typ: "von", von: <instanzId>, nachricht }
//                    { typ: "instanzen", liste }      (nach jeder Änderung)

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

export type InstanzArt = "desktop" | "server";

/** Erste AVA-Version mit App-Kanal (docs/PLAN_APP_PWA.md). */
const APP_KANAL_AB = "0.1.801";

/** "0.1.801" ≥ "0.1.800"; unbekannte Versionen gelten als neu genug. */
function versionMindestens(v: string, min: string): boolean {
  const a = v.replace(/^v/, "").split(".").map((x) => Number.parseInt(x, 10));
  const b = min.split(".").map((x) => Number.parseInt(x, 10));
  if (a.some((x) => Number.isNaN(x))) return true;
  for (let i = 0; i < 3; i++) {
    if ((a[i] ?? 0) !== (b[i] ?? 0)) return (a[i] ?? 0) > (b[i] ?? 0);
  }
  return true;
}

export interface InstanzInfo {
  id: string;
  art: InstanzArt;
  name: string;
  version: string;
  verbunden: boolean;
  seit: string;
  zuletzt: string;
  /** Diese Instanz beantwortet gerade die MCP-Aufrufe. */
  mcpZiel: boolean;
  /** Vom Kopf gemeldeter Zustand (Telegram, Radar, Modell, …); frei strukturiert. */
  zustand: Record<string, unknown>;
  /** Server: gemeldete Fly-App (FLY_APP_NAME), ungeprüft; siehe lib/instanz-update.ts. */
  flyApp: string | null;
}

interface KopfVerbindung {
  ws: WebSocket;
  actorId: string;
  tenantId: string;
  instanzId: string;
  art: InstanzArt;
  name: string;
  version: string;
  flyApp: string | null;
  werkzeuge: KopfWerkzeug[];
  zustand: Record<string, unknown>;
  seit: number;
  zuletzt: number;
  lebt: boolean;
  offen: Map<string, { resolve: (v: { text: string; isError?: boolean }) => void; timer: NodeJS.Timeout }>;
}

export interface KopfIdentitaet {
  actorId: string;
  tenantId: string;
}

const MAX_WERKZEUGE = 400;
const MAX_NACHRICHT_BYTES = 6 * 1024 * 1024;
const MAX_ZUSTAND_BYTES = 16 * 1024;
const PING_MS = 30_000;
const VERGANGENE_MS = 7 * 24 * 60 * 60 * 1000;
export const AUFRUF_TIMEOUT_MS = 120_000;

function prioritaet(k: KopfVerbindung): number {
  if (k.zustand.mcp === false) return -1;
  return k.art === "server" ? 2 : 1;
}

export class KopfRelais {
  /** actorId → instanzId → Verbindung */
  private readonly koepfe = new Map<string, Map<string, KopfVerbindung>>();
  /** Zuletzt gesehene, getrennte Instanzen (nur Anzeige, im Speicher). */
  private readonly vergangen = new Map<string, Map<string, InstanzInfo>>();
  private wss: WebSocketServer | null = null;
  private pingTimer: NodeJS.Timeout | null = null;

  constructor(private readonly pfad: string = "/kopf-relais") {}

  attach(server: Server, pruefe: (token: string) => Promise<KopfIdentitaet | null>): void {
    this.wss = new WebSocketServer({ noServer: true, maxPayload: MAX_NACHRICHT_BYTES });
    server.on("upgrade", (req: IncomingMessage, socket: Duplex, head: Buffer) => {
      const url = new URL(req.url ?? "/", "http://ava.local");
      if (url.pathname !== this.pfad) return;
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
      for (const je of this.koepfe.values()) {
        for (const k of je.values()) {
          if (!k.lebt) {
            logger.info({ actorId: k.actorId, instanz: k.instanzId }, "[kopf-relais] kein Pong, trenne");
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
      }
    }, PING_MS);
    this.pingTimer.unref();
  }

  private annehmen(ws: WebSocket, wer: KopfIdentitaet): void {
    // Bis zum „hallo“ ist die Instanz unbekannt; vorläufige ID, damit Ping und Close greifen.
    const k: KopfVerbindung = {
      ws,
      actorId: wer.actorId,
      tenantId: wer.tenantId,
      instanzId: `unbekannt-${randomUUID()}`,
      art: "desktop",
      name: "AVA",
      version: "?",
      flyApp: null,
      werkzeuge: [],
      zustand: {},
      seit: Date.now(),
      zuletzt: Date.now(),
      lebt: true,
      offen: new Map(),
    };
    this.eintragen(k);
    ws.on("pong", () => {
      k.lebt = true;
    });
    ws.on("message", (daten) => this.nachricht(k, daten.toString()));
    ws.on("close", () => this.aufraeumen(k, "geschlossen"));
    ws.on("error", (err) => logger.warn({ actorId: k.actorId, err: err.message }, "[kopf-relais] Fehler"));
  }

  private je(actorId: string): Map<string, KopfVerbindung> {
    let m = this.koepfe.get(actorId);
    if (!m) {
      m = new Map();
      this.koepfe.set(actorId, m);
    }
    return m;
  }

  private eintragen(k: KopfVerbindung): void {
    this.je(k.actorId).set(k.instanzId, k);
  }

  private nachricht(k: KopfVerbindung, roh: string): void {
    let n: { typ?: string; id?: string; text?: string; isError?: boolean; version?: string; werkzeuge?: unknown; zustand?: unknown; instanz?: { id?: unknown; art?: unknown; name?: unknown; flyApp?: unknown }; ziel?: unknown; nachricht?: unknown };
    try {
      n = JSON.parse(roh);
    } catch {
      return;
    }
    k.zuletzt = Date.now();
    if (n.typ === "hallo") {
      const id = typeof n.instanz?.id === "string" && n.instanz.id.length >= 8 ? n.instanz.id.slice(0, 64) : null;
      if (id && id !== k.instanzId) {
        const m = this.je(k.actorId);
        m.delete(k.instanzId);
        const alt = m.get(id);
        if (alt && alt !== k) {
          try {
            alt.ws.close(4003, "Dieselbe Instanz hat sich neu verbunden");
          } catch {
            /* egal */
          }
          this.aufraeumen(alt, "ersetzt", false);
        }
        k.instanzId = id;
        m.set(id, k);
        this.vergangen.get(k.actorId)?.delete(id);
      }
      k.art = n.instanz?.art === "server" ? "server" : "desktop";
      k.name = typeof n.instanz?.name === "string" && n.instanz.name.trim() ? n.instanz.name.trim().slice(0, 80) : k.art === "server" ? "Server" : "Desktop";
      const liste = Array.isArray(n.werkzeuge) ? n.werkzeuge : [];
      k.werkzeuge = liste
        .filter((w): w is KopfWerkzeug => !!w && typeof w === "object" && typeof (w as KopfWerkzeug).name === "string" && typeof (w as KopfWerkzeug).description === "string")
        .slice(0, MAX_WERKZEUGE)
        .map((w) => ({ name: w.name.slice(0, 80), description: w.description.slice(0, 4000), inputSchema: (w.inputSchema && typeof w.inputSchema === "object" ? w.inputSchema : { type: "object" }) as Record<string, unknown> }));
      k.version = typeof n.version === "string" ? n.version.slice(0, 40) : "?";
      k.flyApp = k.art === "server" && typeof n.instanz?.flyApp === "string" ? n.instanz.flyApp.trim().toLowerCase().slice(0, 63) || null : null;
      this.zustandSetzen(k, n.zustand);
      logger.info({ actorId: k.actorId, instanz: k.instanzId, art: k.art, version: k.version, werkzeuge: k.werkzeuge.length }, "[kopf-relais] Instanz verbunden");
      this.verteileListe(k.actorId);
      return;
    }
    // App-Kanal (docs/PLAN_APP_PWA.md §3.2): gestreamte Frames an die Apps des Nutzers.
    if (n.typ === "app-frame") {
      const frame = (n as { frame?: unknown }).frame;
      if (frame && typeof frame === "object") this.appFrameHandler?.(k.actorId, k.instanzId, frame);
      return;
    }
    if (n.typ === "zustand") {
      this.zustandSetzen(k, n.zustand);
      this.verteileListe(k.actorId);
      return;
    }
    if (n.typ === "ergebnis" && typeof n.id === "string") {
      const warte = k.offen.get(n.id);
      if (!warte) return;
      k.offen.delete(n.id);
      clearTimeout(warte.timer);
      warte.resolve({ text: typeof n.text === "string" ? n.text : "", ...(n.isError ? { isError: true } : {}) });
      return;
    }
    if (n.typ === "an" && typeof n.ziel === "string") {
      const ziel = this.koepfe.get(k.actorId)?.get(n.ziel);
      if (!ziel) {
        this.senden(k, { typ: "von", von: "gateway", nachricht: { art: "fehler", grund: "ziel_nicht_verbunden", ziel: n.ziel, bezug: n.nachricht && typeof n.nachricht === "object" ? (n.nachricht as { umzugId?: unknown }).umzugId ?? null : null } });
        return;
      }
      this.senden(ziel, { typ: "von", von: k.instanzId, nachricht: n.nachricht });
    }
  }

  private zustandSetzen(k: KopfVerbindung, z: unknown): void {
    if (!z || typeof z !== "object") return;
    const s = JSON.stringify(z);
    if (s.length > MAX_ZUSTAND_BYTES) return;
    k.zustand = JSON.parse(s) as Record<string, unknown>;
  }

  private senden(k: KopfVerbindung, n: unknown): void {
    try {
      k.ws.send(JSON.stringify(n));
    } catch (err) {
      logger.warn({ actorId: k.actorId, instanz: k.instanzId, err: err instanceof Error ? err.message : String(err) }, "[kopf-relais] Senden fehlgeschlagen");
    }
  }

  private aufraeumen(k: KopfVerbindung, grund: string, merken = true): void {
    const m = this.koepfe.get(k.actorId);
    if (m?.get(k.instanzId) === k) m.delete(k.instanzId);
    if (m && m.size === 0) this.koepfe.delete(k.actorId);
    for (const [id, warte] of k.offen) {
      clearTimeout(warte.timer);
      warte.resolve({ text: `Die Verbindung zur AVA des Nutzers ist abgebrochen (${grund}).`, isError: true });
      k.offen.delete(id);
    }
    if (merken && !k.instanzId.startsWith("unbekannt-")) {
      let v = this.vergangen.get(k.actorId);
      if (!v) {
        v = new Map();
        this.vergangen.set(k.actorId, v);
      }
      v.set(k.instanzId, { ...this.info(k, null), verbunden: false, mcpZiel: false });
      for (const [id, i] of v) if (Date.parse(i.zuletzt) < Date.now() - VERGANGENE_MS) v.delete(id);
    }
    logger.info({ actorId: k.actorId, instanz: k.instanzId, grund }, "[kopf-relais] Instanz getrennt");
    this.verteileListe(k.actorId);
  }

  private info(k: KopfVerbindung, ziel: KopfVerbindung | null): InstanzInfo {
    return {
      id: k.instanzId,
      art: k.art,
      name: k.name,
      version: k.version,
      verbunden: true,
      seit: new Date(k.seit).toISOString(),
      zuletzt: new Date(k.zuletzt).toISOString(),
      mcpZiel: ziel === k,
      zustand: k.zustand,
      flyApp: k.flyApp,
    };
  }

  /** Die Instanz, die MCP-Aufrufe beantwortet: Server vor Desktop, MCP nicht abgeschaltet, dann die älteste Verbindung. */
  private mcpKopf(actorId: string): KopfVerbindung | null {
    const m = this.koepfe.get(actorId);
    if (!m) return null;
    let best: KopfVerbindung | null = null;
    for (const k of m.values()) {
      if (k.instanzId.startsWith("unbekannt-") || prioritaet(k) < 0) continue;
      if (!best || prioritaet(k) > prioritaet(best) || (prioritaet(k) === prioritaet(best) && k.seit < best.seit)) best = k;
    }
    return best;
  }

  /** Allen Instanzen des Kontos die aktuelle Liste schicken (für ihre Anzeige und den Umzug). */
  private verteileListe(actorId: string): void {
    const liste = this.instanzen(actorId);
    for (const k of this.koepfe.get(actorId)?.values() ?? []) this.senden(k, { typ: "instanzen", liste });
  }

  instanzen(actorId: string): InstanzInfo[] {
    const ziel = this.mcpKopf(actorId);
    const live = [...(this.koepfe.get(actorId)?.values() ?? [])].filter((k) => !k.instanzId.startsWith("unbekannt-")).map((k) => this.info(k, ziel));
    const ids = new Set(live.map((i) => i.id));
    const alt = [...(this.vergangen.get(actorId)?.values() ?? [])].filter((i) => !ids.has(i.id));
    return [...live, ...alt].sort((a, b) => (a.verbunden === b.verbunden ? a.art.localeCompare(b.art) : a.verbunden ? -1 : 1));
  }

  verbunden(actorId: string): boolean {
    return this.mcpKopf(actorId) !== null;
  }

  werkzeugeFuer(actorId: string): KopfWerkzeug[] {
    return this.mcpKopf(actorId)?.werkzeuge ?? [];
  }

  stand(actorId: string): { verbunden: boolean; instanz?: string; version?: string; werkzeuge?: number } {
    const k = this.mcpKopf(actorId);
    return k ? { verbunden: true, instanz: k.name, version: k.version, werkzeuge: k.werkzeuge.length } : { verbunden: false };
  }

  private appFrameHandler: ((actorId: string, instanzId: string, frame: unknown) => void) | null = null;

  /** Empfaenger fuer App-Frames (lib/app-strom.ts). */
  onAppFrame(cb: (actorId: string, instanzId: string, frame: unknown) => void): void {
    this.appFrameHandler = cb;
  }

  /**
   * Instanz fuer die App (E4): die gewuenschte, wenn verbunden; sonst Server vor
   * Desktop, dann die aelteste Verbindung. Der MCP-Schalter gilt hier nicht.
   */
  private appKopf(actorId: string, instanzId?: string | null): KopfVerbindung | null {
    const m = this.koepfe.get(actorId);
    if (!m) return null;
    if (instanzId) {
      const k = m.get(instanzId);
      if (k) return k;
    }
    // Vorrang: AVA mit App-Kanal, dann Server vor Desktop, dann die länger verbundene.
    // Ein zu alter Server soll eine aktuelle Desktop-AVA nicht verdecken.
    const rang = (k: KopfVerbindung) => (versionMindestens(k.version, APP_KANAL_AB) ? 10 : 0) + (k.art === "server" ? 2 : 1);
    let best: KopfVerbindung | null = null;
    for (const k of m.values()) {
      if (k.instanzId.startsWith("unbekannt-")) continue;
      if (!best || rang(k) > rang(best) || (rang(k) === rang(best) && k.seit < best.seit)) best = k;
    }
    return best;
  }

  /** Anfrage der App an die AVA des Nutzers (typ "app"); null = keine AVA verbunden. */
  appAnfrage(
    actorId: string,
    art: string,
    daten: Record<string, unknown>,
    opts: { instanzId?: string | null; timeoutMs?: number } = {},
  ): Promise<{ instanz: { id: string; name: string; art: InstanzArt }; text: string; isError?: boolean } | null> {
    const k = this.appKopf(actorId, opts.instanzId);
    if (!k) return Promise.resolve(null);
    const instanz = { id: k.instanzId, name: k.name, art: k.art };
    // AVA-Versionen vor dem App-Kanal antworten auf "app" nicht: sofort sagen, statt zu warten.
    if (!versionMindestens(k.version, APP_KANAL_AB)) {
      return Promise.resolve({ instanz, text: JSON.stringify({ code: "nicht_verfuegbar", message: `Deine AVA (${k.name}, v${k.version}) ist zu alt für die App. Bitte auf v${APP_KANAL_AB} oder neuer aktualisieren.` }), isError: true });
    }
    const timeoutMs = opts.timeoutMs ?? 20_000;
    const id = randomUUID();
    return new Promise((resolve) => {
      const timer = setTimeout(() => {
        k.offen.delete(id);
        resolve({ instanz, text: JSON.stringify({ code: "zeitueberschreitung", message: `Deine AVA hat nicht innerhalb von ${Math.round(timeoutMs / 1000)} s geantwortet.` }), isError: true });
      }, timeoutMs);
      k.offen.set(id, { resolve: (r) => resolve({ instanz, ...r }), timer });
      try {
        k.ws.send(JSON.stringify({ typ: "app", id, art, daten }));
      } catch (err) {
        clearTimeout(timer);
        k.offen.delete(id);
        resolve({ instanz, text: JSON.stringify({ code: "senden", message: err instanceof Error ? err.message : String(err) }), isError: true });
      }
    });
  }

  aufrufen(actorId: string, name: string, args: Record<string, unknown>, timeoutMs = AUFRUF_TIMEOUT_MS): Promise<{ text: string; isError?: boolean }> {
    const k = this.mcpKopf(actorId);
    if (!k) return Promise.resolve({ text: "Keine AVA des Nutzers ist gerade verbunden (Desktop-App oder Server laeuft nicht, oder MCP ist dort abgeschaltet).", isError: true });
    return this.aufrufBei(k, name, args, timeoutMs);
  }

  /**
   * Dasselbe Werkzeug bei allen verbundenen AVAs des Nutzers (ava_kontext: Profil und
   * Gedaechtnis liegen je Instanz, z. B. nur in der Desktop-App, nicht im Server).
   */
  async aufrufenAlle(
    actorId: string,
    name: string,
    args: Record<string, unknown>,
    timeoutMs = AUFRUF_TIMEOUT_MS,
  ): Promise<Array<{ instanz: string; art: InstanzArt; mcpZiel: boolean; text: string; isError?: boolean }>> {
    const ziel = this.mcpKopf(actorId);
    const koepfe = [...(this.koepfe.get(actorId)?.values() ?? [])].filter((k) => !k.instanzId.startsWith("unbekannt-"));
    return Promise.all(koepfe.map(async (k) => ({ instanz: k.name, art: k.art, mcpZiel: k === ziel, ...(await this.aufrufBei(k, name, args, timeoutMs)) })));
  }

  private aufrufBei(k: KopfVerbindung, name: string, args: Record<string, unknown>, timeoutMs: number): Promise<{ text: string; isError?: boolean }> {
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

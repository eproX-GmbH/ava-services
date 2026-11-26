// Staging/UAT (docs/PLAN_STAGING.md ST3): Konto-Weiche im Prod-Gateway und Wächter im
// Staging-Gateway.
//
// Prod: Jede angemeldete Anfrage eines Kontos im Kanal staging geht unverändert und gestreamt an
// das Staging-Gateway (STAGING_GATEWAY_URL, privates Fly-Netz), ebenso seine Relais-WebSockets.
// So landen App, Desktop, Kunden-Server und Claude/ChatGPT eines Kontos immer beim selben
// Gateway-Prozess (das Relais lebt im Speicher). Fly-Replay reicht nicht: nur bis 1 MB.
//
// Staging: Angemeldete Anfragen von Konten außerhalb von Staging werden abgewiesen.
import http from "node:http";
import type { IncomingMessage } from "node:http";
import type { Duplex } from "node:stream";
import type { MiddlewareHandler } from "hono";
import type pg from "pg";
import { gatewayRolle, kanalVon, routingAktiv, testkontoSicherstellen, zugangNachladen, zugangVon } from "./kanal";
import { tokenKonto } from "../middleware/auth";
import { logger } from "./logger";
import { getGatewayPool } from "./producer-pools";
import { URSPRUNGS_HOST, WEITERGELEITET } from "./anfrage-host";

const ziel = () => process.env.STAGING_GATEWAY_URL?.trim().replace(/\/+$/, "") || null;
export { WEITERGELEITET };

/**
 * Wege, die nie weitergeleitet werden (Webhooks, interne Kanäle, Gesundheit, Relais-Prüfung).
 * Die Steuerung von Staging selbst (Schalter, Konten, Freigabe) bleibt immer beim Prod-Gateway,
 * auch wenn der Betreiber selbst im Staging ist: Der Notschalter muss gehen, wenn Staging klemmt.
 */
const NIE = [/^\/health/, /^\/internal\//, /^\/v1\/billing\/webhook/, /^\/v1\/kopf-relais\/wer$/, /^\/webhooks?\//, /^\/v1\/betreiber\/(staging|releases)(\/|$)/];

function tokenAus(req: Request): string | null {
  const h = req.headers.get("authorization");
  if (h?.startsWith("Bearer ")) return h.slice(7).trim() || null;
  return new URL(req.url).searchParams.get("access_token");
}

const HOP = ["connection", "keep-alive", "transfer-encoding", "upgrade", "proxy-connection", "te", "trailer", "host", "content-length"];

/** HTTP an das Staging-Gateway durchreichen (Anfrage- und Antwortkörper gestreamt). */
export async function weiterleiten(req: Request, basis: string): Promise<Response> {
  const u = new URL(req.url);
  const headers = new Headers(req.headers);
  // Der Host geht beim Weiterreichen verloren; Staging braucht ihn (mcp.ava.bi, anfrage-host.ts).
  const host = req.headers.get("host");
  for (const h of HOP) headers.delete(h);
  headers.set(WEITERGELEITET, "1");
  if (host) headers.set(URSPRUNGS_HOST, host);
  const mitKoerper = !["GET", "HEAD"].includes(req.method);
  let res: Response;
  try {
    res = await fetch(`${basis}${u.pathname}${u.search}`, {
      method: req.method,
      headers,
      body: mitKoerper ? req.body : undefined,
      redirect: "manual",
      ...(mitKoerper ? { duplex: "half" } : {}),
    } as RequestInit);
  } catch (err) {
    logger.warn({ pfad: u.pathname, err: err instanceof Error ? err.message : String(err) }, "[staging-weiche] Staging-Gateway nicht erreichbar");
    return new Response(JSON.stringify({ error: "staging_nicht_erreichbar", message: "Die Staging-Umgebung ist gerade nicht erreichbar. Bitte später erneut versuchen oder das Konto in der Konsole aus Staging nehmen." }), { status: 503, headers: { "content-type": "application/json" } });
  }
  // fetch entpackt gzip/br selbst: Länge und Kodierung passen dann nicht mehr.
  const aus = new Headers(res.headers);
  for (const h of ["content-encoding", "content-length", "transfer-encoding", "connection", "keep-alive"]) aus.delete(h);
  aus.set("x-ava-gateway", "staging");
  return new Response(res.body, { status: res.status, statusText: res.statusText, headers: aus });
}

/** Datenbank für das Eintragen von Test-Adressen (Tests ersetzen sie). */
let db: () => Pick<pg.Pool, "query"> = () => getGatewayPool();
export function weicheDbSetzen(f: () => Pick<pg.Pool, "query">): void { db = f; }

/**
 * Staging-Konto? Test-Adressen zählen schon bei der ersten Anfrage (vor /v1/whoami). Der Wächter
 * im Staging-Gateway prüft unabhängig von der Weiche (die schaltet Prod) und sieht bei Lücken
 * im Stand direkt nach; Prod nicht, sonst fragte jede Anfrage jedes Kunden die Datenbank.
 */
async function imStaging(k: { sub: string; email: string | null }, waechter = false): Promise<boolean> {
  if (waechter ? zugangVon(k.sub)?.kanal === "staging" : kanalVon(k.sub) === "staging") return true;
  try {
    if (await testkontoSicherstellen(db(), { actorId: k.sub, email: k.email })) return true;
    return waechter ? await zugangNachladen(db(), k.sub) : false;
  } catch (err) {
    logger.warn({ actorId: k.sub, err: err instanceof Error ? err.message : String(err) }, "[staging-weiche] Test-Adresse nicht eingetragen");
    return false;
  }
}

/** Prod: Middleware ganz vorn. */
export const stagingWeiche: MiddlewareHandler = async (c, next) => {
  const basis = ziel();
  if (gatewayRolle() !== "prod" || !basis || !routingAktiv()) return next();
  if (c.req.header(WEITERGELEITET)) return next();
  const pfad = new URL(c.req.url).pathname;
  if (NIE.some((r) => r.test(pfad))) return next();
  const token = tokenAus(c.req.raw);
  if (!token) return next();
  const konto = await tokenKonto(token);
  if (!konto || !(await imStaging(konto))) return next();
  return weiterleiten(c.req.raw, basis);
};

/** Staging: Konten außerhalb von Staging abweisen (öffentliche Wege ohne Token bleiben offen). */
export const stagingWaechter: MiddlewareHandler = async (c, next) => {
  if (gatewayRolle() !== "staging") return next();
  const pfad = new URL(c.req.url).pathname;
  if (NIE.some((r) => r.test(pfad))) return next();
  const token = tokenAus(c.req.raw);
  if (!token) return next();
  const konto = await tokenKonto(token);
  if (!konto) return next(); // ungültig: die Anmeldung antwortet mit 401
  if (await imStaging(konto, true)) return next();
  return c.json({ error: "kein_staging_zugang", message: "Dieses Konto hat keinen Zugang zur Staging-Umgebung." }, 403);
};

/** Relais-WebSocket eines Staging-Kontos durchreichen; true = übernommen. */
export function relaisWeiche(req: IncomingMessage, socket: Duplex, head: Buffer, wer: { actorId: string }): boolean {
  const basis = ziel();
  if (gatewayRolle() !== "prod" || !basis || !routingAktiv() || req.headers[WEITERGELEITET]) return false;
  if (kanalVon(wer.actorId) !== "staging") return false;
  const z = new URL(req.url ?? "/", basis);
  const headers = { ...req.headers, host: z.host, [WEITERGELEITET]: "1", ...(req.headers.host ? { [URSPRUNGS_HOST]: req.headers.host } : {}) };
  const anfrage = http.request({ hostname: z.hostname.replace(/^\[|\]$/g, ""), port: z.port || 80, path: z.pathname + z.search, method: req.method, headers });
  anfrage.on("upgrade", (res, gegenSocket, gegenKopf) => {
    let kopf = `HTTP/1.1 ${res.statusCode} ${res.statusMessage}\r\n`;
    for (let i = 0; i < res.rawHeaders.length; i += 2) kopf += `${res.rawHeaders[i]}: ${res.rawHeaders[i + 1]}\r\n`;
    socket.write(`${kopf}\r\n`);
    if (gegenKopf.length) socket.write(gegenKopf);
    if (head.length) gegenSocket.write(head);
    gegenSocket.pipe(socket);
    socket.pipe(gegenSocket);
    const zu = () => { socket.destroy(); gegenSocket.destroy(); };
    gegenSocket.on("error", zu); socket.on("error", zu);
    gegenSocket.on("close", zu); socket.on("close", zu);
  });
  anfrage.on("response", (res) => {
    socket.write(`HTTP/1.1 ${res.statusCode} ${res.statusMessage}\r\nConnection: close\r\n\r\n`);
    socket.destroy();
  });
  anfrage.on("error", (err) => {
    logger.warn({ actorId: wer.actorId, err: err.message }, "[staging-weiche] Relais: Staging-Gateway nicht erreichbar");
    socket.write("HTTP/1.1 503 Service Unavailable\r\nConnection: close\r\n\r\n");
    socket.destroy();
  });
  anfrage.end();
  return true;
}

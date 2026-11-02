// docs/PLAN_PROBLEM_MELDEN.md M2 — Snapshot des Geraets fuer eine Problemmeldung:
// Versionen, Modell, Plan, Protokolle (Hauptprozess, Producer), Hintergrund-
// aufgaben, letzte Vorgaenge, optional Chat-Auszug und Bildschirmfoto. Alles als
// ZIP, Geheimnisse (Schluessel, Tokens, Passwoerter) werden vorher maskiert.
import { existsSync, readFileSync, statSync, openSync, readSync, closeSync } from "node:fs";
import { join } from "node:path";
import * as os from "node:os";
import AdmZip from "adm-zip";
import { paths } from "../../core/platform";
import { getLogDir, getMainLogPath } from "../file-logger";
import { producerLogBuffer } from "../producer-log-buffer";

export interface SnapshotDeps {
  gateway: { request<T>(path: string, init?: { signal?: AbortSignal; query?: Record<string, string | number> }): Promise<T> };
  authStatus: () => { signedIn: boolean; actorId: string | null; tenantId: string | null; email?: string | null; name?: string | null };
  providerConfig: () => unknown;
  ollamaStatus: () => unknown;
  aufgaben: () => unknown[];
  gatewayUrl: string;
  /** Lokale Einstellungen ohne Geheimnisse (frei definierbar). */
  einstellungen?: () => Record<string, unknown>;
  /** Bildschirmfoto des AVA-Fensters (PNG); setzt der Hauptprozess, weil Electron nicht in src/core gehoert. */
  bildschirmfoto?: () => Promise<Buffer | null>;
}

export interface SnapshotOptionen {
  chatAuszug?: Array<{ rolle: string; text: string; werkzeug?: string | null; zeit?: string | null }> | null;
  bildschirmfoto?: boolean;
  conversationId?: string | null;
}

export interface SnapshotErgebnis {
  zip: Buffer;
  dateiname: string;
  inhalt: Array<{ datei: string; groesse: number }>;
  appVersion: string;
  plattform: string;
}

const LOG_TAIL_BYTES = 2 * 1024 * 1024;
const PRODUCER_ZEILEN = 2000;

/** Geheimnisse maskieren: API-Schluessel, Bearer-Tokens, JWTs, Passwoerter in URLs/JSON. */
export function maskieren(text: string): string {
  return text
    .replace(/\b(sk-[A-Za-z0-9_-]{8,})/g, "sk-***")
    .replace(/\b(apify_api_[A-Za-z0-9]{6,})/g, "apify_api_***")
    .replace(/\b(AIza[0-9A-Za-z_-]{20,})/g, "AIza***")
    .replace(/(Bearer\s+)[A-Za-z0-9._~+/=-]{12,}/gi, "$1***")
    .replace(/\beyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\b/g, "<jwt>")
    .replace(/("?(?:password|passwort|secret|token|apiKey|api_key|key|refresh_token|access_token|client_secret)"?\s*[:=]\s*")[^"]{4,}(")/gi, "$1***$2")
    .replace(/(\/\/[^:\s/]+:)[^@\s/]+(@)/g, "$1***$2");
}

function logTail(pfad: string, bytes: number): string {
  if (!existsSync(pfad)) return "";
  const groesse = statSync(pfad).size;
  const start = Math.max(0, groesse - bytes);
  const fd = openSync(pfad, "r");
  try {
    const buf = Buffer.alloc(groesse - start);
    readSync(fd, buf, 0, buf.length, start);
    return buf.toString("utf8");
  } finally {
    closeSync(fd);
  }
}

async function sicher<T>(fn: () => Promise<T> | T, fallback: T): Promise<T> {
  try {
    return await fn();
  } catch {
    return fallback;
  }
}

export async function snapshotErstellen(deps: SnapshotDeps, opt: SnapshotOptionen = {}): Promise<SnapshotErgebnis> {
  const zip = new AdmZip();
  const inhalt: Array<{ datei: string; groesse: number }> = [];
  const add = (name: string, text: string | Buffer) => {
    const buf = Buffer.isBuffer(text) ? text : Buffer.from(maskieren(text), "utf8");
    zip.addFile(name, buf);
    inhalt.push({ datei: name, groesse: buf.byteLength });
  };
  const auth = deps.authStatus();
  const p = paths();
  const appVersion = p.version();
  const plattform = `${process.platform} ${os.release()} (${process.arch})`;

  // Uebersicht
  const gatewayHealth = await sicher(async () => {
    const t0 = Date.now();
    const res = await fetch(`${deps.gatewayUrl.replace(/\/$/, "")}/health`, { signal: AbortSignal.timeout(5000) });
    return { status: res.status, ms: Date.now() - t0 };
  }, { status: 0, ms: -1 });
  const org = auth.signedIn ? await sicher(() => deps.gateway.request<unknown>("/v1/tenants/me"), null) : null;
  const usage = auth.signedIn ? await sicher(() => deps.gateway.request<unknown>("/v1/usage"), null) : null;
  const mem = process.memoryUsage();
  add("uebersicht.json", JSON.stringify({
    erstellt: new Date().toISOString(),
    app: { version: appVersion, gepackt: p.isPackaged, electron: process.versions.electron, chrome: process.versions.chrome, node: process.versions.node, sprache: p.locale(), zeitzone: Intl.DateTimeFormat().resolvedOptions().timeZone, laufzeitSek: Math.round(process.uptime()) },
    system: { plattform: process.platform, release: os.release(), arch: process.arch, cpus: os.cpus().length, speicherGesamtMb: Math.round(os.totalmem() / 1048576), speicherFreiMb: Math.round(os.freemem() / 1048576), prozessHeapMb: Math.round(mem.heapUsed / 1048576), rssMb: Math.round(mem.rss / 1048576) },
    anmeldung: { angemeldet: auth.signedIn, actorId: auth.actorId, tenantId: auth.tenantId, email: auth.email ?? null, name: auth.name ?? null },
    gateway: { url: deps.gatewayUrl, health: gatewayHealth },
    organisation: org,
    verbrauch: usage,
  }, null, 2));

  // Modell
  add("modell.json", JSON.stringify({ anbieter: deps.providerConfig(), ollama: deps.ollamaStatus() }, null, 2));

  // Protokolle
  const mainLog = getMainLogPath();
  add("ava-main.log", logTail(mainLog, LOG_TAIL_BYTES));
  const rotiert = join(getLogDir(), "ava-main.1.log");
  if (existsSync(rotiert)) {
    const alter = Date.now() - statSync(rotiert).mtimeMs;
    if (alter < 6 * 3600_000) add("ava-main.1.log", logTail(rotiert, LOG_TAIL_BYTES / 2));
  }
  for (const producer of ["structured-content", "company-publication", "website", "company-profile", "company-contact", "company-email"]) {
    const zeilen = sicherSync(() => producerLogBuffer.tail(producer, PRODUCER_ZEILEN), [] as Array<{ ts: number; stream: string; text: string }>);
    if (zeilen.length === 0) continue;
    add(`producer-${producer}.log`, zeilen.map((z) => `${new Date(z.ts).toISOString()} ${z.stream} ${z.text}`).join("\n"));
  }

  // Hintergrund und Verarbeitung
  add("hintergrund.json", JSON.stringify({ aufgaben: sicherSync(() => deps.aufgaben(), []) }, null, 2));
  const matrix = auth.signedIn ? await sicher(() => deps.gateway.request<{ companies?: unknown[] }>("/v1/companies/matrix", { query: { pageNumber: 1, pageSize: 20 } }), null) : null;
  add("verarbeitung.json", JSON.stringify({ letzteFirmen: matrix?.companies ?? [] }, null, 2));
  if (deps.einstellungen) add("einstellungen.json", JSON.stringify(sicherSync(() => deps.einstellungen!(), {}), null, 2));

  // Optional: Chat-Auszug und Bildschirmfoto
  if (opt.chatAuszug && opt.chatAuszug.length > 0) {
    add("chat-auszug.json", JSON.stringify({ conversationId: opt.conversationId ?? null, schritte: opt.chatAuszug.slice(-30).map((s) => ({ ...s, text: s.text.slice(0, 2000) })) }, null, 2));
  }
  if (opt.bildschirmfoto && deps.bildschirmfoto) {
    const bild = await sicher(() => deps.bildschirmfoto!(), null as Buffer | null);
    if (bild) add("bildschirm.png", bild);
  }

  const stempel = new Date().toISOString().slice(0, 19).replace(/[:T]/g, "-");
  return { zip: zip.toBuffer(), dateiname: `ava-problem-${stempel}.zip`, inhalt, appVersion, plattform };
}

function sicherSync<T>(fn: () => T, fallback: T): T {
  try {
    return fn();
  } catch {
    return fallback;
  }
}

/** Nur fuer die Vorschau im Dialog: was wuerde mitgehen (ohne zu packen). */
export function snapshotInhaltBeschreibung(): Array<{ datei: string; was: string }> {
  return [
    { datei: "uebersicht.json", was: "App-Version, System, Anmeldung (ohne Zugangsdaten), Organisation, Plan und Kontingent, Erreichbarkeit des Servers" },
    { datei: "modell.json", was: "Gewählter Anbieter und Modell, Stand von Ollama (ohne Schlüssel)" },
    { datei: "ava-main.log", was: "Protokoll der App (letzte 2 MB), Schlüssel und Tokens maskiert" },
    { datei: "producer-*.log", was: "Protokolle der Verarbeitungsschritte dieser Sitzung" },
    { datei: "hintergrund.json", was: "Laufende und zuletzt beendete Hintergrundaufgaben" },
    { datei: "verarbeitung.json", was: "Stand der letzten 20 Firmen aus Meine Firmen" },
    { datei: "einstellungen.json", was: "Deine Einstellungen ohne Zugangsdaten" },
  ];
}

/** Rohdaten lesen, falls der Nutzer die Datei vor dem Senden sehen will. */
export function logDateiLesen(): string {
  return maskieren(sicherSync(() => readFileSync(getMainLogPath(), "utf8").slice(-200_000), ""));
}

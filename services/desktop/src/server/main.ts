// Headless Server-Einstieg (docs/PLAN_AVA_CLOUD.md §12, Schritte R3/R4).
//
// Dieselbe AVA wie in der Desktop-App, nur ohne Fenster: `bootstrapCore` baut
// die komplette Komposition, `startBackground` startet Producer, Postgres,
// Herzschlag und Co. Bedient wird der Kopf über Telegram (läuft im Kopf) und
// später über das MCP-Relais (§11). Dazu kommen:
//
//   - Anmeldung ohne Fenster über den OAuth 2.0 Device Flow: Adresse und Code
//     stehen im Log und auf GET /setup, bis die Person im Browser bestätigt.
//   - Setup-Seite (R4): Anmeldung, KI-Modell (ChatGPT-Abo oder API-Schlüssel),
//     Telegram, E-Mail und Umzug ohne Oberfläche. Darstellung in ./setup-seite.ts,
//     hier nur Sicht-Aufbau und POST-Schritte. Geschützt durch ein Setup-Token aus
//     `AVA_SETUP_TOKEN` (oder ein beim Start erzeugtes, das im Log steht) oder
//     einen Kurzlink aus der AVA-App.
//   - GET /healthz (Prozess lebt), GET /readyz (angemeldet und gestartet),
//     GET /status (Kurzlage als JSON, nur mit Setup-Token),
//     GET /anmeldung (Bestätigungslink für das Gateway, nur mit AVA_GATEWAY_TOKEN).
//   - SIGTERM/SIGINT: dieselben Stopp-Schritte wie die Beenden-Kette der App.
//
// Umgebung (siehe infra/.env.server.example): AVA_DATA_DIR, AVA_RESOURCES_DIR,
// AVA_SECRETS_KEY, AVA_SETUP_TOKEN, GATEWAY_URL/AUTH_ISSUER/AUTH_CLIENT_ID,
// AVA_SERVER_PORT, AVA_SERVER_BIND, AVA_CHROME_BIN, AVA_OLLAMA_HOST/PORT,
// AVA_DISABLE_OLLAMA, AVA_FFMPEG_BIN.

declare const __AVA_VERSION__: string | undefined;
if (typeof __AVA_VERSION__ === "string" && !process.env.AVA_VERSION) process.env.AVA_VERSION = __AVA_VERSION__;

import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { randomBytes, timingSafeEqual } from "node:crypto";
import { join } from "node:path";
import { bootstrapCore, type Core } from "../core/bootstrap";
import { GEBUNDENES_KONTO } from "../core/konto-bindung";
import { lifecycle, paths, platform } from "../core/platform";
import { initFileLogger, quitStep, writeLineSync } from "../main/file-logger";
import { beendeVerwaisteBrowser } from "../main/browser-sweep";
import { producerLogBuffer } from "../main/producer-log-buffer";
import { ladeOderErzeugeHostId } from "../main/auth/siwc-oauth";
import { SiwcHeadlessFlow } from "../main/auth/siwc-headless";
import { siwcErgebnisUebernehmen, vorherigePlanHuelle } from "../main/auth/siwc-anwenden";
import type { DeviceFlowCode } from "../main/auth";
import type { HostedProviderKind, MailAccount } from "../shared/types";
import { featureEnabled } from "../main/org-policy";
import {
  linkAbgelaufenHtml,
  setupSeiteHtml,
  type AnmeldungSicht,
  type Bereich,
  type MailEntwurf,
  type MailSicht,
  type ModellAktiv,
  type ModellSicht,
  type SetupMeldung,
  type SetupSicht,
  type TelegramSicht,
} from "./setup-seite";

type Phase = "start" | "komposition" | "anmeldung" | "laeuft" | "beenden" | "fehler";

// Anthropic fehlt mit Absicht: dort gibt es nur die Abo-Anmeldung (Pro/Max, OAuth
// im Fenster), keinen API-Schlüssel mehr; das bleibt Desktop bzw. Node-Modus.
const ANBIETER: ReadonlyArray<{ kind: HostedProviderKind; name: string }> = [
  { kind: "openai", name: "OpenAI" },
  { kind: "google", name: "Google" },
  { kind: "mistral", name: "Mistral" },
  { kind: "deepseek", name: "DeepSeek" },
  { kind: "xai", name: "xAI" },
  { kind: "qwen", name: "Qwen" },
];

const lage: { phase: Phase; fehler: string | null; code: DeviceFlowCode | null; seit: string } = {
  phase: "start",
  fehler: null,
  code: null,
  seit: new Date().toISOString(),
};
let core: Core | null = null;
let beendenLaeuft = false;
const setupToken = process.env.AVA_SETUP_TOKEN?.trim() || randomBytes(18).toString("base64url");
const siwc = new SiwcHeadlessFlow();
let siwcLink: string | null = null;
/** Letzte Rückmeldung der Setup-Seite (einmal angezeigt, in der Karte ihres Bereichs). */
let setupMeldung: SetupMeldung | null = null;

/**
 * Ohne Fenster gibt es keine Modell-Auswahl: Steht der aktive Anbieter auf Ollama
 * (Vorgabe der App) und ein Schlüssel ist da, wechselt der Server auf diesen
 * Anbieter. Ollama im Container dient nur den Embeddings. Liefert true bei Wechsel.
 */
function anbieterAktivieren(c: Core, kind: HostedProviderKind): boolean {
  if (c.providers.getConfig().kind !== "ollama") return false;
  try {
    c.providers.setProvider(kind);
    console.log(`[server] aktiver Anbieter auf ${kind} gesetzt (Ollama bleibt für Embeddings)`);
    return true;
  } catch (err) {
    console.warn("[server] Anbieterwechsel fehlgeschlagen:", err instanceof Error ? err.message : String(err));
    return false;
  }
}

/** Beim Start: vorhandenen Schlüssel als aktiven Anbieter nehmen, falls noch Ollama eingestellt ist. */
function anbieterBeimStartPruefen(c: Core): void {
  if (c.providers.getConfig().kind !== "ollama") return;
  const mitSchluessel = ANBIETER.find((a) => c.providers.hasKey(a.kind));
  if (mitSchluessel) anbieterAktivieren(c, mitSchluessel.kind);
}

// ---- Setup-Seite: Sicht aus dem Kern (Darstellung in ./setup-seite.ts) -------------

// Rohmeldungen aus dem Device Flow in Saetze fuer den Nutzer (2026-11-12): ein abgelaufener
// Code ist der Normalfall, wenn niemand rechtzeitig bestaetigt, und kein Fehler.
function anmeldeHinweis(roh: string): { text: string; fehler: boolean } {
  if (/expired_token|Code abgelaufen/.test(roh)) return { text: "Der letzte Code ist abgelaufen, bevor die Anmeldung bestätigt wurde. Hier ist ein neuer.", fehler: false };
  if (/access_denied/.test(roh)) return { text: "Die Anmeldung wurde im Browser abgelehnt. Gib den neuen Code ein, um es noch einmal zu versuchen.", fehler: true };
  return { text: `Die Anmeldung hat nicht geklappt: ${roh}`, fehler: true };
}

/** Werte des letzten fehlgeschlagenen Mail-Formulars (ohne Passwörter); einmal vorausgefüllt. */
let mailEntwurf: MailEntwurf | null = null;

function anmeldungSicht(): AnmeldungSicht {
  const st = core?.auth.getStatus();
  if (st?.signedIn) return { zustand: "angemeldet", konto: st.email ?? st.name ?? st.actorId ?? "unbekannt" };
  if (lage.code) {
    const c = lage.code;
    return {
      zustand: "code",
      link: c.verificationUriComplete ?? c.verificationUri,
      adresse: c.verificationUri.replace(/^https?:\/\//, "").replace(/\/$/, ""),
      code: c.userCode,
      bis: c.expiresAt,
      hinweis: lage.fehler && GEBUNDENES_KONTO ? anmeldeHinweis(lage.fehler) : null,
      gebunden: GEBUNDENES_KONTO,
    };
  }
  return { zustand: "wartet", phase: lage.phase, fehler: lage.fehler, gebunden: GEBUNDENES_KONTO };
}

const ANBIETER_NAME = (kind: string): string => ANBIETER.find((a) => a.kind === kind)?.name ?? (kind === "anthropic" ? "Anthropic" : kind);

async function modellSicht(c: Core): Promise<ModellSicht> {
  const p = c.providers;
  const cfg = p.getConfig();
  const stand = await p.chatgptPlanStand();
  // Wie die Laufzeit: Das Abo zaehlt nur, wenn es erlaubt, verbunden und mit Plan-Scope ist.
  const aboAktiv = cfg.kind === "openai" && stand.erlaubt && stand.verbunden && stand.planScope;
  let aktiv: ModellAktiv;
  if (aboAktiv) {
    aktiv = { art: "abo", email: stand.email, modell: stand.modelle.find((m) => m.id === stand.modell)?.label ?? null };
  } else if (cfg.kind !== "ollama" && p.hasKey(cfg.kind)) {
    aktiv = { art: "schluessel", anbieter: ANBIETER_NAME(cfg.kind), organisation: p.keySource(cfg.kind) === "organisation" };
  } else {
    aktiv = { art: "keins" };
  }
  return {
    aktiv,
    verschluesselt: platform().credentials.isEncryptionAvailable(),
    vorgabe: p.isProviderLocked() ? ANBIETER_NAME(cfg.kind) : null,
    anbieter: ANBIETER.map((a) => ({
      kind: a.kind,
      name: a.name,
      quelle: !p.hasKey(a.kind) ? null : p.keySource(a.kind) === "organisation" ? "organisation" : "eigen",
    })),
    abo: stand.erlaubt
      ? {
          verbunden: stand.verbunden,
          email: stand.email,
          planScope: stand.planScope,
          link: siwcLink && siwc.laeuft() ? siwcLink : null,
          linkBis: siwc.gueltigBis(),
        }
      : null,
  };
}

async function telegramSicht(c: Core): Promise<TelegramSicht | null> {
  if (!featureEnabled("telegram")) return null;
  const cfg = c.telegramStore.getConfig();
  const token = await c.telegramStore.getToken().catch(() => null);
  if (!token) return { zustand: "ohne_bot", verschluesselt: platform().credentials.isEncryptionAvailable() };
  // Derselbe Bot an einer anderen Instanz? (Instanzenliste vom Gateway, §13.2)
  const eigeneBotId = token.split(":")[0];
  const andere = c.mcpRelais
    .instanzen()
    .filter((i) => i.id !== c.instanz.get().id && (i.zustand?.telegram as { botId?: string } | undefined)?.botId === eigeneBotId)
    .map((i) => i.name);
  const bot = cfg.botUsername ?? null;
  if (!cfg.chatId) return { zustand: "ohne_chat", bot, andere };
  return {
    zustand: "verbunden",
    bot,
    andere,
    meldungen: cfg.enabled,
    eingang: cfg.inboundEnabled,
    schwelle: cfg.severityThreshold,
    ruhezeiten: cfg.respectQuietHours,
  };
}

async function mailSicht(c: Core): Promise<MailSicht | null> {
  // Von der Organisation abgeschaltet: Bereich ganz ausblenden.
  if (!featureEnabled("mail")) return null;
  const sup = c.mailSupervisor.current;
  if (!sup) return { zustand: "nicht_bereit" };
  if (!platform().credentials.isEncryptionAvailable()) return { zustand: "ohne_schluessel" };
  const snap = await sup.snapshot().catch(() => null);
  const entwurf = mailEntwurf;
  mailEntwurf = null;
  const a = snap?.account ?? null;
  if (!a) return { zustand: "neu", entwurf };
  return {
    zustand: "eingerichtet",
    konto: a,
    verbindung: snap?.connectionState ?? null,
    allowlist: (snap?.allowlist ?? []).map((e) => ({ id: e.id, pattern: e.pattern, label: e.label })),
    entwurf,
  };
}

function instanzenSicht(c: Core): NonNullable<SetupSicht["instanzen"]> {
  const eigen = c.instanz.get().id;
  const st = c.umzug.getStand();
  const umzugLaeuft = ["wartet", "sendet", "empfaengt"].includes(st.phase);
  const liste = c.mcpRelais.instanzen().map((i) => {
    const tg = i.zustand?.telegram as { bot?: string | null; eingerichtet?: boolean } | undefined;
    const rd = i.zustand?.radar as { an?: boolean } | undefined;
    return {
      id: i.id,
      name: i.name,
      art: i.art,
      version: i.version,
      verbunden: i.verbunden,
      eigen: i.id === eigen,
      telegram: tg?.eingerichtet ? (tg.bot ? `@${tg.bot}` : "eingerichtet") : null,
      radar: rd ? !!rd.an : null,
      mcp: i.mcpZiel ? ("beantwortet" as const) : i.zustand?.mcp === false ? ("aus" as const) : ("bereit" as const),
      umziehbar: i.id !== eigen && i.verbunden && !umzugLaeuft,
    };
  });
  const umzug =
    st.phase !== "bereit"
      ? {
          fehler: st.phase === "fehler",
          text: `Umzug ${st.rolle === "ziel" ? "von" : "an"} ${st.gegenueber ?? "?"}: ${st.meldung ?? ""}${st.bytes ? ` (${Math.round(st.bytes / 1048576)} MB)` : ""}`,
        }
      : null;
  return { liste, umzug };
}

async function setupSeite(t: string): Promise<string> {
  const meldung = setupMeldung;
  setupMeldung = null;
  const c = core;
  return setupSeiteHtml({
    version: paths().version(),
    instanzName: c ? c.instanz.get().name : null,
    t,
    jetzt: Date.now(),
    meldung,
    bereit: !!c,
    phase: lage.phase,
    anmeldung: anmeldungSicht(),
    modell: c ? await modellSicht(c) : null,
    telegram: c ? await telegramSicht(c) : null,
    mail: c ? await mailSicht(c) : null,
    instanzen: c ? instanzenSicht(c) : null,
  });
}

/** Mail-Schritte der Setup-Seite; gleiche Pruefung und Ablage wie die Einstellungen der App. */
async function mailAktion(c: Core, aktion: string, form: URLSearchParams): Promise<{ art: "ok" | "fehler"; text: string }> {
  const sup = c.mailSupervisor.current;
  if (!sup) return { art: "fehler", text: "Der Mail-Dienst ist noch nicht bereit." };
  const store = sup.getStore();
  const alt = await store.getAccount();
  const an = (name: string): boolean => form.get(name) === "on";
  if (aktion === "speichern") {
    if (!platform().credentials.isEncryptionAvailable()) return { art: "fehler", text: "AVA_SECRETS_KEY fehlt; Passwörter werden nicht unverschlüsselt gespeichert." };
    const address = (form.get("address") ?? "").trim();
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(address)) return { art: "fehler", text: "Bitte eine gültige E-Mail-Adresse angeben." };
    const port = (name: string, standard: number): number => {
      const n = Number(form.get(name) ?? standard);
      return Number.isInteger(n) && n >= 1 && n <= 65535 ? n : standard;
    };
    const imapHost = (form.get("imapHost") ?? "").trim();
    const smtpHost = (form.get("smtpHost") ?? "").trim();
    if (!imapHost || !smtpHost) return { art: "fehler", text: "IMAP- und SMTP-Server sind Pflicht." };
    const imapPassword = form.get("imapPassword") ?? "";
    const smtpPassword = form.get("smtpPassword") || imapPassword;
    let creds = { imapPassword, smtpPassword };
    if (!imapPassword) {
      // Zugang aendern ohne neues Passwort: vorhandene Zugangsdaten weiterverwenden.
      const vorhandene = alt ? await sup.getCredentials().catch(() => null) : null;
      if (!vorhandene) return { art: "fehler", text: "Bitte das IMAP-Passwort angeben." };
      creds = { imapPassword: vorhandene.imapPassword, smtpPassword: form.get("smtpPassword") || vorhandene.smtpPassword };
    }
    const poll = Number(form.get("pollIntervalMinutes") ?? 15);
    const account: MailAccount = {
      address,
      displayName: (form.get("displayName") ?? "").trim() || "AVA",
      imap: { host: imapHost, port: port("imapPort", 993), secure: an("imapSecure"), user: (form.get("imapUser") ?? "").trim() || address },
      smtp: { host: smtpHost, port: port("smtpPort", 465), secure: an("smtpSecure"), user: (form.get("smtpUser") ?? "").trim() || address },
      outboundEnabled: an("outboundEnabled"),
      autoTriageEnabled: an("autoTriageEnabled"),
      pollIntervalMinutes: Number.isInteger(poll) && poll >= 1 && poll <= 240 ? poll : 15,
      lastSyncAt: alt?.lastSyncAt ?? null,
      lastErrorAt: null,
      lastErrorMessage: null,
    };
    await sup.testConnection(account, creds);
    await sup.configureAccount(account, creds);
    writeLineSync("INFO ", `[setup] Mail-Konto ${address} über die Setup-Seite ${alt ? "geändert" : "eingerichtet"} (IMAP ${imapHost}, SMTP ${smtpHost})`);
    return { art: "ok", text: `Postfach ${address} verbunden: IMAP und SMTP geprüft.` };
  }
  if (aktion === "schalten") {
    if (!alt) return { art: "fehler", text: "Kein Mail-Konto eingerichtet." };
    await store.setAccount({ ...alt, outboundEnabled: an("outboundEnabled"), autoTriageEnabled: an("autoTriageEnabled") });
    return { art: "ok", text: `Senden ${an("outboundEnabled") ? "an" : "aus"}, selbstständige Bearbeitung ${an("autoTriageEnabled") ? "an" : "aus"}.` };
  }
  if (aktion === "allowlist") {
    const pattern = (form.get("pattern") ?? "").trim();
    if (!pattern || !/^[^\s@]*@[^\s@]+\.[^\s@]+$/.test(pattern.replace(/^\*/, "x"))) return { art: "fehler", text: "Bitte eine Adresse oder ein Muster wie *@firma.de angeben." };
    await store.addAllowlistEntry({ pattern, label: (form.get("label") ?? "").trim() || pattern, source: "user" });
    return { art: "ok", text: `${pattern} in die Allowlist aufgenommen.` };
  }
  if (aktion === "allowlist-entfernen") {
    await store.removeAllowlistEntry(form.get("id") ?? "");
    return { art: "ok", text: "Eintrag entfernt." };
  }
  if (aktion === "trennen") {
    await sup.deleteAccount();
    writeLineSync("INFO ", "[setup] Mail-Konto über die Setup-Seite entfernt");
    return { art: "ok", text: "Mail-Konto entfernt." };
  }
  return { art: "fehler", text: "Unbekannte Aktion." };
}


// ---- HTTP ---------------------------------------------------------------------

async function statusJson(): Promise<Record<string, unknown>> {
  const st = core?.auth.getStatus();
  const c = core;
  return {
    version: paths().version(),
    phase: lage.phase,
    fehler: lage.fehler,
    seit: lage.seit,
    angemeldet: st?.signedIn ?? false,
    /** Device-Flow-Code liegt bereit (die Setup-Seite lädt dann neu und zeigt ihn). */
    anmeldecode: Boolean(lage.code),
    konto: st?.email ?? st?.actorId ?? null,
    gebundenAn: GEBUNDENES_KONTO,
    producer: c ? c.producers.map((p) => ({ name: p.getStatus().name, state: p.getStatus().state, meldung: p.getStatus().errorMessage ?? null })) : [],
    ollama: c?.ollama.getStatus().state ?? null,
    postgres: c?.postgres.getStatus().state ?? null,
    modellzugang: c
      ? {
          schluessel: ANBIETER.filter((a) => c.providers.hasKey(a.kind)).map((a) => a.kind),
          chatgptAbo: (await c.providers.chatgptPlanStand()).verbunden,
        }
      : null,
  };
}

/**
 * Kurzlebige Setup-Tokens, erzeugt auf Anfrage der AVA-App („Deine AVA“ → Server-Einstellungen).
 * Der Link muss binnen 15 Minuten geöffnet werden; danach verlängert jede Nutzung (auch die
 * Statusabfrage der offenen Seite) um 30 Minuten, höchstens bis 4 Stunden nach der Erzeugung.
 * Vorher brach die Seite nach 15 Minuten mitten im Einrichten mit 401 ab (2026-11-24).
 */
const kurzTokens = new Map<string, { bis: number; ende: number }>();
const KURZ_TOKEN_MS = 15 * 60_000;
const KURZ_TOKEN_NUTZUNG_MS = 30 * 60_000;
const KURZ_TOKEN_MAX_MS = 4 * 60 * 60_000;

function oeffentlicheAdresse(): string | null {
  const a = process.env.AVA_PUBLIC_URL?.trim().replace(/\/$/, "");
  if (a) return a;
  const fly = process.env.FLY_APP_NAME?.trim();
  return fly ? `https://${fly}.fly.dev` : null;
}

function setupLinkErzeugen(): { url: string | null; bereiche: string[] } {
  const bereiche = ["Anmeldung", "KI-Modell (ChatGPT-Abo oder API-Schlüssel)", "Telegram", "E-Mail", "Umzug zwischen deinen AVAs"];
  const basis = oeffentlicheAdresse();
  if (!basis) return { url: null, bereiche };
  const jetzt = Date.now();
  for (const [t, e] of kurzTokens) if (e.bis < jetzt) kurzTokens.delete(t);
  const token = randomBytes(18).toString("base64url");
  kurzTokens.set(token, { bis: jetzt + KURZ_TOKEN_MS, ende: jetzt + KURZ_TOKEN_MAX_MS });
  return { url: `${basis}/setup?t=${token}`, bereiche };
}

function tokenOk(url: URL): boolean {
  const t = url.searchParams.get("t") ?? "";
  const kurz = kurzTokens.get(t);
  if (kurz !== undefined) {
    const jetzt = Date.now();
    if (kurz.bis >= jetzt) {
      kurz.bis = Math.min(Math.max(kurz.bis, jetzt + KURZ_TOKEN_NUTZUNG_MS), kurz.ende);
      return true;
    }
    kurzTokens.delete(t);
    return false;
  }
  if (t.length !== setupToken.length) return false;
  return timingSafeEqual(Buffer.from(t), Buffer.from(setupToken));
}

// Ein-Klick-Bestätigung für Cloud-Instanzen (docs/PLAN_CLOUD_SELBSTBEDIENUNG.md Z4): Das Gateway
// holt hier den Bestätigungslink des Device Flows ab und zeigt ihn nur dem gebundenen Nutzer
// (App, Mail). Eigenes Token, das nichts anderes erlaubt; ohne AVA_GATEWAY_TOKEN gibt es den
// Endpunkt nicht.
const gatewayToken = process.env.AVA_GATEWAY_TOKEN?.trim() || "";

function gatewayTokenOk(req: IncomingMessage): boolean {
  if (!gatewayToken) return false;
  const kopf = req.headers.authorization ?? "";
  const t = kopf.startsWith("Bearer ") ? kopf.slice(7).trim() : "";
  if (t.length !== gatewayToken.length) return false;
  return timingSafeEqual(Buffer.from(t), Buffer.from(gatewayToken));
}

/** Anmeldestand für das Gateway: angemeldet ja/nein und, solange gültig, der Bestätigungslink. */
function anmeldungJson(): Record<string, unknown> {
  const angemeldet = core?.auth.getStatus().signedIn ?? false;
  // Läuft der Code in weniger als 30 s ab, lieber auf den nächsten warten.
  const c = !angemeldet && lage.code && lage.code.expiresAt > Date.now() + 30_000 ? lage.code : null;
  return {
    angemeldet,
    phase: lage.phase,
    link: c ? c.verificationUriComplete ?? null : null,
    code: c ? c.userCode : null,
    bis: c ? new Date(c.expiresAt).toISOString() : null,
  };
}

async function formular(req: IncomingMessage): Promise<URLSearchParams> {
  const teile: Buffer[] = [];
  let groesse = 0;
  for await (const chunk of req) {
    groesse += (chunk as Buffer).length;
    if (groesse > 64 * 1024) throw new Error("Eingabe zu groß");
    teile.push(chunk as Buffer);
  }
  return new URLSearchParams(Buffer.concat(teile).toString("utf8"));
}

function weiter(res: ServerResponse, t: string, bereich?: Bereich): void {
  res.writeHead(303, { location: `/setup?t=${encodeURIComponent(t)}${bereich ? `#${bereich}` : ""}` });
  res.end();
}

function bereichVonPfad(pfad: string): Bereich | undefined {
  if (pfad === "/setup/key" || pfad.startsWith("/setup/chatgpt/")) return "modell";
  if (pfad.startsWith("/setup/telegram/")) return "telegram";
  if (pfad.startsWith("/setup/mail/")) return "mail";
  if (pfad.startsWith("/setup/umzug/")) return "instanzen";
  return undefined;
}

/** Fehler für die Setup-Seite: Netzfehler in einen Satz, sonst die (deutsche) Meldung der Schicht darunter. */
function fehlerText(err: unknown): string {
  const roh = err instanceof Error ? err.message : String(err);
  if (/fetch failed|ECONNREFUSED|ECONNRESET|ETIMEDOUT|ENOTFOUND|EAI_AGAIN|socket hang up/i.test(roh)) {
    return "Keine Verbindung zum Dienst. Versuch es gleich noch einmal.";
  }
  return roh.replace(/^Error:\s*/, "");
}

/** Felder eines Mail-Formulars ohne Passwörter, damit nach einem Fehlschlag nichts neu getippt werden muss. */
function mailEntwurfAus(form: URLSearchParams): MailEntwurf {
  const e: MailEntwurf = {};
  for (const [k, v] of form) if (k !== "imapPassword" && k !== "smtpPassword") e[k] = v;
  return e;
}

async function setupPost(url: URL, req: IncomingMessage, res: ServerResponse): Promise<void> {
  const t = url.searchParams.get("t") ?? "";
  const bereich = bereichVonPfad(url.pathname);
  const c = core;
  if (!c) {
    setupMeldung = { art: "fehler", text: "AVA ist noch nicht fertig gestartet. Versuch es in einer Minute noch einmal." };
    weiter(res, t);
    return;
  }
  let form: URLSearchParams | null = null;
  try {
    form = await formular(req);
    if (url.pathname === "/setup/key") {
      const kind = form.get("anbieter") ?? "";
      const schluessel = (form.get("schluessel") ?? "").trim();
      const anbieter = ANBIETER.find((a) => a.kind === kind);
      if (!anbieter) throw new Error("Unbekannter Anbieter.");
      if (!schluessel) throw new Error("Kein Schlüssel eingegeben.");
      if (!platform().credentials.isEncryptionAvailable()) throw new Error("Auf diesem Server fehlt der Schlüssel zum Verschlüsseln (AVA_SECRETS_KEY); Zugangsdaten werden nicht unverschlüsselt gespeichert.");
      await c.providers.setApiKey(anbieter.kind, schluessel);
      const gewechselt = anbieterAktivieren(c, anbieter.kind);
      setupMeldung = { art: "ok", text: `Schlüssel für ${anbieter.name} gespeichert.${gewechselt ? ` AVA nutzt jetzt ${anbieter.name}.` : ""}`, bereich };
      writeLineSync("INFO ", `[setup] API-Schlüssel für ${anbieter.kind} über die Setup-Seite gesetzt${gewechselt ? ", Anbieter gewechselt" : ""}`);
    } else if (url.pathname === "/setup/chatgpt/start") {
      const vorherige = await vorherigePlanHuelle(c.providerConfigStore);
      const hostId = ladeOderErzeugeHostId(join(paths().get("userData"), "siwc-host.json"));
      siwcLink = siwc.starten({
        hostId,
        clientId: vorherige?.clientId ?? null,
        idTokenHint: vorherige?.idToken ?? null,
        loginHint: vorherige?.email ?? null,
      });
      // „Bei ChatGPT anmelden“ öffnet einen neuen Tab und geht dort direkt zur Anmeldung;
      // die Setup-Seite im alten Tab lädt neu und zeigt das Feld zum Einfügen.
      if (url.searchParams.get("direkt") === "1") {
        res.writeHead(303, { location: siwcLink, "cache-control": "no-store" });
        res.end();
        return;
      }
      setupMeldung = { art: "ok", text: "Neuer Anmeldelink erzeugt (15 Minuten gültig).", bereich };
    } else if (url.pathname === "/setup/chatgpt/callback") {
      const vorherige = await vorherigePlanHuelle(c.providerConfigStore);
      const ergebnis = await siwc.abschliessen(form.get("adresse") ?? "");
      const r = await siwcErgebnisUebernehmen(c.providers, ergebnis, vorherige);
      siwcLink = null;
      setupMeldung = r.planScope
        ? { art: "ok", text: `ChatGPT verbunden${r.email ? ` als ${r.email}` : ""}. AVA nutzt jetzt dein Abo.`, bereich }
        : {
            art: "fehler",
            text: `Angemeldet${r.email ? ` als ${r.email}` : ""}, aber ChatGPT gibt das Abo nicht für AVA frei. Das klappt nur mit ChatGPT Plus oder Pro; nimm sonst einen API-Schlüssel.`,
            bereich,
          };
      writeLineSync("INFO ", `[setup] ChatGPT-Abo über die Setup-Seite verbunden (planScope=${r.planScope})`);
    } else if (url.pathname === "/setup/umzug/holen" || url.pathname === "/setup/umzug/senden") {
      const id = url.searchParams.get("id") ?? "";
      const r = url.pathname.endsWith("holen") ? c.umzug.holen(id) : c.umzug.senden(id);
      setupMeldung = r.ok
        ? { art: "ok", text: "Umzug gestartet. Diese Seite zeigt den Fortschritt; das Ziel startet am Ende neu.", bereich }
        : { art: "fehler", text: r.grund ?? "Umzug nicht gestartet.", bereich };
      writeLineSync("INFO ", `[setup] Umzug ${url.pathname.endsWith("holen") ? "holen von" : "senden an"} ${id}: ${r.ok ? "gestartet" : r.grund}`);
    } else if (url.pathname.startsWith("/setup/telegram/")) {
      setupMeldung = { ...(await telegramAktion(c, url.pathname.slice("/setup/telegram/".length), form)), bereich };
    } else if (url.pathname.startsWith("/setup/mail/")) {
      const aktion = url.pathname.slice("/setup/mail/".length);
      setupMeldung = { ...(await mailAktion(c, aktion, form)), bereich };
      if (aktion === "speichern" && setupMeldung.art === "fehler") mailEntwurf = mailEntwurfAus(form);
    } else {
      res.writeHead(404);
      res.end();
      return;
    }
  } catch (err) {
    setupMeldung = { art: "fehler", text: fehlerText(err), bereich };
    if (url.pathname === "/setup/mail/speichern" && form) mailEntwurf = mailEntwurfAus(form);
  }
  weiter(res, t, bereich);
}

/** Telegram-Schritte der Setup-Seite; nutzt dieselben Werkzeuge wie der Chat (Self-Service-Regel). */
async function telegramAktion(c: Core, aktion: string, form: URLSearchParams): Promise<{ art: "ok" | "fehler"; text: string }> {
  const tool = async (name: string, args: Record<string, unknown> = {}): Promise<Record<string, unknown>> => {
    const r = await c.mcpRelais.ausfuehren(name, args);
    const d = JSON.parse(r.text) as { ergebnis?: Record<string, unknown>; fehler?: string };
    if (r.isError || d.fehler) throw new Error(d.fehler ?? r.text);
    return d.ergebnis ?? {};
  };
  if (aktion === "token") {
    const token = (form.get("token") ?? "").trim();
    if (!/^\d{5,}:[A-Za-z0-9_-]{20,}$/.test(token)) return { art: "fehler", text: "Das sieht nicht nach einem Bot-Token aus (Form 123456789:AA…)." };
    if (!platform().credentials.isEncryptionAvailable()) return { art: "fehler", text: "AVA_SECRETS_KEY fehlt; der Token wird nicht unverschlüsselt gespeichert." };
    const andere = c.mcpRelais.instanzen().filter((i) => i.id !== c.instanz.get().id && (i.zustand?.telegram as { botId?: string } | undefined)?.botId === token.split(":")[0]);
    if (andere.length) return { art: "fehler", text: `Dieser Bot hängt schon an ${andere.map((i) => i.name).join(", ")}. Für den Server einen eigenen Bot anlegen.` };
    const e = await tool("telegram_connect_save_token", { token });
    if (e.ok === false) return { art: "fehler", text: String(e.error ?? "Token nicht gültig.") };
    writeLineSync("INFO ", "[setup] Telegram-Bot gespeichert");
    return { art: "ok", text: `Bot @${String(e.botUsername ?? "?")} gespeichert. Jetzt in Telegram /start an den Bot schicken und „Chat verknüpfen“ drücken.` };
  }
  if (aktion === "chat") {
    const e = await tool("telegram_link_chat");
    if (e.ok === false) return { art: "fehler", text: String(e.error ?? "Keine Nachricht gefunden; erst /start an den Bot schicken.") };
    c.telegramStore.setConfig({ enabled: true, inboundEnabled: true });
    writeLineSync("INFO ", "[setup] Telegram-Chat verknuepft, Meldungen und Eingang an");
    return { art: "ok", text: "Chat verknüpft. Meldungen und Nachrichten an AVA sind an." };
  }
  if (aktion === "schalten") {
    c.telegramStore.setConfig({ enabled: form.get("enabled") === "on", inboundEnabled: form.get("inbound") === "on" });
    return { art: "ok", text: "Telegram-Einstellungen übernommen." };
  }
  if (aktion === "test") {
    const e = await tool("telegram_send_message", { text: `Test von ${c.instanz.get().name}: Telegram ist verbunden.` });
    return e.ok === false ? { art: "fehler", text: String(e.error ?? "Senden fehlgeschlagen.") } : { art: "ok", text: "Testnachricht gesendet." };
  }
  if (aktion === "trennen") {
    await c.telegramStore.clear();
    return { art: "ok", text: "Bot entfernt." };
  }
  return { art: "fehler", text: "Unbekannte Telegram-Aktion." };
}

function starteHttp(): void {
  const port = Number(process.env.AVA_SERVER_PORT ?? 8080);
  const bind = process.env.AVA_SERVER_BIND ?? "127.0.0.1";
  const server = createServer((req, res) => {
    const url = new URL(req.url ?? "/", "http://ava.local");
    const pfad = url.pathname;
    if (pfad === "/healthz") {
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({ ok: true, phase: lage.phase }));
      return;
    }
    if (pfad === "/readyz") {
      const bereit = lage.phase === "laeuft" && (core?.auth.getStatus().signedIn ?? false);
      res.writeHead(bereit ? 200 : 503, { "content-type": "application/json" });
      res.end(JSON.stringify({ bereit, phase: lage.phase }));
      return;
    }
    if (pfad === "/anmeldung") {
      if (!gatewayTokenOk(req)) {
        res.writeHead(404);
        res.end();
        return;
      }
      res.writeHead(200, { "content-type": "application/json", "cache-control": "no-store" });
      res.end(JSON.stringify(anmeldungJson()));
      return;
    }
    if (pfad === "/status") {
      // Nennt Konto und Modellzugang: nur mit Setup-Token, nicht öffentlich.
      if (!tokenOk(url)) {
        res.writeHead(401, { "content-type": "application/json" });
        res.end(JSON.stringify({ fehler: "Setup-Token nötig (?t=…)" }));
        return;
      }
      void statusJson().then((j) => {
        res.writeHead(200, { "content-type": "application/json" });
        res.end(JSON.stringify(j));
      });
      return;
    }
    if (pfad === "/" || pfad.startsWith("/setup")) {
      if (!tokenOk(url)) {
        res.writeHead(401, { "content-type": "text/html; charset=utf-8", "cache-control": "no-store" });
        res.end(linkAbgelaufenHtml());
        return;
      }
      if (req.method === "POST") {
        void setupPost(url, req, res);
        return;
      }
      void setupSeite(url.searchParams.get("t") ?? "")
        .then((seite) => {
          res.writeHead(200, { "content-type": "text/html; charset=utf-8", "cache-control": "no-store" });
          res.end(seite);
        })
        .catch((err: unknown) => {
          console.error("[setup] Seite nicht gebaut:", err);
          res.writeHead(500, { "content-type": "text/plain; charset=utf-8" });
          res.end("Die Seite konnte nicht geladen werden. Bitte neu laden.");
        });
      return;
    }
    res.writeHead(404);
    res.end();
  });
  server.on("error", (err) => console.error("[server] HTTP-Fehler:", err));
  server.listen(port, bind, () => {
    console.log(`[server] http://${bind}:${port}  (/healthz /readyz /status /setup)`);
    const oeffentlich = oeffentlicheAdresse();
    console.log(`[server] Setup-Seite: ${oeffentlich ?? `http://127.0.0.1:${port}`}/setup?t=${setupToken}`);
  });
  server.unref();
}

/** Device Flow in Schleife, bis die Anmeldung steht; abgelaufene Codes werden erneuert. */
async function anmeldenOhneFenster(c: Core): Promise<void> {
  while (!c.auth.getStatus().signedIn && !beendenLaeuft) {
    lage.phase = "anmeldung";
    try {
      await c.auth.deviceFlowSignIn((code) => {
        lage.code = code;
        const link = code.verificationUriComplete ?? code.verificationUri;
        console.log(`\n[anmeldung] Bitte im Browser bestätigen: ${link}\n[anmeldung] Code: ${code.userCode}\n`);
        writeLineSync("INFO ", `[anmeldung] Device-Flow-Code ausgegeben, gültig bis ${new Date(code.expiresAt).toISOString()}`);
      });
      lage.code = null;
      console.log(`[anmeldung] angemeldet als ${c.auth.getStatus().email ?? c.auth.getStatus().actorId}`);
    } catch (err) {
      lage.code = null;
      const msg = err instanceof Error ? err.message : String(err);
      lage.fehler = msg;
      console.warn("[anmeldung] fehlgeschlagen, neuer Versuch in 10 s:", msg);
      await new Promise((r) => setTimeout(r, 10_000));
    }
  }
  lage.fehler = null;
}

async function beenden(signal: string): Promise<void> {
  if (beendenLaeuft) return;
  beendenLaeuft = true;
  lage.phase = "beenden";
  console.log(`[quit] ${signal} empfangen, Dienste werden gestoppt`);
  writeLineSync("INFO ", `[quit] ${signal} empfangen`);
  const c = core;
  if (c) {
    quitStep("whisper.cancelDownload", () => c.whisper.cancelDownload());
    quitStep("freshness.stop", () => c.freshness.stop());
    quitStep("heartbeat.stop", () => c.heartbeat.stop());
    quitStep("retryTicker.stop", () => c.retryTicker.stop());
    quitStep("agent.dispose", () => c.agent.dispose());
    quitStep("providers.dispose", () => c.providers.dispose());
    quitStep("externalServiceMonitor.stop", () => c.externalServiceMonitor.stop());
    quitStep("ollama.stop", () => c.ollama.stop());
    quitStep("mithelfen.stop", () => c.mithelfen.current?.stop());
    // Producer bekommen bis zu vier Sekunden; danach raus, Chrome-Waisen werden mitgenommen.
    const deadline = new Promise<void>((r) => setTimeout(r, 4000));
    const stops = Promise.all(c.producers.map((p) => p.stop().catch(() => undefined)));
    await Promise.race([stops, deadline]);
    await beendeVerwaisteBrowser({ alle: true, log: (z) => writeLineSync("INFO ", z) }).catch(() => undefined);
    await Promise.race([c.postgres.stop().catch(() => undefined), new Promise<void>((r) => setTimeout(r, 2000))]);
    quitStep("producerLogBuffer.closeRunFiles", () => producerLogBuffer.closeRunFiles());
  }
  writeLineSync("INFO ", "[quit] Stopp-Schritte fertig");
  console.log("[quit] Stopp-Schritte fertig");
  // Lässt die onBeforeQuit-Handler der Module laufen und beendet den Prozess.
  lifecycle().exit(0);
}

async function main(): Promise<void> {
  if (platform().kind !== "node") throw new Error("Der Server-Einstieg braucht die Node-Plattform");
  initFileLogger();
  console.log(`[server] AVA ${paths().version()} startet, Daten in ${paths().get("userData")}`);
  if (!platform().credentials.isEncryptionAvailable()) {
    console.warn("[server] AVA_SECRETS_KEY fehlt oder ist ungültig (32 Byte hex/base64): Anmelde-Token und Schlüssel können nicht gespeichert werden; nach jedem Neustart ist eine neue Anmeldung nötig.");
  }
  if (!process.env.AVA_SETUP_TOKEN) console.log("[server] AVA_SETUP_TOKEN nicht gesetzt; ein zufälliges Token gilt bis zum Neustart (siehe Setup-Adresse unten).");
  starteHttp();
  process.on("SIGTERM", () => void beenden("SIGTERM"));
  process.on("SIGINT", () => void beenden("SIGINT"));

  lage.phase = "komposition";
  const c = await bootstrapCore({ setupLink: setupLinkErzeugen });
  core = c;
  anbieterBeimStartPruefen(c);
  // Hintergrunddienste wie in der App; Producer laufen an, sobald die Anmeldung steht.
  await c.startBackground();
  lage.phase = "laeuft";
  void anmeldenOhneFenster(c).then(() => {
    lage.phase = "laeuft";
  });
}

main().catch((err) => {
  lage.phase = "fehler";
  lage.fehler = err instanceof Error ? err.message : String(err);
  console.error("[server] Start fehlgeschlagen:", err);
  writeLineSync("ERROR", `[server] Start fehlgeschlagen: ${lage.fehler}`);
  // Health bleibt erreichbar, damit der Fehler lesbar ist; der Orchestrator entscheidet über den Neustart.
  setTimeout(() => process.exit(1), 30_000).unref();
});

// Headless Server-Einstieg (docs/PLAN_AVA_CLOUD.md §12, Schritte R3/R4).
//
// Dieselbe AVA wie in der Desktop-App, nur ohne Fenster: `bootstrapCore` baut
// die komplette Komposition, `startBackground` startet Producer, Postgres,
// Herzschlag und Co. Bedient wird der Kopf über Telegram (läuft im Kopf) und
// später über das MCP-Relais (§11). Dazu kommen:
//
//   - Anmeldung ohne Fenster über den OAuth 2.0 Device Flow: Adresse und Code
//     stehen im Log und auf GET /setup, bis die Person im Browser bestätigt.
//   - Setup-Seite (R4): Modellzugang ohne Oberfläche. API-Schlüssel je Anbieter
//     eintragen, ChatGPT-Abo verbinden (Anmeldelink öffnen, Weiterleitungs-
//     adresse einfügen). Geschützt durch ein Setup-Token aus `AVA_SETUP_TOKEN`
//     oder, wenn es fehlt, ein beim Start erzeugtes, das im Log steht.
//   - GET /healthz (Prozess lebt), GET /readyz (angemeldet und gestartet),
//     GET /status (Kurzlage als JSON, nur mit Setup-Token).
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
import type { HostedProviderKind } from "../shared/types";

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
/** Letzte Rückmeldung der Setup-Seite (einmal angezeigt). */
let setupMeldung: { art: "ok" | "fehler"; text: string } | null = null;

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

// ---- HTML ---------------------------------------------------------------------

function esc(s: string): string {
  return s.replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c] ?? c);
}

function html(body: string): string {
  return `<!doctype html><html lang="de"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>AVA Server</title>
<style>
body{font-family:system-ui,sans-serif;max-width:44rem;margin:2.5rem auto;padding:0 1rem;color:#0A1F2A;background:#F2F7F6;line-height:1.45}
h1{font-size:1.6rem}h2{font-size:1.15rem;margin-top:2rem;border-top:1px solid #d7e3e0;padding-top:1rem}
code,.code{font-size:1.3rem;letter-spacing:.08em;background:#fff;padding:.3rem .6rem;border-radius:.4rem}
a{color:#00836f}form{margin:.6rem 0}input,select,textarea{font:inherit;padding:.45rem .6rem;border:1px solid #b9cbc7;border-radius:.4rem;background:#fff;width:100%;box-sizing:border-box}
textarea{min-height:5rem}button{font:inherit;padding:.5rem .9rem;border:0;border-radius:.4rem;background:#00C0A7;color:#0A1F2A;font-weight:600;cursor:pointer;margin-top:.5rem}
.ok{background:#dff5ef;padding:.6rem .8rem;border-radius:.4rem}.fehler{background:#fde3df;padding:.6rem .8rem;border-radius:.4rem}
table{border-collapse:collapse}td,th{text-align:left;padding:.25rem .8rem .25rem 0}small{color:#4b6a66}
</style></head><body>${body}</body></html>`;
}

function anmeldungAbschnitt(): string {
  const st = core?.auth.getStatus();
  if (st?.signedIn) return `<p class="ok">Angemeldet als ${esc(st.email ?? st.name ?? st.actorId ?? "unbekannt")}.</p>`;
  const bindung = GEBUNDENES_KONTO ? `<p><small>Diese AVA ist für <strong>${esc(GEBUNDENES_KONTO)}</strong> eingerichtet; nur dieses Konto kann sich anmelden.</small></p>` : "";
  if (lage.code) {
    const c = lage.code;
    const link = c.verificationUriComplete ?? c.verificationUri;
    return `${bindung}${lage.fehler && GEBUNDENES_KONTO ? `<p class="fehler">${esc(lage.fehler)}</p>` : ""}<p>Öffne <a href="${esc(link)}" target="_blank" rel="noopener">${esc(c.verificationUri)}</a> und gib diesen Code ein:</p><p><span class="code">${esc(c.userCode)}</span></p><p><small>Gültig bis ${new Date(c.expiresAt).toLocaleTimeString("de-DE")}; danach erscheint hier ein neuer Code.</small></p>`;
  }
  return `<p>Phase: ${esc(lage.phase)}${lage.fehler ? `<br><small>${esc(lage.fehler)}</small>` : ""}</p><p><small>Seite neu laden, sobald der Anmelde-Code bereitsteht.</small></p>`;
}

function modellAbschnitt(t: string): string {
  const c = core;
  if (!c) return "<p>Noch nicht bereit.</p>";
  const zeilen = ANBIETER.map(
    (a) => `<tr><td>${esc(a.name)}</td><td>${c.providers.hasKey(a.kind) ? "Schlüssel hinterlegt" : "<small>kein Schlüssel</small>"}</td></tr>`,
  ).join("");
  const optionen = ANBIETER.map((a) => `<option value="${a.kind}">${esc(a.name)}</option>`).join("");
  const verschluesselt = platform().credentials.isEncryptionAvailable();
  const aktiv = c.providers.getConfig().kind;
  return `<p><small>Aktiver Anbieter: ${esc(aktiv)}${aktiv === "ollama" ? " (ohne lokales Chat-Modell; wechselt beim Speichern eines Schlüssels)" : ""}</small></p><table>${zeilen}</table>
${verschluesselt ? "" : '<p class="fehler">AVA_SECRETS_KEY fehlt: Schlüssel würden unverschlüsselt liegen; Speichern ist deshalb gesperrt.</p>'}
<form method="post" action="/setup/key?t=${esc(t)}">
  <label>Anbieter <select name="anbieter">${optionen}</select></label>
  <label>API-Schlüssel <input name="schluessel" type="password" autocomplete="off" required></label>
  <button type="submit" ${verschluesselt ? "" : "disabled"}>Schlüssel speichern</button>
</form>
<p><small>Alternativ im Chat über Telegram (Werkzeug settings_set_api_key). Ein Organisationsschlüssel im Gateway wirkt ohne Eintrag.</small></p>`;
}

async function chatgptAbschnitt(t: string): Promise<string> {
  const c = core;
  if (!c) return "";
  const stand = await c.providers.chatgptPlanStand();
  const kopf = stand.verbunden
    ? `<p class="ok">Verbunden${stand.email ? ` als ${esc(stand.email)}` : ""}${stand.planScope ? "" : " (ohne Plan-Nutzung)"}.</p>`
    : "<p>Nicht verbunden.</p>";
  const schritt2 = siwcLink && siwc.laeuft()
    ? `<ol><li>Anmelden: <a href="${esc(siwcLink)}" target="_blank" rel="noopener">Mit ChatGPT fortfahren</a></li>
<li>Der Browser leitet danach auf <code style="font-size:.9rem">127.0.0.1:1456/auth/callback?…</code> weiter und zeigt eine Fehlerseite. Das ist erwartet. Die vollständige Adresse aus der Adresszeile hier einfügen:</li></ol>
<form method="post" action="/setup/chatgpt/callback?t=${esc(t)}"><textarea name="adresse" placeholder="http://127.0.0.1:1456/auth/callback?code=…&state=…" required></textarea><button type="submit">Verbindung abschließen</button></form>`
    : `<form method="post" action="/setup/chatgpt/start?t=${esc(t)}"><button type="submit">${stand.verbunden ? "Neu verbinden" : "Anmeldelink erzeugen"}</button></form>`;
  return kopf + schritt2 + "<p><small>Plan-Nutzung gibt es mit ChatGPT Plus oder Pro; Chat, Hintergrund-KI und Producer laufen dann über das Abo.</small></p>";
}

async function telegramAbschnitt(t: string): Promise<string> {
  const c = core;
  if (!c) return "";
  const cfg = c.telegramStore.getConfig();
  const token = await c.telegramStore.getToken().catch(() => null);
  const eigeneBotId = token ? token.split(":")[0] : null;
  // Derselbe Bot an einer anderen Instanz? (Instanzenliste vom Gateway, §13.2)
  const andere = c.mcpRelais
    .instanzen()
    .filter((i) => i.id !== c.instanz.get().id && (i.zustand?.telegram as { botId?: string } | undefined)?.botId === eigeneBotId && eigeneBotId);
  const warnung = andere.length
    ? `<p class="fehler">Dieser Bot hängt auch an ${andere.map((i) => esc(i.name)).join(", ")}. Telegram lässt je Bot nur einen Abholer zu; für diesen Server einen eigenen Bot bei @BotFather anlegen.</p>`
    : "";
  if (!token) {
    return `<p>Für den Server einen <strong>eigenen</strong> Bot anlegen (nicht den der Desktop-App): in Telegram <a href="https://t.me/BotFather" target="_blank" rel="noopener">@BotFather</a> öffnen, <code style="font-size:.9rem">/newbot</code>, Namen vergeben, den Token hier einfügen.</p>
<form method="post" action="/setup/telegram/token?t=${esc(t)}"><label>Bot-Token <input name="token" type="password" autocomplete="off" required placeholder="123456789:AA…"></label><button type="submit">Bot speichern</button></form>`;
  }
  const bot = cfg.botUsername ? `@${esc(cfg.botUsername)}` : "Bot";
  if (!cfg.chatId) {
    return `${warnung}<p>${bot} ist gespeichert. Schreib dem Bot in Telegram <code style="font-size:.9rem">/start</code> und verknüpfe dann den Chat:</p>
<form method="post" action="/setup/telegram/chat?t=${esc(t)}"><button type="submit">Chat verknüpfen</button></form>
<form method="post" action="/setup/telegram/trennen?t=${esc(t)}"><button type="submit">Bot entfernen</button></form>`;
  }
  return `${warnung}<p class="ok">${bot} verbunden, Chat verknüpft. Meldungen ${cfg.enabled ? "an" : "aus"}, Nachrichten an AVA ${cfg.inboundEnabled ? "an" : "aus"} (Schwelle ${esc(cfg.severityThreshold)}${cfg.respectQuietHours ? ", Ruhezeiten wie eingestellt" : ""}).</p>
<form method="post" action="/setup/telegram/schalten?t=${esc(t)}">
  <label><input type="checkbox" name="enabled" ${cfg.enabled ? "checked" : ""} style="width:auto"> Meldungen aufs Handy</label><br>
  <label><input type="checkbox" name="inbound" ${cfg.inboundEnabled ? "checked" : ""} style="width:auto"> Nachrichten an AVA (Chat über Telegram)</label><br>
  <button type="submit">Übernehmen</button>
</form>
<form method="post" action="/setup/telegram/test?t=${esc(t)}"><button type="submit">Testnachricht senden</button></form>
<form method="post" action="/setup/telegram/trennen?t=${esc(t)}"><button type="submit">Bot entfernen</button></form>`;
}

function instanzenAbschnitt(t = ""): string {
  const c = core;
  if (!c) return "";
  const l = c.mcpRelais.instanzen();
  if (l.length === 0) return "<p><small>Nicht mit dem Gateway verbunden; die Liste erscheint nach der Anmeldung.</small></p>";
  const eigen = c.instanz.get().id;
  const umzugLaeuft = ["wartet", "sendet", "empfaengt"].includes(c.umzug.getStand().phase);
  const zeilen = l
    .map((i) => {
      const tg = i.zustand?.telegram as { bot?: string | null; eingerichtet?: boolean } | undefined;
      const rd = i.zustand?.radar as { an?: boolean } | undefined;
      const umzugKnopf =
        i.id !== eigen && i.verbunden && !umzugLaeuft
          ? `<form method="post" action="/setup/umzug/holen?t=${esc(t)}&id=${encodeURIComponent(i.id)}" onsubmit="return confirm('Kompletten Stand von ${esc(i.name)} auf diesen Server holen? Der Server wird überschrieben und startet neu; der bisherige Stand bleibt als Sicherung. Anmeldung, Telegram-Bot und Abo-Anmeldungen bleiben.')"><button type="submit">Hierher holen</button></form>
<form method="post" action="/setup/umzug/senden?t=${esc(t)}&id=${encodeURIComponent(i.id)}" onsubmit="return confirm('Kompletten Stand dieses Servers an ${esc(i.name)} senden? ${esc(i.name)} wird überschrieben und startet neu.')"><button type="submit">Dorthin senden</button></form>`
          : "";
      return `<tr><td>${esc(i.name)}${i.id === eigen ? " <small>(dieser)</small>" : ""}<br><small>${i.art} · v${esc(i.version)} · ${i.verbunden ? "verbunden" : "offline"}</small></td><td>${tg?.eingerichtet ? (tg.bot ? "@" + esc(tg.bot) : "Bot") : "–"}</td><td>${rd ? (rd.an ? "an" : "aus") : "–"}</td><td>${i.mcpZiel ? "beantwortet" : "–"}</td><td>${umzugKnopf}</td></tr>`;
    })
    .join("");
  const st = c.umzug.getStand();
  const umzugZeile = st.phase !== "bereit" ? `<p class="${st.phase === "fehler" ? "fehler" : "ok"}">Umzug ${st.rolle === "ziel" ? "von" : "an"} ${esc(st.gegenueber ?? "?")}: ${esc(st.meldung ?? "")}${st.bytes ? ` (${Math.round(st.bytes / 1048576)} MB)` : ""}</p>` : "";
  return `${umzugZeile}<table><tr><th>Instanz</th><th>Telegram</th><th>Radar</th><th>MCP</th><th>Umzug</th></tr>${zeilen}</table><p><small>Umzug überträgt alles, was AVA lokal hält, und überschreibt das Ziel. Anmeldung, Telegram-Bot und Abo-Anmeldungen bleiben je Instanz.</small></p>`;
}

async function setupSeite(t: string): Promise<string> {
  const meldung = setupMeldung ? `<p class="${setupMeldung.art}">${esc(setupMeldung.text)}</p>` : "";
  setupMeldung = null;
  return html(`<h1>AVA Server ${esc(paths().version())}</h1>${meldung}
<h2>1. Anmeldung</h2>${anmeldungAbschnitt()}
<h2>2. Modellzugang: API-Schlüssel</h2>${modellAbschnitt(t)}
<h2>3. Modellzugang: ChatGPT-Abo</h2>${await chatgptAbschnitt(t)}
<h2>4. Telegram</h2>${await telegramAbschnitt(t)}
<h2>5. Deine AVAs</h2>${instanzenAbschnitt(t)}`);
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

function tokenOk(url: URL): boolean {
  const t = url.searchParams.get("t") ?? "";
  if (t.length !== setupToken.length) return false;
  return timingSafeEqual(Buffer.from(t), Buffer.from(setupToken));
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

function weiter(res: ServerResponse, t: string): void {
  res.writeHead(303, { location: `/setup?t=${encodeURIComponent(t)}` });
  res.end();
}

async function setupPost(url: URL, req: IncomingMessage, res: ServerResponse): Promise<void> {
  const t = url.searchParams.get("t") ?? "";
  const c = core;
  if (!c) {
    setupMeldung = { art: "fehler", text: "AVA ist noch nicht fertig gestartet." };
    weiter(res, t);
    return;
  }
  try {
    const form = await formular(req);
    if (url.pathname === "/setup/key") {
      const kind = form.get("anbieter") ?? "";
      const schluessel = (form.get("schluessel") ?? "").trim();
      const anbieter = ANBIETER.find((a) => a.kind === kind);
      if (!anbieter) throw new Error("Unbekannter Anbieter.");
      if (!schluessel) throw new Error("Kein Schlüssel eingegeben.");
      if (!platform().credentials.isEncryptionAvailable()) throw new Error("AVA_SECRETS_KEY fehlt; Schlüssel werden nicht unverschlüsselt gespeichert.");
      await c.providers.setApiKey(anbieter.kind, schluessel);
      const gewechselt = anbieterAktivieren(c, anbieter.kind);
      setupMeldung = { art: "ok", text: `Schlüssel für ${anbieter.name} gespeichert${gewechselt ? ` und ${anbieter.name} als aktiven Anbieter gesetzt` : ""}.` };
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
      setupMeldung = { art: "ok", text: "Anmeldelink erzeugt (15 Minuten gültig)." };
    } else if (url.pathname === "/setup/chatgpt/callback") {
      const vorherige = await vorherigePlanHuelle(c.providerConfigStore);
      const ergebnis = await siwc.abschliessen(form.get("adresse") ?? "");
      const r = await siwcErgebnisUebernehmen(c.providers, ergebnis, vorherige);
      siwcLink = null;
      setupMeldung = {
        art: "ok",
        text: `ChatGPT verbunden${r.email ? ` als ${r.email}` : ""}${r.planScope ? "" : " (ohne Plan-Nutzung: nur Plus/Pro teilen den Plan)"}.`,
      };
      writeLineSync("INFO ", `[setup] ChatGPT-Abo über die Setup-Seite verbunden (planScope=${r.planScope})`);
    } else if (url.pathname === "/setup/umzug/holen" || url.pathname === "/setup/umzug/senden") {
      const id = url.searchParams.get("id") ?? "";
      const r = url.pathname.endsWith("holen") ? c.umzug.holen(id) : c.umzug.senden(id);
      setupMeldung = r.ok ? { art: "ok", text: "Umzug gestartet. Diese Seite zeigt den Fortschritt; das Ziel startet am Ende neu." } : { art: "fehler", text: r.grund ?? "Umzug nicht gestartet." };
      writeLineSync("INFO ", `[setup] Umzug ${url.pathname.endsWith("holen") ? "holen von" : "senden an"} ${id}: ${r.ok ? "gestartet" : r.grund}`);
    } else if (url.pathname.startsWith("/setup/telegram/")) {
      setupMeldung = await telegramAktion(c, url.pathname.slice("/setup/telegram/".length), form);
    } else {
      res.writeHead(404);
      res.end();
      return;
    }
  } catch (err) {
    setupMeldung = { art: "fehler", text: err instanceof Error ? err.message : String(err) };
  }
  weiter(res, t);
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
        res.writeHead(401, { "content-type": "text/html; charset=utf-8" });
        res.end(html('<h1>AVA Server</h1><p>Die Setup-Seite braucht das Setup-Token: <code style="font-size:1rem">/setup?t=…</code>. Es steht im Startprotokoll des Servers oder in <code style="font-size:1rem">AVA_SETUP_TOKEN</code>.</p>'));
        return;
      }
      if (req.method === "POST") {
        void setupPost(url, req, res);
        return;
      }
      void setupSeite(url.searchParams.get("t") ?? "").then((seite) => {
        res.writeHead(200, { "content-type": "text/html; charset=utf-8", "cache-control": "no-store" });
        res.end(seite);
      });
      return;
    }
    res.writeHead(404);
    res.end();
  });
  server.on("error", (err) => console.error("[server] HTTP-Fehler:", err));
  server.listen(port, bind, () => {
    console.log(`[server] http://${bind}:${port}  (/healthz /readyz /status /setup)`);
    const oeffentlich = process.env.AVA_PUBLIC_URL?.replace(/\/$/, "");
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
  const c = await bootstrapCore({});
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

#!/usr/bin/env node
// Testlauf gegen eine headless AVA (docs/PLAN_AVA_CLOUD.md §12/§11).
//
// Prüft den echten Weg, den Claude oder ChatGPT nehmen: alles über mcp.ava.bi
// mit dem eigenen Keycloak-Konto, dazu Setup-/Status-Seite des Servers.
//
//   node scripts/server-testlauf.mjs                       # nur lesend
//   node scripts/server-testlauf.mjs --mit-verarbeitung    # + Import einer Firma bis „fertig“
//   node scripts/server-testlauf.mjs --mit-ava-fragen      # + ein Auftrag an AVAs Agenten (Modellkosten)
//   node scripts/server-testlauf.mjs --alles
//
// Umgebung:
//   AVA_SERVER_URL   Standard https://headless-ava.fly.dev
//   AVA_SETUP_TOKEN  Setup-Token des Servers (für /status); ohne wird der Teil übersprungen
//   AVA_MCP_URL      Standard https://mcp.ava.bi/
//   AVA_TEST_FIRMA   companyId für den Verarbeitungstest (Standard: Strategic IT GmbH, Herford)
//
// Anmeldung: Beim ersten Lauf Device Flow (Code im Terminal bestätigen); das
// Refresh-Token liegt danach in ~/.ava-testlauf.json (nur lesbar für dich).
// Der Lauf schreibt nichts außer im Verarbeitungstest (ein Import) und den
// Rückfrage-Test, der bewusst mit „nein“ abbricht.

import { createHash, randomBytes } from "node:crypto";
import { readFileSync, writeFileSync, chmodSync, existsSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

const ISSUER = process.env.AUTH_ISSUER ?? "https://fly-keycloak-broken-bird-3701.fly.dev/realms/ava";
const CLIENT = process.env.AUTH_CLIENT_ID ?? "ava-desktop";
const GATEWAY = (process.env.GATEWAY_URL ?? "https://ava-db-gateway.fly.dev").replace(/\/$/, "");
const MCP = process.env.AVA_MCP_URL ?? "https://mcp.ava.bi/";
const SERVER = (process.env.AVA_SERVER_URL ?? "https://headless-ava.fly.dev").replace(/\/$/, "");
const SETUP_TOKEN = process.env.AVA_SETUP_TOKEN ?? "";
const TEST_FIRMA = process.env.AVA_TEST_FIRMA ?? "BADOEYNHAUSEN_HRB_14952";
const TOKEN_DATEI = join(homedir(), ".ava-testlauf.json");
const ARGS = new Set(process.argv.slice(2));
const MIT_VERARBEITUNG = ARGS.has("--mit-verarbeitung") || ARGS.has("--alles");
const MIT_AVA_FRAGEN = ARGS.has("--mit-ava-fragen") || ARGS.has("--alles");

// ---- Ausgabe -----------------------------------------------------------------

const ergebnisse = [];
function melde(bereich, name, stufe, text) {
  ergebnisse.push({ bereich, name, stufe, text });
  const zeichen = { ok: "✔", warn: "▲", fehler: "✘", info: "·" }[stufe];
  console.log(`  ${zeichen} ${name}${text ? ` — ${text}` : ""}`);
}
function abschnitt(t) {
  console.log(`\n${t}`);
}

// ---- Anmeldung ---------------------------------------------------------------

async function tokenEndpunkt() {
  const d = await (await fetch(`${ISSUER}/.well-known/openid-configuration`)).json();
  return d;
}

async function holeToken() {
  const disc = await tokenEndpunkt();
  if (existsSync(TOKEN_DATEI)) {
    try {
      const { refresh_token } = JSON.parse(readFileSync(TOKEN_DATEI, "utf8"));
      const r = await fetch(disc.token_endpoint, {
        method: "POST",
        headers: { "content-type": "application/x-www-form-urlencoded" },
        body: new URLSearchParams({ grant_type: "refresh_token", client_id: CLIENT, refresh_token }),
      });
      if (r.ok) {
        const t = await r.json();
        speichere(t);
        return t.access_token;
      }
    } catch {
      /* neu anmelden */
    }
  }
  const verifier = randomBytes(32).toString("base64url");
  const challenge = createHash("sha256").update(verifier).digest("base64url");
  const dev = await (
    await fetch(disc.device_authorization_endpoint, {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({ client_id: CLIENT, scope: "openid profile email offline_access", code_challenge: challenge, code_challenge_method: "S256" }),
    })
  ).json();
  console.log(`\nAnmeldung: ${dev.verification_uri_complete ?? dev.verification_uri}\nCode: ${dev.user_code}\n`);
  const bis = Date.now() + dev.expires_in * 1000;
  while (Date.now() < bis) {
    await new Promise((r) => setTimeout(r, (dev.interval ?? 5) * 1000));
    const r = await fetch(disc.token_endpoint, {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({ grant_type: "urn:ietf:params:oauth:grant-type:device_code", client_id: CLIENT, device_code: dev.device_code, code_verifier: verifier }),
    });
    if (r.ok) {
      const t = await r.json();
      speichere(t);
      return t.access_token;
    }
    const f = await r.json().catch(() => ({}));
    if (f.error !== "authorization_pending" && f.error !== "slow_down") throw new Error(`Anmeldung abgebrochen: ${f.error}`);
  }
  throw new Error("Anmeldecode abgelaufen");
}

function speichere(t) {
  if (!t.refresh_token) return;
  writeFileSync(TOKEN_DATEI, JSON.stringify({ refresh_token: t.refresh_token }), "utf8");
  try {
    chmodSync(TOKEN_DATEI, 0o600);
  } catch {
    /* egal */
  }
}

// ---- MCP ---------------------------------------------------------------------

let TOKEN = "";
let rpcId = 0;
async function mcp(method, params) {
  const r = await fetch(MCP, {
    method: "POST",
    headers: { authorization: `Bearer ${TOKEN}`, "content-type": "application/json", accept: "application/json, text/event-stream" },
    body: JSON.stringify({ jsonrpc: "2.0", id: ++rpcId, method, params }),
  });
  if (!r.ok) throw new Error(`MCP ${method}: HTTP ${r.status}`);
  return r.json();
}
async function werkzeug(name, args = {}) {
  const j = await mcp("tools/call", { name, arguments: args });
  if (j.error) return { fehler: j.error.message };
  const text = j.result?.content?.[0]?.text ?? "";
  let daten = null;
  try {
    daten = JSON.parse(text);
  } catch {
    daten = null;
  }
  return { isError: j.result?.isError === true, text, daten };
}
/** Werkzeug der laufenden AVA über werkzeug_ausfuehren; liefert das innere Ergebnis. */
async function kopf(name, args = {}) {
  const r = await werkzeug("werkzeug_ausfuehren", { name, args });
  return { ...r, ergebnis: r.daten?.ergebnis ?? null, innererFehler: r.daten?.fehler ?? null };
}

// ---- Szenarien ---------------------------------------------------------------

async function infrastruktur() {
  abschnitt("1. Infrastruktur");
  try {
    const h = await (await fetch(`${SERVER}/healthz`)).json();
    melde("infra", "Server erreichbar", h.ok ? "ok" : "fehler", `Phase ${h.phase}`);
  } catch (e) {
    melde("infra", "Server erreichbar", "fehler", e.message);
  }
  if (SETUP_TOKEN) {
    try {
      const s = await (await fetch(`${SERVER}/status?t=${encodeURIComponent(SETUP_TOKEN)}`)).json();
      melde("infra", "Server angemeldet", s.angemeldet ? "ok" : "fehler", s.konto ?? "nicht angemeldet");
      const nichtBereit = (s.producer ?? []).filter((p) => p.state !== "ready");
      melde("infra", "Producer", nichtBereit.length === 0 ? "ok" : "fehler", nichtBereit.length ? nichtBereit.map((p) => `${p.name}: ${p.state}`).join(", ") : `${(s.producer ?? []).length} bereit`);
      melde("infra", "Ollama (Embeddings)", s.ollama === "ready" ? "ok" : "warn", s.ollama);
      melde("infra", "Postgres (PGlite)", s.postgres === "ready" ? "ok" : "fehler", s.postgres);
      const mz = s.modellzugang ?? {};
      melde("infra", "Modellzugang", (mz.schluessel ?? []).length || mz.chatgptAbo ? "ok" : "fehler", [...(mz.schluessel ?? []), ...(mz.chatgptAbo ? ["ChatGPT-Abo"] : [])].join(", ") || "keiner");
    } catch (e) {
      melde("infra", "Status-Seite", "fehler", e.message);
    }
  } else {
    melde("infra", "Status-Seite", "info", "AVA_SETUP_TOKEN nicht gesetzt, übersprungen");
  }
  const init = await mcp("initialize", { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "server-testlauf", version: "1" } });
  const verbunden = /gerade verbunden/.test(init.result?.instructions ?? "");
  melde("infra", "MCP-Relais: AVA verbunden", verbunden ? "ok" : "fehler", verbunden ? "Kopf meldet sich am Gateway" : "kein Kopf verbunden");
  const list = await mcp("tools/list", {});
  const namen = (list.result?.tools ?? []).map((t) => t.name);
  melde("infra", "Werkzeugliste", namen.length >= 30 ? "ok" : "warn", `${namen.length} Werkzeuge${namen.includes("ava_fragen") ? ", ava_fragen dabei" : ", ohne ava_fragen"}`);
  const kat = await werkzeug("werkzeug_suchen", { q: "*" });
  melde("infra", "Werkzeugkatalog", kat.daten?.gesamt ? "ok" : "fehler", kat.daten?.gesamt ? `${kat.daten.gesamt} Werkzeuge in ${kat.daten.bereiche.length} Bereichen` : kat.text.slice(0, 120));
  return verbunden;
}

async function gatewayLesen() {
  abschnitt("2. Lesen über den Gateway (geht auch ohne laufende AVA)");
  const s = await werkzeug("firma_suchen", { q: "Strategic IT Herford", limit: 3 });
  const t = s.daten?.firmen?.[0];
  melde("lesen", "firma_suchen", t ? "ok" : "fehler", t ? `${t.name}, ${t.ort} (${t.companyId})` : s.text.slice(0, 120));
  const l = await werkzeug("firma_lesen", { companyId: TEST_FIRMA, bereiche: ["profil", "register"] });
  melde("lesen", "firma_lesen", !l.isError ? "ok" : "fehler", l.isError ? l.text.slice(0, 120) : `${l.text.length} Zeichen`);
  const m = await werkzeug("meldungen", {});
  melde("lesen", "meldungen", !m.isError ? "ok" : "fehler", m.isError ? m.text.slice(0, 120) : "abrufbar");
  const a = await werkzeug("auftraege", { proSeite: 5 });
  melde("lesen", "auftraege", !a.isError ? "ok" : "fehler", a.isError ? a.text.slice(0, 120) : "abrufbar");
}

async function hintergrund() {
  abschnitt("3. Hintergrunddienste und Einstellungen der Server-AVA");
  const prov = await kopf("settings_get_provider");
  melde("dienste", "Aktiver Modell-Anbieter", prov.ergebnis ? "ok" : "fehler", prov.ergebnis ? `${prov.ergebnis.kind ?? prov.ergebnis.active?.kind ?? JSON.stringify(prov.ergebnis).slice(0, 60)}` : prov.innererFehler ?? prov.text.slice(0, 100));

  const tg = await kopf("telegram_status");
  const tge = tg.ergebnis ?? {};
  const tgOk = tge.hasToken && tge.chatId != null && tge.enabled !== false;
  melde("dienste", "Telegram", tgOk ? "ok" : "fehler", tgOk ? "Bot verbunden, Chat verknüpft" : `Token ${tge.hasToken ? "ja" : "nein"}, Chat ${tge.chatId != null ? "ja" : "nein"}, Zustellung ${tge.enabled ? "an" : "aus"} → Meldungen kommen nicht aufs Handy`);

  const ap = await kopf("alerts_get_prefs");
  const ape = ap.ergebnis ?? {};
  melde("dienste", "Herzschlag/Meldungen", ap.ergebnis ? "ok" : "warn", ap.ergebnis ? `Takt ${ape.heartbeatIntervalMinutes ?? ape.cadenceMinutes ?? "?"} min, Push ${ape.pushEnabled ? "an" : "aus"}, Schwelle ${ape.pushSeverityThreshold ?? "?"}${ape.quietHours ? `, Ruhezeit ${JSON.stringify(ape.quietHours)}` : ""}` : ap.text.slice(0, 100));

  const icp = await kopf("icp_get");
  const icpLeer = !icp.ergebnis || (!icp.ergebnis.beschreibung && !icp.ergebnis.description && !(icp.ergebnis.branchen ?? icp.ergebnis.industries ?? []).length);
  melde("dienste", "Idealkundenprofil (ICP)", icpLeer ? "fehler" : "ok", icpLeer ? "leer → Radar hat nichts, wonach es suchen kann" : "vorhanden");

  const rc = await kopf("radar_config");
  const rce = rc.ergebnis?.config ?? rc.ergebnis ?? {};
  melde("dienste", "Firmen-Radar", rce.enabled ? "ok" : "fehler", rc.ergebnis ? `Automatik ${rce.enabled ? "an" : "aus"}${rce.intervalHours ? `, alle ${rce.intervalHours} h` : ""}${rce.maxOffeneKandidaten != null ? `, Deckel ${rce.maxOffeneKandidaten} offene Kandidaten` : ""}` : rc.innererFehler ?? rc.text.slice(0, 100));
  if (rce.lastOutcome) melde("dienste", "Radar letzter Lauf", /Kein Radar-Scan|Deckel|Fehler/i.test(rce.lastOutcome) ? "warn" : "info", rce.lastOutcome.slice(0, 200));

  const ra = await kopf("radar_activity");
  melde("dienste", "Radar gerade", "info", ra.ergebnis ? JSON.stringify(ra.ergebnis).slice(0, 140) : ra.text.slice(0, 100));

  const dc = await kopf("discovery_candidates", { limit: 5 });
  const dce = dc.ergebnis ?? {};
  const offen = dce.offen ?? dce.total ?? dce.gesamt ?? null;
  melde("dienste", "Radar-Kandidaten (zentral im Gateway)", "info", offen != null ? `${offen} offen` : (dc.daten?.vorschau ?? dc.text.slice(0, 100)));

  const fr = await kopf("freshness_get_prefs");
  melde("dienste", "Auffrischung", fr.ergebnis ? (fr.ergebnis.enabled ? "ok" : "warn") : "warn", fr.ergebnis ? `${fr.ergebnis.enabled ? "an" : "aus"}` : fr.text.slice(0, 100));

  const rd = await kopf("register_delta_status");
  melde("dienste", "Stammdaten mitpflegen", "info", rd.ergebnis ? JSON.stringify(rd.ergebnis).slice(0, 120) : rd.text.slice(0, 100));

  const reach = await kopf("reachability_status");
  melde("dienste", "Register erreichbar", reach.ergebnis ? "ok" : "warn", reach.ergebnis ? JSON.stringify(reach.ergebnis).slice(0, 140) : reach.text.slice(0, 100));

  const stand = await kopf("vorschlaege_status", { frisch: true });
  const vb = stand.ergebnis?.nutzerstand?.verbindungen ?? {};
  for (const [k, v] of Object.entries(vb)) melde("dienste", `Verbindung ${k}`, v === "offen" ? (k === "telegram" || k === "mail" ? "warn" : "info") : "ok", String(v));

  const crm = await kopf("crm_status");
  melde("dienste", "CRM", "info", crm.ergebnis ? JSON.stringify(crm.ergebnis).slice(0, 120) : crm.text.slice(0, 100));

  const wf = await kopf("workflow_list");
  melde("dienste", "Workflows", "info", wf.ergebnis ? `${(wf.ergebnis.workflows ?? []).length} vorhanden` : wf.text.slice(0, 100));

  const sch = await kopf("schedule_list");
  melde("dienste", "Geplante Aufgaben", "info", sch.ergebnis ? `${(sch.ergebnis.jobs ?? sch.ergebnis ?? []).length ?? 0} Einträge` : sch.text.slice(0, 100));

  const ns = stand.ergebnis?.nutzerstand ?? {};
  melde("dienste", "Nutzerstand", "info", `ICP ${ns.icp ?? "?"}, Firmen ${ns.firmen?.anzahl ?? ns.firmenAnzahl ?? "?"}, Radar ${JSON.stringify(ns.radar ?? {}).slice(0, 120)}`);
}

async function rueckfrage() {
  abschnitt("4. Freigabe-Schleife (bricht bewusst ab, ändert nichts)");
  const a = await kopf("vorschlaege_config", { startseite: true });
  const rf = a.daten?.rueckfrage;
  melde("freigabe", "Rückfrage kommt", rf?.token ? "ok" : "fehler", rf ? rf.frage : a.text.slice(0, 100));
  if (!rf?.token) return;
  const b = await werkzeug("werkzeug_ausfuehren", { name: "vorschlaege_config", args: { startseite: true }, _antworten: { [rf.token]: "nein" } });
  const e = b.daten?.ergebnis;
  melde("freigabe", "Antwort „nein“ bricht ab", e?.abgebrochen ? "ok" : "fehler", JSON.stringify(e ?? b.text).slice(0, 100));
}

async function verarbeitung() {
  abschnitt("5. Verarbeitung auf dem Server (Import einer bekannten Firma bis „fertig“)");
  const imp = await werkzeug("import_anlegen", { companyIds: [TEST_FIRMA], name: `Server-Testlauf ${new Date().toISOString().slice(0, 16)}` });
  const tid = imp.daten?.vorgaenge?.[0]?.transactionId;
  melde("verarbeitung", "Import angelegt", tid ? "ok" : "fehler", tid ?? imp.text.slice(0, 120));
  if (!tid) return;
  const start = Date.now();
  let letzter = null;
  while (Date.now() - start < 8 * 60_000) {
    await new Promise((r) => setTimeout(r, 15_000));
    const s = await werkzeug("auftrag_status", { transactionId: tid });
    const f = s.daten?.fortschritt;
    letzter = f;
    if (f && f.firmen > 0 && f.firmenFertig + f.firmenMitFehler >= f.firmen && f.schritte.offen === 0) break;
  }
  if (!letzter) return melde("verarbeitung", "Fortschritt", "fehler", "kein Fortschritt lesbar");
  const s = letzter.schritte;
  const dauer = Math.round((Date.now() - start) / 1000);
  melde("verarbeitung", "Firma verarbeitet", letzter.firmenFertig === letzter.firmen && s.fehlgeschlagen === 0 ? "ok" : s.offen > 0 ? "warn" : "fehler", `${letzter.firmenFertig}/${letzter.firmen} fertig, Schritte ${s.abgeschlossen} ok, ${s.uebersprungen} übersprungen, ${s.fehlgeschlagen} Fehler, ${s.offen} offen (${dauer} s)`);
  for (const f of letzter.fehlerBeispiele ?? []) melde("verarbeitung", `Fehler ${f.producer}`, "warn", f.meldung);
}

async function avaFragen() {
  abschnitt("6. ava_fragen (AVAs eigener Agent, nutzt das Modell des Servers)");
  let r = await werkzeug("ava_fragen", { nachricht: `Fasse in drei Sätzen zusammen, was du über die Firma ${TEST_FIRMA} weißt. Nur lesen, nichts ändern.` });
  let d = r.daten ?? {};
  for (let i = 0; i < 4 && d.status === "laeuft"; i++) {
    r = await werkzeug("ava_fragen", { gespraech: d.gespraech });
    d = r.daten ?? {};
  }
  melde("ava", "Antwort von AVA", d.status === "fertig" && d.antwort ? "ok" : "fehler", d.antwort ? `${d.antwort.slice(0, 160)}…` : r.text.slice(0, 160));
  if (d.werkzeuge) melde("ava", "benutzte Werkzeuge", "info", d.werkzeuge.join(", "));
}

// ---- Ablauf ------------------------------------------------------------------

try {
  TOKEN = await holeToken();
} catch (e) {
  console.error("Anmeldung fehlgeschlagen:", e.message);
  process.exit(2);
}
console.log(`AVA-Server-Testlauf ${new Date().toLocaleString("de-DE")}\nServer ${SERVER}, MCP ${MCP}`);
const verbunden = await infrastruktur();
await gatewayLesen();
if (verbunden) {
  await hintergrund();
  await rueckfrage();
} else {
  abschnitt("3.–4. übersprungen: keine AVA verbunden");
}
if (MIT_VERARBEITUNG) await verarbeitung();
if (MIT_AVA_FRAGEN && verbunden) await avaFragen();

const zaehle = (s) => ergebnisse.filter((e) => e.stufe === s).length;
console.log(`\nErgebnis: ${zaehle("ok")} ok, ${zaehle("warn")} Hinweise, ${zaehle("fehler")} Fehler`);
if (zaehle("fehler")) {
  console.log("\nZu beheben:");
  for (const e of ergebnisse.filter((x) => x.stufe === "fehler")) console.log(`  ✘ ${e.name}: ${e.text}`);
}
void GATEWAY;
process.exit(zaehle("fehler") ? 1 : 0);

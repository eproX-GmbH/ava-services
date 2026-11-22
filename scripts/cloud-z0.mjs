#!/usr/bin/env node
// Z0-Test für docs/PLAN_CLOUD_SELBSTBEDIENUNG.md: Kunden-Instanz NUR über die Fly-Maschinen-API
// (REST, wie später das Gateway), keine fly-CLI. Schritte einzeln aufrufbar, Zustand in
// ~/.ava-instanzen/z0-<app>.json (0600, nie ins Repo).
//
//   FLY_API_TOKEN=… node scripts/cloud-z0.mjs anlegen --org <slug> [--app ava-z0-test] [--version v0.1.976]
//   FLY_API_TOKEN=… node scripts/cloud-z0.mjs status|ip|stoppen|anstossen|starten|messen|maschine-loeschen|neu-anlegen|setup-url
//   FLY_API_TOKEN=… node scripts/cloud-z0.mjs alles-loeschen --bestaetigen
//
// Was geprüft wird: eigenes privates Netz, Volume, Secrets, ein Rechner mit ZWEI Containern
// (AVA + Ollama über localhost), Autostart aus, cordon+stop, ob Anfragen eine gestoppte Maschine
// wecken, Maschine löschen/neu anlegen mit demselben Volume, Speicherbedarf.

import { randomBytes } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, writeFileSync, chmodSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

const API = "https://api.machines.dev/v1";
const TOKEN = process.env.FLY_API_TOKEN;
if (!TOKEN) { console.error("FLY_API_TOKEN fehlt"); process.exit(2); }

const args = process.argv.slice(2);
const befehl = args[0];
const opt = (n, d) => { const i = args.indexOf(`--${n}`); return i >= 0 ? args[i + 1] : d; };
const flag = (n) => args.includes(`--${n}`);

const APP = opt("app", "ava-z0-test");
const DIR = join(homedir(), ".ava-instanzen");
const ZUSTAND = join(DIR, `z0-${APP}.json`);
const OLLAMA_IMAGE = opt("ollama", "ollama/ollama:0.40.5");

const laden = () => (existsSync(ZUSTAND) ? JSON.parse(readFileSync(ZUSTAND, "utf8")) : {});
const speichern = (z) => { mkdirSync(DIR, { recursive: true }); writeFileSync(ZUSTAND, JSON.stringify(z, null, 2)); chmodSync(ZUSTAND, 0o600); };
const log = (...a) => console.log(new Date().toISOString().slice(11, 19), ...a);

async function fly(method, pfad, body, { erlaubt = [] } = {}) {
  const r = await fetch(API + pfad, {
    method,
    headers: { authorization: `Bearer ${TOKEN}`, "content-type": "application/json" },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const text = await r.text();
  let json; try { json = text ? JSON.parse(text) : null; } catch { json = text; }
  if (!r.ok && !erlaubt.includes(r.status)) throw new Error(`${method} ${pfad} → ${r.status}: ${typeof json === "string" ? json.slice(0, 300) : JSON.stringify(json).slice(0, 300)}`);
  return { status: r.status, json };
}

function maschinenConfig(z) {
  return {
    image: z.image,
    guest: { cpu_kind: "shared", cpus: 2, memory_mb: Number(opt("ram", "4096")) },
    // Schicht 1 gegen Selbststart: Neustart nur nach Absturz, nie "always".
    restart: { policy: "on-failure", max_retries: 3 },
    mounts: [{ volume: z.volumeId, path: "/data" }],
    env: {
      AVA_SERVER_BIND: "0.0.0.0",
      AVA_SERVER_PORT: "8080",
      AVA_OLLAMA_HOST: "127.0.0.1",
      AVA_OLLAMA_PORT: "11434",
      AVA_DISABLE_OLLAMA: "0",
      AVA_INSTANZ_NAME: APP,
      AVA_PUBLIC_URL: `https://${APP}.fly.dev`,
      LOGLEVEL: "info",
    },
    services: [{
      protocol: "tcp",
      internal_port: 8080,
      autostart: false, // Schicht 1: Proxy darf nicht wecken (Default wäre true)
      autostop: "off",
      ports: [{ port: 443, handlers: ["tls", "http"] }, { port: 80, handlers: ["http"], force_https: true }],
      checks: [{ type: "http", port: 8080, method: "GET", path: "/healthz", interval: "30s", timeout: "5s", grace_period: "90s" }],
    }],
    containers: [
      {
        name: "ava",
        image: z.image,
        // Bei Containern reicht Fly App-Secrets NICHT automatisch durch (Z0-Befund 2026-11-22).
        secrets: ["AVA_SECRETS_KEY", "AVA_SETUP_TOKEN", "AVA_KONTO"].map((n) => ({ env_var: n, name: n })),
        depends_on: [{ name: "ollama", condition: "started" }],
      },
      {
        name: "ollama",
        image: OLLAMA_IMAGE,
        env: { OLLAMA_HOST: "127.0.0.1:11434", OLLAMA_KEEP_ALIVE: "30m", OLLAMA_MODELS: "/data/ollama" },
      },
    ],
    metadata: { "ava-z0": "1" },
  };
}

async function warte(z, zustand, sek = 120) {
  // Die API erlaubt höchstens 60 s je Warteaufruf.
  const ende = Date.now() + sek * 1000;
  while (Date.now() < ende) {
    const { status, json } = await fly("GET", `/apps/${APP}/machines/${z.machineId}/wait?state=${zustand}&timeout=60`, undefined, { erlaubt: [408, 400] });
    if (status === 200) return json;
  }
  return null;
}

async function maschine(z) {
  const { json } = await fly("GET", `/apps/${APP}/machines/${z.machineId}`);
  return json;
}

const befehle = {
  async anlegen() {
    const org = opt("org");
    if (!org) throw new Error("--org fehlt");
    const z = laden();
    const version = opt("version", z.version ?? "v0.1.976");
    z.version = version;
    z.image = opt("image", `registry.fly.io/ava-server-image:${version}`);
    z.org = org;
    z.network = z.network ?? `${APP}-netz`;
    if (!z.appAngelegt) {
      await fly("POST", "/apps", { name: APP, org_slug: org, network: z.network, idempotency_key: `z0-${APP}` });
      z.appAngelegt = true; speichern(z); log("App angelegt", APP, "Netz", z.network);
    }
    if (!z.secretsGesetzt) {
      await fly("POST", `/apps/${APP}/secrets`, { values: {
        AVA_SECRETS_KEY: randomBytes(32).toString("hex"),
        AVA_SETUP_TOKEN: (z.setupToken = randomBytes(24).toString("base64url")),
        AVA_KONTO: opt("konto", "chatgpt-review@ava.bi"),
      } });
      z.secretsGesetzt = true; speichern(z); log("Secrets gesetzt (Werte nicht ausgegeben)");
    }
    if (!z.volumeId) {
      const { json } = await fly("POST", `/apps/${APP}/volumes`, { name: "ava_data", region: "fra", size_gb: 10, encrypted: true, auto_backup_enabled: false, snapshot_retention: 1 });
      z.volumeId = json.id; speichern(z); log("Volume", z.volumeId);
    }
    if (!z.ipsGesetzt) {
      for (const type of ["shared_v4", "v6"]) await fly("POST", `/apps/${APP}/ip_assignments`, { type }, { erlaubt: [409, 422] });
      z.ipsGesetzt = true; speichern(z); log("IPs: shared_v4 + v6");
    }
    if (!z.machineId) {
      const { json } = await fly("POST", `/apps/${APP}/machines`, { name: "kopf", region: "fra", config: maschinenConfig(z) });
      z.machineId = json.id; speichern(z); log("Maschine", z.machineId, json.state);
    }
    log("warte auf started …");
    await warte(z, "started", 300);
    const m = await maschine(z);
    log("Zustand", m.state, "Image", m.config?.containers?.map((c) => `${c.name}=${c.image}`).join(", ") ?? m.config?.image);
  },

  async status() {
    const z = laden();
    const m = await maschine(z);
    log("Zustand", m.state, "seit", m.updated_at);
    const svc = m.config?.services?.[0] ?? {};
    log("autostart", svc.autostart, "autostop", svc.autostop, "restart", JSON.stringify(m.config?.restart));
    for (const e of (m.events ?? []).slice(0, 8)) log("  Ereignis", new Date(e.timestamp).toISOString().slice(11, 19), e.type, e.status, e.source ?? "");
    const h = await fetch(`https://${APP}.fly.dev/healthz`, { signal: AbortSignal.timeout(8000) }).then(async (r) => `${r.status} ${(await r.text()).slice(0, 120)}`).catch((e) => `nicht erreichbar (${e.name})`);
    log("healthz", h);
  },

  async stoppen() {
    const z = laden();
    // Schicht 2: aus dem Proxy nehmen, dann stoppen.
    if (!flag("ohne-cordon")) await fly("POST", `/apps/${APP}/machines/${z.machineId}/cordon`);
    await fly("POST", `/apps/${APP}/machines/${z.machineId}/stop`, {});
    await warte(z, "stopped", 120);
    z.gestopptAt = new Date().toISOString(); speichern(z);
    log("gestoppt (cordon + stop)", (await maschine(z)).state);
  },

  async anstossen() {
    // Prüft, ob Anfragen von außen eine gestoppte Maschine wecken.
    const z = laden();
    const n = Number(opt("n", "20"));
    for (let i = 0; i < n; i++) {
      const r = await fetch(`https://${APP}.fly.dev/healthz`, { signal: AbortSignal.timeout(4000) }).then((x) => x.status).catch((e) => e.name);
      if (i % 5 === 0) log("Anfrage", i + 1, "→", r);
      await new Promise((res) => setTimeout(res, 1500));
    }
    await new Promise((res) => setTimeout(res, 15000));
    const m = await maschine(z);
    log("nach", n, "Anfragen + 15 s:", m.state, m.state === "stopped" ? "✓ bleibt gestoppt" : "✗ WURDE GEWECKT");
  },

  async "config-neu"() {
    // Aktuelle Konfiguration aus maschinenConfig() auf die laufende Maschine anwenden.
    const z = laden();
    await fly("POST", `/apps/${APP}/machines/${z.machineId}`, { config: maschinenConfig(z) });
    await warte(z, "started", 180);
    log("Konfig neu angewandt", (await maschine(z)).state);
  },

  async "config-aendern"() {
    // Grenzfall aus der Fly-Community: Konfig-Änderung an gestoppter Maschine (skip_launch).
    const z = laden();
    const m = await maschine(z);
    const config = { ...m.config, env: { ...m.config.env, Z0_STAND: new Date().toISOString() } };
    await fly("POST", `/apps/${APP}/machines/${z.machineId}`, { config, skip_launch: true });
    log("Konfig geändert (skip_launch)", (await maschine(z)).state);
  },

  async starten() {
    const z = laden();
    await fly("POST", `/apps/${APP}/machines/${z.machineId}/uncordon`);
    await fly("POST", `/apps/${APP}/machines/${z.machineId}/start`);
    await warte(z, "started", 180);
    log("gestartet", (await maschine(z)).state);
  },

  async messen() {
    const z = laden();
    for (const container of ["ava", "ollama"]) {
      const { json } = await fly("POST", `/apps/${APP}/machines/${z.machineId}/exec`, { command: ["sh", "-c", "cat /sys/fs/cgroup/memory.current 2>/dev/null; cat /sys/fs/cgroup/memory.peak 2>/dev/null; free -m 2>/dev/null | head -2"], container, timeout: 20 }, { erlaubt: [400, 404, 422] });
      log(container, JSON.stringify(json).slice(0, 400));
    }
    const { json } = await fly("POST", `/apps/${APP}/machines/${z.machineId}/exec`, { command: ["sh", "-c", "wget -qO- http://127.0.0.1:11434/api/tags || curl -s http://127.0.0.1:11434/api/tags"], container: "ava", timeout: 20 }, { erlaubt: [400, 404, 422] });
    log("Ollama von AVA aus:", JSON.stringify(json).slice(0, 400));
  },

  async "setup-url"() {
    const z = laden();
    console.log(`https://${APP}.fly.dev/setup?t=${z.setupToken}`);
  },

  async "maschine-loeschen"() {
    // Schicht 4: ohne Maschine kann nichts starten; Volume bleibt.
    const z = laden();
    await fly("DELETE", `/apps/${APP}/machines/${z.machineId}?force=true`, undefined, { erlaubt: [404] });
    z.alteMachineId = z.machineId; delete z.machineId; speichern(z);
    log("Maschine gelöscht, Volume bleibt", z.volumeId);
  },

  async "neu-anlegen"() {
    const z = laden();
    if (z.machineId) throw new Error("Maschine existiert noch");
    const { json } = await fly("POST", `/apps/${APP}/machines`, { name: "kopf", region: "fra", config: maschinenConfig(z) });
    z.machineId = json.id; speichern(z);
    await warte(z, "started", 300);
    log("neu angelegt mit altem Volume", z.machineId, (await maschine(z)).state);
  },

  async "alles-loeschen"() {
    if (!flag("bestaetigen")) throw new Error("--bestaetigen fehlt");
    const z = laden();
    if (z.volumeId) await fly("PUT", `/apps/${APP}/volumes/${z.volumeId}`, { snapshot_retention: 1, auto_backup_enabled: false }, { erlaubt: [404, 400] });
    if (z.machineId) await fly("DELETE", `/apps/${APP}/machines/${z.machineId}?force=true`, undefined, { erlaubt: [404] });
    if (z.volumeId) await fly("DELETE", `/apps/${APP}/volumes/${z.volumeId}`, undefined, { erlaubt: [404] });
    await fly("DELETE", `/apps/${APP}?force=true`, undefined, { erlaubt: [404] });
    speichern({ geloeschtAt: new Date().toISOString(), app: APP });
    log("App, Maschine, Volume gelöscht");
  },
};

const f = befehle[befehl];
if (!f) { console.error(`Befehle: ${Object.keys(befehle).join(", ")}`); process.exit(2); }
f().catch((e) => { console.error("Fehler:", e.message); process.exit(1); });

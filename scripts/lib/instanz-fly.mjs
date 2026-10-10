// Gemeinsame Bausteine der Instanz-Bereitstellung (docs/PLAN_AVA_CLOUD.md §14).
// Alles läuft über die fly-CLI des Operators; Geheimnisse gehen nur als Fly-Secrets
// in die Apps und in eine lokale Notiz unter ~/.ava-instanzen (nie ins Repo).

import { spawnSync } from "node:child_process";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

export const REPO = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
export const DOMAIN = "ava.bi";
export const APP_PREFIX = "ava-i-";
export const IMAGE_APP = "ava-server-image";
export const GETEILTES_OLLAMA = "ava-ollama";
export const NOTIZEN = join(homedir(), ".ava-instanzen");

/** Subdomains, die nie an einen Kunden gehen (bestehende Dienste und Verwechslungsgefahr). */
const RESERVIERT = new Set(["www", "mcp", "api", "app", "auth", "login", "sso", "admin", "gateway", "mail", "status", "docs", "hilfe", "support", "router", "setup", "cloud", "server", "desktop", "test", "staging", "dev"]);

export function args(argv = process.argv.slice(2)) {
  const a = {};
  for (let i = 0; i < argv.length; i++) {
    const k = argv[i];
    if (!k.startsWith("--")) continue;
    const name = k.slice(2);
    const next = argv[i + 1];
    if (next === undefined || next.startsWith("--")) a[name] = true;
    else {
      a[name] = next;
      i++;
    }
  }
  return a;
}

export function slugPruefen(slug) {
  if (typeof slug !== "string" || !/^[a-z0-9](?:[a-z0-9-]{0,38}[a-z0-9])?$/.test(slug)) {
    throw new Error(`Ungültiger Name „${slug}“: nur a–z, 0–9 und Bindestrich, 1–40 Zeichen, nicht mit Bindestrich am Rand.`);
  }
  if (RESERVIERT.has(slug)) throw new Error(`„${slug}“ ist reserviert.`);
  if (slug.endsWith("-ollama")) throw new Error("Namen auf -ollama sind für die Sidecars reserviert.");
  return slug;
}

export const appName = (slug) => `${APP_PREFIX}${slug}`;
export const ollamaApp = (slug) => `${APP_PREFIX}${slug}-ollama`;
export const adresse = (slug) => `https://${slug}.${DOMAIN}`;

export function desktopVersion() {
  return JSON.parse(readFileSync(join(REPO, "services/desktop/package.json"), "utf8")).version;
}

export const imageRef = (version) => `registry.fly.io/${IMAGE_APP}:v${version.replace(/^v/, "")}`;

/** fly-Aufruf; Ausgabe läuft durch, außer `still`. Wirft bei Fehler, außer `darfScheitern`. */
export function fly(argsListe, { still = false, darfScheitern = false, eingabe } = {}) {
  const r = spawnSync("fly", argsListe, { cwd: REPO, encoding: "utf8", stdio: [eingabe === undefined ? "inherit" : "pipe", still ? "pipe" : "inherit", still ? "pipe" : "inherit"], input: eingabe });
  if (r.status !== 0 && !darfScheitern) {
    throw new Error(`fly ${argsListe.filter((x) => !String(x).includes("=")).join(" ")} fehlgeschlagen${still ? `: ${(r.stderr || r.stdout || "").trim().slice(-600)}` : ""}`);
  }
  return { ok: r.status === 0, out: r.stdout ?? "", err: r.stderr ?? "" };
}

export function appExistiert(app) {
  return fly(["status", "-a", app, "--json"], { still: true, darfScheitern: true }).ok;
}

export function alleApps(org) {
  const r = fly(["apps", "list", "--json", ...(org ? ["--org", org] : [])], { still: true });
  return JSON.parse(r.out).map((a) => ({ name: a.Name ?? a.name, org: a.Organization?.Slug ?? a.organization?.slug, status: a.Status ?? a.status }));
}

/** Secrets setzen, ohne Werte auf der Kommandozeile (stdin im KEY=WERT-Format). */
export function secretsSetzen(app, werte, { stage = true } = {}) {
  const zeilen = Object.entries(werte)
    .filter(([, v]) => v !== undefined && v !== null && v !== "")
    .map(([k, v]) => `${k}=${v}`)
    .join("\n");
  fly(["secrets", "import", "-a", app, ...(stage ? ["--stage"] : [])], { eingabe: `${zeilen}\n` });
}

export function tempToml(inhalt) {
  const dir = mkdtempSync(join(tmpdir(), "ava-instanz-"));
  const pfad = join(dir, "fly.toml");
  writeFileSync(pfad, inhalt);
  return pfad;
}

/** fly.toml einer Kunden-Instanz; entspricht services/desktop/fly.server.toml bis auf App, Sidecar und Größe. */
export function instanzToml({ app, region, ollamaHost, speicher, cpus, volumeGb }) {
  return `# Erzeugt von scripts/instanz-anlegen.mjs (docs/PLAN_AVA_CLOUD.md §14).
app = "${app}"
primary_region = "${region}"

[env]
  AVA_SERVER_BIND = "0.0.0.0"
  AVA_SERVER_PORT = "8080"
  AVA_OLLAMA_HOST = "${ollamaHost}"
  AVA_OLLAMA_PORT = "11434"
  AVA_DISABLE_OLLAMA = "0"
  LOGLEVEL = "info"

[http_service]
  internal_port = 8080
  force_https = true
  auto_stop_machines = "off"
  auto_start_machines = false
  min_machines_running = 1
  [http_service.concurrency]
    type = "connections"
    hard_limit = 50
    soft_limit = 25

[[http_service.checks]]
  interval = "30s"
  timeout = "5s"
  grace_period = "90s"
  method = "GET"
  path = "/healthz"

[mounts]
  source = "ava_data"
  destination = "/data"
  initial_size = "${volumeGb}gb"

[[vm]]
  memory = "${speicher}"
  cpu_kind = "shared"
  cpus = ${cpus}
`;
}

/** Ollama-Sidecar einer Instanz (wie infra/fly-ollama/fly.toml), nur im privaten Netz. */
export function ollamaToml({ app, region }) {
  return `# Erzeugt von scripts/instanz-anlegen.mjs (docs/PLAN_AVA_CLOUD.md §14).
app = "${app}"
primary_region = "${region}"

[build]
  image = "ollama/ollama:latest"

[env]
  OLLAMA_HOST = "[::]:11434"
  OLLAMA_KEEP_ALIVE = "30m"

[mounts]
  source = "ollama_models"
  destination = "/root/.ollama"
  initial_size = "5gb"

[[vm]]
  memory = "2gb"
  cpu_kind = "shared"
  cpus = 2
`;
}

export function notizLesen(slug) {
  const p = join(NOTIZEN, `${slug}.json`);
  return existsSync(p) ? JSON.parse(readFileSync(p, "utf8")) : null;
}

export function notizSchreiben(slug, daten) {
  mkdirSync(NOTIZEN, { recursive: true, mode: 0o700 });
  const p = join(NOTIZEN, `${slug}.json`);
  writeFileSync(p, `${JSON.stringify(daten, null, 2)}\n`, { mode: 0o600 });
  chmodSync(p, 0o600);
  return p;
}

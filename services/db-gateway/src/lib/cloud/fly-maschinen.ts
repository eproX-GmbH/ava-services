// Fly-Maschinen-API für die Kunden-Instanzen (docs/PLAN_CLOUD_SELBSTBEDIENUNG.md §3, Z1).
//
// Nur REST (api.machines.dev), keine fly-CLI. Das Token gilt nur für die Fly-Org der
// Kunden-Instanzen (FLY_KUNDEN_ORG, Standard "ava-447") und liegt nur im Gateway, nie in einer
// Kunden-Maschine. Betriebs-Apps (Gateway, Keycloak, Worker) liegen in einer anderen Org und
// sind mit diesem Token nicht erreichbar.
//
// Z0-Befunde (2026-11-22): `wait` höchstens 60 s je Aufruf; Images laden nur aus der eigenen
// Org (→ FLY_KUNDEN_IMAGE_APP); App-Secrets erreichen Container nur, wenn sie je Container
// genannt werden (konfig.ts).

import { AnmeldeStandSchema, type AnmeldeStand } from "./anmeldung";

const API = "https://api.machines.dev/v1";
const REGISTRY = "https://registry.fly.io/v2";

export const kundenOrg = () => process.env.FLY_KUNDEN_ORG?.trim() || "ava-447";
export const kundenImageApp = () => process.env.FLY_KUNDEN_IMAGE_APP?.trim() || "ava-kunden-image";
const token = () => process.env.FLY_KUNDEN_TOKEN?.trim() || "";
export const flyKundenEingerichtet = () => token().length > 0;

export class FlyFehler extends Error {
  constructor(readonly status: number, readonly pfad: string, text: string) {
    super(`Fly ${status} ${pfad}: ${text.slice(0, 300)}`);
  }
}

export interface FlyMaschine {
  id: string;
  state: string;
  config: Record<string, unknown> & { metadata?: Record<string, string>; image?: string };
  instance_id?: string;
  events?: Array<{ type: string; status: string; source?: string; timestamp: number }>;
}

/** Was die Instanz-Logik von Fly braucht; im Test durch eine Attrappe ersetzt. */
export interface FlyKunden {
  appVorhanden(app: string): Promise<boolean>;
  appAnlegen(app: string, netz: string): Promise<void>;
  secretsSetzen(app: string, werte: Record<string, string>): Promise<void>;
  volumeAnlegen(app: string, groesseGb: number): Promise<string>;
  ipsZuweisen(app: string): Promise<void>;
  maschineAnlegen(app: string, config: Record<string, unknown>): Promise<FlyMaschine>;
  /** Konfiguration (z. B. Image) tauschen; Fly startet die Maschine damit neu (Z7). */
  maschineAktualisieren(app: string, id: string, config: Record<string, unknown>): Promise<void>;
  maschineHolen(app: string, id: string): Promise<FlyMaschine | null>;
  cordon(app: string, id: string): Promise<void>;
  uncordon(app: string, id: string): Promise<void>;
  stoppen(app: string, id: string): Promise<void>;
  starten(app: string, id: string): Promise<void>;
  warte(app: string, id: string, zustand: "started" | "stopped", sekunden: number): Promise<boolean>;
  maschineLoeschen(app: string, id: string): Promise<void>;
  volumeLoeschen(app: string, volumeId: string): Promise<void>;
  appLoeschen(app: string): Promise<void>;
  neuesteVersion(): Promise<string | null>;
  /** Alle Apps der Kunden-Org (für die Suche nach Apps ohne Datensatz). */
  appsListe(): Promise<string[]>;
  /** GET /healthz der Instanz (öffentliche fly.dev-Adresse). */
  gesund(app: string): Promise<boolean>;
  /** GET /anmeldung der Instanz (Z4); null = nicht erreichbar oder Image ohne Endpunkt. */
  anmeldung(app: string, token: string): Promise<AnmeldeStand | null>;
}

async function anfrage<T>(methode: string, pfad: string, body?: unknown, erlaubt: number[] = []): Promise<{ status: number; json: T | null }> {
  const t = token();
  if (!t) throw new Error("FLY_KUNDEN_TOKEN fehlt am Gateway.");
  const r = await fetch(API + pfad, {
    method: methode,
    headers: { authorization: `Bearer ${t}`, "content-type": "application/json" },
    body: body === undefined ? undefined : JSON.stringify(body),
    signal: AbortSignal.timeout(75_000),
  });
  const text = await r.text();
  if (!r.ok && !erlaubt.includes(r.status)) throw new FlyFehler(r.status, `${methode} ${pfad}`, text);
  let json: T | null = null;
  try { json = text ? (JSON.parse(text) as T) : null; } catch { json = null; }
  return { status: r.status, json };
}

const versionen = (tags: string[]) =>
  tags.filter((t) => /^v\d+\.\d+\.\d+$/.test(t)).map((t) => t.slice(1)).sort((a, b) => {
    const x = a.split(".").map(Number), y = b.split(".").map(Number);
    for (let i = 0; i < 3; i++) if (x[i] !== y[i]) return (x[i] ?? 0) - (y[i] ?? 0);
    return 0;
  });

let versionGemerkt: { wert: string | null; bis: number } = { wert: null, bis: 0 };

let alleGemerkt: { wert: string[]; bis: number } = { wert: [], bis: 0 };
/** Staging (docs/PLAN_STAGING.md): alle Versionen in der Kunden-Registry (5 Min. gemerkt). */
export async function kundenImageVersionen(): Promise<string[]> {
  if (alleGemerkt.bis > Date.now()) return alleGemerkt.wert;
  const r = await fetch(`${REGISTRY}/${kundenImageApp()}/tags/list`, {
    headers: { authorization: `Basic ${Buffer.from(`x:${token()}`).toString("base64")}` },
    signal: AbortSignal.timeout(10_000),
  });
  if (!r.ok) throw new Error(`Registry ${kundenImageApp()} HTTP ${r.status}`);
  alleGemerkt = { wert: versionen(((await r.json()) as { tags?: string[] }).tags ?? []), bis: Date.now() + 5 * 60_000 };
  return alleGemerkt.wert;
}

export const flyKunden: FlyKunden = {
  async appVorhanden(app) {
    const { status } = await anfrage("GET", `/apps/${app}`, undefined, [404]);
    return status !== 404;
  },
  async appAnlegen(app, netz) {
    // idempotency_key: ein zweiter Versuch nach einem Abbruch liefert dieselbe App.
    await anfrage("POST", "/apps", { name: app, org_slug: kundenOrg(), network: netz, idempotency_key: `ava-cloud-${app}` }, [409, 422]);
  },
  async secretsSetzen(app, werte) {
    await anfrage("POST", `/apps/${app}/secrets`, { values: werte });
  },
  async volumeAnlegen(app, groesseGb) {
    const { json } = await anfrage<{ id: string }>("POST", `/apps/${app}/volumes`, {
      name: "ava_data", region: "fra", size_gb: groesseGb, encrypted: true,
      // Tägliche Sicherung mit kurzer Frist; nach Kündigung bleibt nichts lange liegen (§E7).
      auto_backup_enabled: true, snapshot_retention: 5,
    });
    if (!json?.id) throw new Error("Fly lieferte keine Volume-ID.");
    return json.id;
  },
  async ipsZuweisen(app) {
    // Geteilte IPv4 + IPv6 (kostenlos): nur für /healthz und den Notzugang des Betreibers.
    for (const type of ["shared_v4", "v6"]) await anfrage("POST", `/apps/${app}/ip_assignments`, { type }, [409, 422]);
  },
  async maschineAnlegen(app, config) {
    const { json } = await anfrage<FlyMaschine>("POST", `/apps/${app}/machines`, { name: "kopf", region: "fra", config });
    if (!json?.id) throw new Error("Fly lieferte keine Maschinen-ID.");
    return json;
  },
  async maschineAktualisieren(app, id, config) {
    await anfrage("POST", `/apps/${app}/machines/${id}`, { config });
  },
  async maschineHolen(app, id) {
    const { status, json } = await anfrage<FlyMaschine>("GET", `/apps/${app}/machines/${id}`, undefined, [404]);
    return status === 404 ? null : json;
  },
  async cordon(app, id) { await anfrage("POST", `/apps/${app}/machines/${id}/cordon`); },
  async uncordon(app, id) { await anfrage("POST", `/apps/${app}/machines/${id}/uncordon`); },
  async stoppen(app, id) { await anfrage("POST", `/apps/${app}/machines/${id}/stop`, {}); },
  async starten(app, id) { await anfrage("POST", `/apps/${app}/machines/${id}/start`); },
  async warte(app, id, zustand, sekunden) {
    const ende = Date.now() + sekunden * 1000;
    while (Date.now() < ende) {
      const rest = Math.max(1, Math.min(60, Math.ceil((ende - Date.now()) / 1000)));
      const { status } = await anfrage("GET", `/apps/${app}/machines/${id}/wait?state=${zustand}&timeout=${rest}`, undefined, [408, 400]);
      if (status === 200) return true;
    }
    return false;
  },
  async maschineLoeschen(app, id) { await anfrage("DELETE", `/apps/${app}/machines/${id}?force=true`, undefined, [404]); },
  async volumeLoeschen(app, volumeId) {
    // Erst Sicherungen kurz halten, dann löschen (Snapshots lassen sich nicht einzeln löschen).
    await anfrage("PUT", `/apps/${app}/volumes/${volumeId}`, { snapshot_retention: 1, auto_backup_enabled: false }, [404, 400]);
    await anfrage("DELETE", `/apps/${app}/volumes/${volumeId}`, undefined, [404]);
  },
  async appLoeschen(app) { await anfrage("DELETE", `/apps/${app}?force=true`, undefined, [404]); },
  async appsListe() {
    const { json } = await anfrage<{ apps?: Array<{ name: string }> }>("GET", `/apps?org_slug=${encodeURIComponent(kundenOrg())}`);
    return (json?.apps ?? []).map((a) => a.name);
  },
  async gesund(app) {
    try {
      const r = await fetch(`https://${app}.fly.dev/healthz`, { signal: AbortSignal.timeout(8_000) });
      return r.ok;
    } catch {
      return false;
    }
  },
  async anmeldung(app, tok) {
    try {
      const r = await fetch(`https://${app}.fly.dev/anmeldung`, { headers: { authorization: `Bearer ${tok}` }, signal: AbortSignal.timeout(6_000) });
      if (!r.ok) return null;
      const p = AnmeldeStandSchema.safeParse(await r.json());
      return p.success ? p.data : null;
    } catch {
      return null;
    }
  },
  async neuesteVersion() {
    if (versionGemerkt.bis > Date.now()) return versionGemerkt.wert;
    const fest = process.env.CLOUD_IMAGE_VERSION?.trim().replace(/^v/, "");
    if (fest) return fest;
    const r = await fetch(`${REGISTRY}/${kundenImageApp()}/tags/list`, {
      headers: { authorization: `Basic ${Buffer.from(`x:${token()}`).toString("base64")}` },
      signal: AbortSignal.timeout(10_000),
    });
    if (!r.ok) throw new Error(`Registry ${kundenImageApp()} HTTP ${r.status}`);
    const liste = versionen(((await r.json()) as { tags?: string[] }).tags ?? []);
    versionGemerkt = { wert: liste.at(-1) ?? null, bis: Date.now() + 5 * 60_000 };
    return versionGemerkt.wert;
  },
};

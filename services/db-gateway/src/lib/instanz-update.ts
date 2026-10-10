// Server-Instanzen aus der Admin-Konsole aktualisieren (docs/PLAN_AVA_CLOUD.md §14.5).
// Der Gateway tauscht über die Fly-Maschinen-API nur das Image der Instanz gegen
// eine neuere Version aus `ava-server-image`; die Konfiguration bleibt, wie sie ist.
// Gebaut werden die Images weiter mit scripts/instanz-image.mjs.
//
// Welche Fly-App zu einer Instanz gehört, meldet die AVA selbst (FLY_APP_NAME). Weil
// das gefälscht sein könnte, gilt nur eine App, die der Operator vorgesehen hat
// (Namensregel ava-i-<slug> oder ROUTER_ZUORDNUNG), und eine Kontobindung
// (AVA_KONTO) auf der Maschine muss zum Mitglied passen.

import { logger } from "./logger";

const TOKEN = process.env.FLY_API_TOKEN?.trim() || "";
const MASCHINEN_API = "https://api.machines.dev/v1";
const REGISTRY = "https://registry.fly.io/v2";
const IMAGE_APP = process.env.AVA_IMAGE_APP || "ava-server-image";
const PREFIX = process.env.ROUTER_APP_PREFIX || "ava-i-";
const VORGESEHEN = new Set(
  (process.env.ROUTER_ZUORDNUNG || "")
    .split(",")
    .map((s) => s.split("=")[1]?.trim().toLowerCase())
    .filter((s): s is string => !!s),
);

export const updateEingerichtet = () => TOKEN.length > 0;

/** Darf diese App über die Konsole aktualisiert werden? */
export function appVorgesehen(app: string | null | undefined): app is string {
  if (!app || !/^[a-z0-9-]{3,63}$/.test(app)) return false;
  if (VORGESEHEN.has(app)) return true;
  return app.startsWith(PREFIX) && !app.endsWith("-ollama");
}

/** Fly-App einer Instanz: gemeldet (ab v0.1.804) oder aus dem Standardnamen „Server <app>“ älterer Versionen. */
export function flyAppVon(gemeldet: string | null | undefined, name: string): string | null {
  const app = gemeldet?.trim().toLowerCase() || /^Server (\S+)$/.exec(name.trim())?.[1]?.toLowerCase() || null;
  return appVorgesehen(app) ? app : null;
}

const vergleich = (a: string, b: string) => {
  const x = a.replace(/^v/, "").split(".").map((n) => Number.parseInt(n, 10) || 0);
  const y = b.replace(/^v/, "").split(".").map((n) => Number.parseInt(n, 10) || 0);
  for (let i = 0; i < 3; i++) if ((x[i] ?? 0) !== (y[i] ?? 0)) return (x[i] ?? 0) - (y[i] ?? 0);
  return 0;
};
export const versionNeuer = (a: string, b: string) => vergleich(a, b) > 0;

// Neueste gebaute Version; 5 Minuten gemerkt.
let neueste: { version: string | null; bis: number } = { version: null, bis: 0 };
export async function neuesteVersion(): Promise<string | null> {
  if (!TOKEN) return null;
  if (neueste.bis > Date.now()) return neueste.version;
  try {
    const r = await fetch(`${REGISTRY}/${IMAGE_APP}/tags/list`, {
      headers: { authorization: `Basic ${Buffer.from(`x:${TOKEN}`).toString("base64")}` },
      signal: AbortSignal.timeout(8_000),
    });
    if (!r.ok) throw new Error(`Registry HTTP ${r.status}`);
    const tags = ((await r.json()) as { tags?: string[] }).tags ?? [];
    const versionen = tags.filter((t) => /^v\d+\.\d+\.\d+$/.test(t)).map((t) => t.slice(1));
    const v = versionen.sort(vergleich).at(-1) ?? null;
    neueste = { version: v, bis: Date.now() + 5 * 60_000 };
    return v;
  } catch (err) {
    logger.warn({ err: err instanceof Error ? err.message : String(err) }, "[instanz-update] Registry nicht lesbar");
    neueste = { version: null, bis: Date.now() + 60_000 };
    return null;
  }
}

interface Maschine {
  id: string;
  state: string;
  config: { image?: string; env?: Record<string, string> } & Record<string, unknown>;
}

async function api<T>(pfad: string, init: RequestInit = {}): Promise<T> {
  const r = await fetch(`${MASCHINEN_API}${pfad}`, {
    ...init,
    headers: { authorization: `Bearer ${TOKEN}`, "content-type": "application/json", ...(init.headers ?? {}) },
    signal: init.signal ?? AbortSignal.timeout(30_000),
  });
  const text = await r.text();
  if (!r.ok) throw new Error(`Fly ${init.method ?? "GET"} ${pfad}: HTTP ${r.status} ${text.slice(0, 200)}`);
  return (text ? JSON.parse(text) : {}) as T;
}

export interface UpdateStand {
  app: string;
  von: string;
  ziel: string;
  status: "laeuft" | "fertig" | "fehler";
  meldung: string | null;
  seit: string;
}

// Laufende und letzte Aktualisierungen je App (für die Anzeige in der Konsole).
const staende = new Map<string, UpdateStand>();
export const updateStand = (app: string | null) => (app ? (staende.get(app) ?? null) : null);

/**
 * Startet die Aktualisierung und kehrt sofort zurück; der Stand steht danach in
 * updateStand(app). `konten`: E-Mail und Konto-ID des Mitglieds, dem die Instanz gehört.
 */
export async function aktualisieren(app: string, von: string, ziel: string, konten: Array<string | null>): Promise<UpdateStand> {
  if (!TOKEN) throw new Error("Aktualisieren ist am Gateway nicht eingerichtet (FLY_API_TOKEN fehlt).");
  if (!appVorgesehen(app)) throw new Error("Diese Instanz kann nicht über die Konsole aktualisiert werden.");
  if (staende.get(app)?.status === "laeuft") throw new Error("Die Aktualisierung läuft bereits.");
  const maschinen = (await api<Maschine[]>(`/apps/${app}/machines`)).filter((m) => m.state !== "destroyed");
  if (!maschinen.length) throw new Error("Die Instanz hat keine Maschine.");
  const erlaubt = new Set(konten.filter((k): k is string => !!k).map((k) => k.toLowerCase()));
  for (const m of maschinen) {
    const gebunden = m.config.env?.AVA_KONTO?.trim().toLowerCase();
    if (gebunden && !erlaubt.has(gebunden)) throw new Error("Die Instanz ist an ein anderes Konto gebunden.");
  }
  const image = `registry.fly.io/${IMAGE_APP}:v${ziel}`;
  const stand: UpdateStand = { app, von, ziel, status: "laeuft", meldung: null, seit: new Date().toISOString() };
  staende.set(app, stand);
  void (async () => {
    try {
      for (const m of maschinen) {
        if (m.config.image === image) continue;
        const neu = await api<{ instance_id?: string }>(`/apps/${app}/machines/${m.id}`, { method: "POST", body: JSON.stringify({ config: { ...m.config, image } }) });
        if (m.state === "started") {
          const q = neu.instance_id ? `instance_id=${neu.instance_id}&` : "";
          await api(`/apps/${app}/machines/${m.id}/wait?${q}state=started&timeout=120`, { signal: AbortSignal.timeout(130_000) });
        }
      }
      stand.status = "fertig";
      logger.info({ app, von, ziel }, "[instanz-update] aktualisiert");
    } catch (err) {
      stand.status = "fehler";
      stand.meldung = err instanceof Error ? err.message : String(err);
      logger.warn({ app, ziel, err: stand.meldung }, "[instanz-update] fehlgeschlagen");
    }
  })();
  return stand;
}

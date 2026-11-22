// Maschinen-Konfiguration einer Kunden-Instanz (docs/PLAN_CLOUD_SELBSTBEDIENUNG.md §3, Z0-Ergebnis §8a).
// Reine Funktion, damit Tests sie ohne Fly prüfen können.
//
// Ein Rechner, zwei Container: AVA und Ollama (Embeddings) über localhost, beide auf /data.
// Gegen Selbststart: Proxy-Autostart aus, Neustart nur nach Absturz.

import { kundenImageApp } from "./fly-maschinen";

export const OLLAMA_IMAGE = "ollama/ollama:0.40.5"; // wie main/ollama-pin.ts (nie latest)
/** Secrets, die NUR der AVA-Container bekommt (Fly reicht sie sonst nicht durch). */
export const AVA_SECRETS = ["AVA_SECRETS_KEY", "AVA_SETUP_TOKEN", "AVA_KONTO"] as const;
/** Lesezugriff des Gateways auf GET /anmeldung (Ein-Klick-Bestätigung, Z4); nur wenn gesetzt. */
export const GATEWAY_SECRET = "AVA_GATEWAY_TOKEN";

export const GROESSEN = {
  standard: { cpus: 2, memory_mb: 4096, volumeGb: 10 },
  gross: { cpus: 4, memory_mb: 8192, volumeGb: 20 },
} as const;
export type Groesse = keyof typeof GROESSEN;

export interface KonfigEingabe {
  instanzId: string;
  tenantId: string;
  actorId: string;
  flyApp: string;
  version: string;
  volumeId: string;
  groesse: Groesse;
  /** Secret AVA_GATEWAY_TOKEN ist in der App gesetzt (fehlt bei Instanzen von vor Z4). */
  gatewayToken?: boolean;
}

export function maschinenKonfig(e: KonfigEingabe): Record<string, unknown> {
  const g = GROESSEN[e.groesse] ?? GROESSEN.standard;
  const image = `registry.fly.io/${kundenImageApp()}:v${e.version.replace(/^v/, "")}`;
  return {
    image,
    guest: { cpu_kind: "shared", cpus: g.cpus, memory_mb: g.memory_mb },
    restart: { policy: "on-failure", max_retries: 3 },
    mounts: [{ volume: e.volumeId, path: "/data" }],
    env: {
      AVA_SERVER_BIND: "0.0.0.0",
      AVA_SERVER_PORT: "8080",
      AVA_OLLAMA_HOST: "127.0.0.1",
      AVA_OLLAMA_PORT: "11434",
      AVA_DISABLE_OLLAMA: "0",
      AVA_INSTANZ_NAME: "Cloud",
      AVA_PUBLIC_URL: `https://${e.flyApp}.fly.dev`,
      LOGLEVEL: "info",
    },
    services: [{
      protocol: "tcp",
      internal_port: 8080,
      autostart: false, // Fly-Standard wäre true: Anfragen dürfen eine gestoppte Instanz nie wecken
      autostop: "off",
      ports: [{ port: 443, handlers: ["tls", "http"] }, { port: 80, handlers: ["http"], force_https: true }],
      checks: [{ type: "http", port: 8080, method: "GET", path: "/healthz", interval: "30s", timeout: "5s", grace_period: "90s" }],
    }],
    containers: [
      {
        name: "ava",
        image,
        depends_on: [{ name: "ollama", condition: "started" }],
        secrets: [...AVA_SECRETS, ...(e.gatewayToken ? [GATEWAY_SECRET] : [])].map((n) => ({ env_var: n, name: n })),
      },
      {
        name: "ollama",
        image: OLLAMA_IMAGE,
        env: { OLLAMA_HOST: "127.0.0.1:11434", OLLAMA_KEEP_ALIVE: "30m", OLLAMA_MODELS: "/data/ollama" },
      },
    ],
    // Kontobindung lesbar (anders als Secrets): instanz-update.ts prüft sie vor jedem Image-Tausch.
    metadata: { ava_konto: e.actorId.toLowerCase(), ava_tenant: e.tenantId, ava_instanz: e.instanzId, ava_cloud: "1" },
  };
}

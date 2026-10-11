// Umgebung des Producers. Der Desktop-ProducerSupervisor setzt sie beim Spawn
// (services/desktop/src/main/producer-supervisor.ts, buildEnv); eine eigene
// Datenbank hat company-email nicht — der Zustand liegt am Gateway.

export interface Config {
  amqpUrl: string;
  userId: string;
  tenantId: string;
  gatewayUrl: string;
  gatewayToken: string | null;
  port: number;
  host: string;
  /** Gemeinsame Zaehldatei fuer den Tages-Deckel (mit dem Hintergrund-Job). */
  budgetDatei: string | null;
  tagesDeckel: number;
  /** So lange auf den Persist des Contact-Laufs am Gateway warten. */
  persistWartenMs: number;
}

function zahl(wert: string | undefined, standard: number): number {
  const n = Number(wert);
  return Number.isFinite(n) && n > 0 ? n : standard;
}

export function ladeConfig(env: NodeJS.ProcessEnv = process.env): Config {
  const amqpUrl = env.AMQP_URL;
  if (!amqpUrl) throw new Error("AMQP_URL fehlt (setzt der ProducerSupervisor)");
  return {
    amqpUrl,
    userId: env.AVA_USER_ID ?? "",
    tenantId: env.TENANT_ID ?? env.AVA_TENANT_ID ?? "",
    gatewayUrl: (env.GATEWAY_URL ?? "https://ava-db-gateway.fly.dev").replace(/\/+$/, ""),
    gatewayToken: env.PRODUCER_GATEWAY_TOKEN ?? null,
    port: zahl(env.PORT, 51070),
    host: env.LISTEN_HOST ?? "127.0.0.1",
    budgetDatei: env.AVA_EMAIL_BUDGET_FILE || null,
    tagesDeckel: zahl(env.AVA_EMAIL_TAGES_DECKEL, 50),
    persistWartenMs: zahl(env.AVA_EMAIL_PERSIST_WARTEN_MS, 3 * 60_000),
  };
}

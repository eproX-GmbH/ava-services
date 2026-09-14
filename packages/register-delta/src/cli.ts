#!/usr/bin/env node
// Betreiber-Fallback-Worker (S5) und lokaler Testlauf.
//   GATEWAY_URL            z. B. https://ava-db-gateway.fly.dev
//   WORKER_ID              eindeutig je Maschine (Default: hostname)
//   WORKER_TOKEN           statisches Bearer-Token (Testlauf) ODER
//   KEYCLOAK_TOKEN_URL + KEYCLOAK_CLIENT_ID + KEYCLOAK_CLIENT_SECRET  (Dienstkonto, client_credentials)
//   ABFRAGEN_JE_STUNDE     Default 60
//   CHROME_BIN             optional
//   REGISTER_DELTA_EINMAL=1  nur einen Job ausfuehren (Smoke-Test)

import os from "node:os";
import { GatewayClient } from "./gateway-client";
import { RegisterPortal } from "./portal";
import { RegisterWorker } from "./worker";

function tokenQuelle(): () => Promise<string> {
  if (process.env.WORKER_TOKEN) return async () => process.env.WORKER_TOKEN as string;
  const url = process.env.KEYCLOAK_TOKEN_URL;
  const id = process.env.KEYCLOAK_CLIENT_ID;
  const secret = process.env.KEYCLOAK_CLIENT_SECRET;
  if (!url || !id || !secret) throw new Error("WORKER_TOKEN oder KEYCLOAK_TOKEN_URL/CLIENT_ID/CLIENT_SECRET setzen");
  let cache: { token: string; bis: number } | null = null;
  return async () => {
    if (cache && cache.bis > Date.now() + 30_000) return cache.token;
    const res = await fetch(url, {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({ grant_type: "client_credentials", client_id: id, client_secret: secret }),
    });
    if (!res.ok) throw new Error(`Token-Endpunkt ${res.status}`);
    const j = (await res.json()) as { access_token: string; expires_in: number };
    cache = { token: j.access_token, bis: Date.now() + j.expires_in * 1000 };
    return j.access_token;
  };
}

async function main() {
  const baseUrl = process.env.GATEWAY_URL;
  if (!baseUrl) throw new Error("GATEWAY_URL fehlt");
  const log = (z: string) => console.log(`${new Date().toISOString()} ${z}`);
  const worker = new RegisterWorker({
    workerId: process.env.WORKER_ID ?? `betreiber-${os.hostname()}`,
    workerArt: "betreiber",
    gateway: new GatewayClient({ baseUrl, token: tokenQuelle() }),
    portal: async () => {
      const p = new RegisterPortal({ chromeBinaryPath: process.env.CHROME_BIN, log });
      await p.oeffnen();
      return p;
    },
    abfragenJeStunde: Number(process.env.ABFRAGEN_JE_STUNDE ?? 60),
    log,
    onJob: (job, antwort) => {
      log(`erledigt ${job.id} ${job.art}: ${JSON.stringify(antwort)}`);
      if (process.env.REGISTER_DELTA_EINMAL === "1") void worker.stop();
    },
  });
  const stop = () => {
    log("stop");
    void worker.stop().then(() => process.exit(0));
  };
  process.on("SIGINT", stop);
  process.on("SIGTERM", stop);
  worker.start();
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});

// Headless Server-Einstieg (docs/PLAN_AVA_CLOUD.md §12, Schritt R3).
//
// Dieselbe AVA wie in der Desktop-App, nur ohne Fenster: `bootstrapCore` baut
// die komplette Komposition, `startBackground` startet Producer, Postgres,
// Herzschlag und Co. Bedient wird der Kopf über Telegram (läuft im Kopf) und
// später über das MCP-Relais (§11). Dazu kommen:
//
//   - Anmeldung ohne Fenster über den OAuth 2.0 Device Flow: Adresse und Code
//     stehen im Log und auf GET /setup, bis die Person im Browser bestätigt.
//   - GET /healthz (Prozess lebt), GET /readyz (angemeldet und gestartet),
//     GET /status (Kurzlage als JSON).
//   - SIGTERM/SIGINT: dieselben Stopp-Schritte wie die Beenden-Kette der App.
//
// Umgebung (siehe .env.server.example): AVA_DATA_DIR, AVA_RESOURCES_DIR,
// AVA_SECRETS_KEY, GATEWAY_URL/AUTH_ISSUER/AUTH_CLIENT_ID, AVA_SERVER_PORT,
// AVA_SERVER_BIND, AVA_CHROME_BIN, AVA_OLLAMA_HOST/PORT, AVA_DISABLE_OLLAMA.

declare const __AVA_VERSION__: string | undefined;
if (typeof __AVA_VERSION__ === "string" && !process.env.AVA_VERSION) process.env.AVA_VERSION = __AVA_VERSION__;

import { createServer } from "node:http";
import { bootstrapCore, type Core } from "../core/bootstrap";
import { lifecycle, paths, platform } from "../core/platform";
import { initFileLogger, quitStep, writeLineSync } from "../main/file-logger";
import { beendeVerwaisteBrowser } from "../main/browser-sweep";
import { producerLogBuffer } from "../main/producer-log-buffer";
import type { DeviceFlowCode } from "../main/auth";

type Phase = "start" | "komposition" | "anmeldung" | "laeuft" | "beenden" | "fehler";

const lage: { phase: Phase; fehler: string | null; code: DeviceFlowCode | null; seit: string } = {
  phase: "start",
  fehler: null,
  code: null,
  seit: new Date().toISOString(),
};
let core: Core | null = null;
let beendenLaeuft = false;

function html(body: string): string {
  return `<!doctype html><html lang="de"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>AVA Server</title>
<style>body{font-family:system-ui,sans-serif;max-width:40rem;margin:3rem auto;padding:0 1rem;color:#0A1F2A;background:#F2F7F6}code{font-size:1.4rem;letter-spacing:.1em;background:#fff;padding:.3rem .6rem;border-radius:.4rem}a{color:#00836f}</style></head><body>${body}</body></html>`;
}

function setupSeite(): string {
  const st = core?.auth.getStatus();
  if (st?.signedIn) {
    return html(`<h1>AVA läuft</h1><p>Angemeldet als ${st.email ?? st.name ?? st.actorId ?? "unbekannt"}.</p><p>Phase: ${lage.phase}</p>`);
  }
  if (lage.code) {
    const c = lage.code;
    const link = c.verificationUriComplete ?? c.verificationUri;
    return html(
      `<h1>AVA anmelden</h1><p>Öffne <a href="${link}" target="_blank" rel="noopener">${c.verificationUri}</a> und gib diesen Code ein:</p><p><code>${c.userCode}</code></p><p>Gültig bis ${new Date(c.expiresAt).toLocaleTimeString("de-DE")}. Danach erscheint hier ein neuer Code.</p>`,
    );
  }
  return html(`<h1>AVA startet</h1><p>Phase: ${lage.phase}${lage.fehler ? `<br>Fehler: ${lage.fehler}` : ""}</p><p>Diese Seite neu laden, sobald der Anmelde-Code bereitsteht.</p>`);
}

function statusJson(): Record<string, unknown> {
  const st = core?.auth.getStatus();
  return {
    version: paths().version(),
    phase: lage.phase,
    fehler: lage.fehler,
    seit: lage.seit,
    angemeldet: st?.signedIn ?? false,
    konto: st?.email ?? st?.actorId ?? null,
    producer: core ? core.producers.map((p) => ({ name: p.getStatus().name, state: p.getStatus().state })) : [],
    ollama: core?.ollama.getStatus().state ?? null,
    postgres: core?.postgres.getStatus().state ?? null,
  };
}

function starteHttp(): void {
  const port = Number(process.env.AVA_SERVER_PORT ?? 8080);
  const bind = process.env.AVA_SERVER_BIND ?? "127.0.0.1";
  const server = createServer((req, res) => {
    const url = req.url ?? "/";
    if (url === "/healthz") {
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({ ok: true, phase: lage.phase }));
      return;
    }
    if (url === "/readyz") {
      const bereit = lage.phase === "laeuft" && (core?.auth.getStatus().signedIn ?? false);
      res.writeHead(bereit ? 200 : 503, { "content-type": "application/json" });
      res.end(JSON.stringify({ bereit, phase: lage.phase }));
      return;
    }
    if (url === "/status") {
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify(statusJson()));
      return;
    }
    if (url === "/" || url.startsWith("/setup")) {
      res.writeHead(200, { "content-type": "text/html; charset=utf-8" });
      res.end(setupSeite());
      return;
    }
    res.writeHead(404);
    res.end();
  });
  server.on("error", (err) => console.error("[server] HTTP-Fehler:", err));
  server.listen(port, bind, () => console.log(`[server] http://${bind}:${port}  (/healthz /readyz /status /setup)`));
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
  starteHttp();
  process.on("SIGTERM", () => void beenden("SIGTERM"));
  process.on("SIGINT", () => void beenden("SIGINT"));

  lage.phase = "komposition";
  const c = await bootstrapCore({});
  core = c;
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

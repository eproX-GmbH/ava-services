// Producer company-email (docs/PLAN_EMAIL_VERIFIZIERUNG.md, Variante B).
//
// Laeuft als Node-Subprozess der AVA (ProducerSupervisor, PRODUCER_MODE=compute)
// und wird vom Contact Producer ueber companyContact.createEmailVerification
// angestossen. Je Firma: Domain → Muster (Katalog/KI-Urteil/Gateway) → Muster
// per SMTP bestaetigen → JEDE abgeleitete, zugeordnete und bisher offene
// Adresse einzeln per RCPT TO pruefen (seit 2026-10-12, ohne Tages-Deckel) →
// speichern ueber die Gateway-Routen email-patterns/derived-email. Zustandslos;
// Muster und Catch-all-Befunde liegen geteilt am Gateway.
//
// Der HTTP-Port dient nur dem Health-Probe des Supervisors (TCP-Connect).

import http from "node:http";
import { ladeConfig } from "./config";
import { verbindeBus, type Bus } from "./amqp";
import { makeGatewayClient } from "./gateway";
import { NetzStatus } from "./netz";
import { buildProgressEvent } from "./progress";
import { PROGRESS } from "./routing";
import { makeUrteil } from "./urteil";
import { makeWorker, type TriggerEreignis } from "./worker";
import { leseEinstellungen } from "./einstellungen";
import { logger } from "./log";

function main(): void {
  const cfg = ladeConfig();
  const netz = new NetzStatus();
  const gateway = makeGatewayClient({ url: cfg.gatewayUrl, token: cfg.gatewayToken });
  let bus: Bus | null = null;

  const verarbeite = makeWorker({
    gateway,
    netz,
    urteil: makeUrteil(),
    persistWartenMs: cfg.persistWartenMs,
    einstellungen: () => leseEinstellungen(cfg.einstellungenDatei, cfg.featureAktiv),
    progress: async (p) => {
      if (!bus?.verbunden()) return;
      await bus.publish(PROGRESS, buildProgressEvent(p, cfg.tenantId));
    },
  });

  bus = verbindeBus({
    url: cfg.amqpUrl,
    userId: cfg.userId,
    onNachricht: async (ereignis) => {
      await verarbeite(ereignis as TriggerEreignis);
    },
  });

  // Port 25 gleich beim Start pruefen (sichtbar im Log statt still "offen").
  void netz.aktualisiere().then(() => logger.info(`Port 25: ${netz.ok() ? "erreichbar" : `gesperrt (${netz.grund()})`}`));

  const server = http.createServer((req, res) => {
    const body = JSON.stringify({ ok: true, amqp: bus?.verbunden() ?? false, port25: netz.ok() });
    res.writeHead(req.url === "/health" || req.url === "/" ? 200 : 404, { "content-type": "application/json" });
    res.end(body);
  });
  server.listen(cfg.port, cfg.host, () => logger.info(`Application running at http://${cfg.host}:${cfg.port}`));

  const beenden = (signal: string): void => {
    logger.info(`${signal} — beende`);
    server.close();
    void bus?.schliessen().finally(() => process.exit(0));
  };
  process.on("SIGTERM", () => beenden("SIGTERM"));
  process.on("SIGINT", () => beenden("SIGINT"));
  process.on("uncaughtException", (e) => logger.error(`uncaughtException: ${e instanceof Error ? e.stack ?? e.message : String(e)}`));
  process.on("unhandledRejection", (e) => logger.error(`unhandledRejection: ${e instanceof Error ? e.message : String(e)}`));
}

main();

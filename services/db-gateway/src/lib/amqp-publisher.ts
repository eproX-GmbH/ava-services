// Single shared outbound AMQP client for the gateway (§8.v3 Phase 1.5).
//
// The gateway publishes AMQP events from two paths today:
//   - the gateway-side retry-stage replacements (this file's primary
//     consumer): port of the four localized producers' retry-stage-
//     command logic. Reads the producer's persisted row from MPG,
//     builds the right CloudEvent, publishes here.
//   - (planned) the W23/W24/W25 manual re-scrape endpoints, currently
//     stubbed 501.
//
// Why not one connection per topic: same reason master-data was
// consolidated in §8.v3 — CloudAMQP per-vhost connection cap. Topic
// exchange routing happens per-`publish()`, not per-connection, so
// a single AMQP client publishing under multiple routing keys is
// strictly equivalent to N clients each holding one binding.
//
// Lazy connect: most gateway requests don't trigger a publish (read
// paths dominate). Pay the connect cost on first publish, keep the
// connection warm thereafter. The @ava/event AMQPClient handles
// reconnect on its own.

import { AMQPClient } from "@ava/event";
import { loadEnv } from "./env";
import { logger } from "./logger";

let publisher: AMQPClient | undefined;
let connecting: Promise<AMQPClient> | undefined;

export async function getGatewayAmqpPublisher(): Promise<AMQPClient> {
  if (publisher) return publisher;
  if (connecting) return connecting;

  connecting = (async () => {
    const env = loadEnv();
    const client = new AMQPClient("db-gateway-publisher");
    await client.connect(env.EVENT_BUS_URL);
    await client.assertExchange(env.EVENT_BUS_EXCHANGE);
    publisher = client;
    logger.info(
      { exchange: env.EVENT_BUS_EXCHANGE },
      "amqp-publisher connected",
    );
    return client;
  })();

  try {
    return await connecting;
  } finally {
    connecting = undefined;
  }
}

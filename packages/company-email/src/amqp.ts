// AMQP-Anbindung nach dem Muster der uebrigen Producer: Topic-Exchange
// "exchange", nutzerbezogene Queue mit x-expires/x-message-ttl, Binding
// `companyContact.createEmailVerification.<userId>`, Prefetch 1. Bricht die
// Verbindung ab, verbindet sie sich mit wachsendem Abstand neu.

import amqp from "amqplib";
import { BASE_QUEUE, EXCHANGE, PER_USER_QUEUE_ARGS, TRIGGER, userScopedBindingKey, userScopedQueueName } from "./routing";
import { logger } from "./log";

export interface Bus {
  publish(routingKey: string, event: Record<string, unknown>): Promise<void>;
  verbunden(): boolean;
  schliessen(): Promise<void>;
}

export function verbindeBus(opts: { url: string; userId: string; onNachricht: (ereignis: unknown) => Promise<void> }): Bus {
  const queue = userScopedQueueName(BASE_QUEUE, opts.userId);
  const binding = userScopedBindingKey(TRIGGER, opts.userId);
  let verbindung: amqp.ChannelModel | null = null;
  let kanal: amqp.Channel | null = null;
  let beendet = false;
  let abstand = 2_000;

  async function verbinde(): Promise<void> {
    const conn = await amqp.connect(opts.url);
    const ch = await conn.createChannel();
    await ch.prefetch(1);
    await ch.assertExchange(EXCHANGE, "topic");
    await ch.assertQueue(queue, opts.userId ? { arguments: PER_USER_QUEUE_ARGS } : {});
    await ch.bindQueue(queue, EXCHANGE, binding);
    await ch.consume(queue, (msg) => {
      if (!msg) return;
      let ereignis: unknown = null;
      try {
        ereignis = JSON.parse(msg.content.toString("utf8"));
      } catch {
        logger.error("Nachricht ist kein JSON — verworfen");
      }
      // Ack immer nach der Verarbeitung (wie die anderen Producer): Wiederholung
      // laeuft ueber die Stufen-Wiederholung, nicht ueber Redelivery.
      const fertig = (): void => {
        try {
          ch.ack(msg);
        } catch {
          /* Kanal schon zu */
        }
      };
      if (ereignis === null) return fertig();
      void opts.onNachricht(ereignis).finally(fertig);
    });
    conn.on("error", (e: unknown) => logger.error(`AMQP-Verbindung: ${e instanceof Error ? e.message : String(e)}`));
    conn.on("close", () => {
      verbindung = null;
      kanal = null;
      if (!beendet) neuVerbinden();
    });
    verbindung = conn;
    kanal = ch;
    abstand = 2_000;
    logger.info(`Queue ${queue} gebunden an ${binding} (prefetch=1)`);
  }

  function neuVerbinden(): void {
    const warte = abstand;
    abstand = Math.min(abstand * 2, 60_000);
    logger.info(`AMQP getrennt — neuer Versuch in ${Math.round(warte / 1000)} s`);
    setTimeout(() => {
      verbinde().catch((e: unknown) => {
        logger.error(`AMQP-Verbindung fehlgeschlagen: ${e instanceof Error ? e.message : String(e)}`);
        if (!beendet) neuVerbinden();
      });
    }, warte);
  }

  verbinde().catch((e: unknown) => {
    logger.error(`AMQP-Verbindung fehlgeschlagen: ${e instanceof Error ? e.message : String(e)}`);
    neuVerbinden();
  });

  return {
    async publish(routingKey, event) {
      if (!kanal) throw new Error("AMQP nicht verbunden");
      kanal.publish(EXCHANGE, routingKey, Buffer.from(JSON.stringify(event)));
    },
    verbunden: () => kanal !== null,
    async schliessen() {
      beendet = true;
      await verbindung?.close().catch(() => undefined);
    },
  };
}

// Per-producer observability routes (§8.v3 cosmetics).
//
// `GET /v1/producers/queue-depths` returns the current message-count
// per AMQP queue for the six localized producer subscriptions. The
// desktop's Settings panel polls this every ~10s to surface "X
// messages waiting" alongside each producer's status row.
//
// Read-only, no transaction-scope ownership — the data is
// operationally relevant to whoever has a token. JWT scope alone is
// the gate.

import { OpenAPIHono, createRoute, z } from "@hono/zod-openapi";
import { requireScope } from "../../middleware/auth";
import { getProducerQueueDepths } from "../../lib/queue-depth";

export const producersRouter = new OpenAPIHono();
producersRouter.use("*", requireScope("transaction:read"));

const QueueInfoShape = z
  .object({
    ready: z.number().int().nonnegative(),
    unacked: z.number().int().nonnegative(),
    total: z.number().int().nonnegative(),
    consumers: z.number().int().nonnegative(),
  })
  .openapi("QueueInfo");

const QueueDepthsShape = z
  .object({
    queues: z.record(z.string(), QueueInfoShape),
    /** Convenience map, populated when the queue name maps to a known
     *  producer. The desktop UI keys per-producer status by this. */
    producers: z.record(z.string(), QueueInfoShape),
    fetchedAt: z.string(),
  })
  .openapi("QueueDepths");

const queueDepthsRoute = createRoute({
  method: "get",
  path: "/producers/queue-depths",
  tags: ["producers"],
  summary: "Per-producer AMQP queue depth (§8.v3 cosmetics)",
  description: [
    "Snapshot of `messages_ready` + `messages_unacknowledged` on each",
    "producer's primary AMQP queue. Cached server-side for ~5s — repeat",
    "polls coalesce into one upstream call to the broker management API.",
    "Used by the desktop's Settings panel to render 'X waiting' next to",
    "each producer status row.",
  ].join("\n"),
  responses: {
    200: {
      content: { "application/json": { schema: QueueDepthsShape } },
      description: "current queue depths",
    },
  },
});

// Producer name → AMQP queue name. Mirrors the QUEUE constant each
// producer's compute-worker uses on assertQueue. company-evaluation
// uses ONE primary queue (`upsert-company-evaluation`) for all 8
// inbound routing keys — that's what we report.
const PRODUCER_QUEUE_MAP: Record<string, string> = {
  "company-profile": "upsert-company-profile",
  "structured-content": "upsert-structured-content",
  website: "upsert-website",
  "company-publication": "upsert-company-publication",
  "company-evaluation": "upsert-company-evaluation",
  "company-contact": "upsert-company-contact",
};

producersRouter.openapi(queueDepthsRoute, async (c) => {
  const depths = await getProducerQueueDepths();
  const producers: Record<string, z.infer<typeof QueueInfoShape>> = {};
  for (const [producer, queue] of Object.entries(PRODUCER_QUEUE_MAP)) {
    if (depths[queue]) producers[producer] = depths[queue];
  }
  return c.json(
    {
      queues: depths,
      producers,
      fetchedAt: new Date().toISOString(),
    },
    200,
  );
});

import { OpenAPIHono, z } from "@hono/zod-openapi";
import { streamSSE } from "hono/streaming";
import { requireScope } from "../../middleware/auth";
import { transactionProgressBus } from "../../lib/event-bus";
import { logger } from "../../lib/logger";

// §6 SSE bridge.
//
// Re-emits `transaction.progress` events from the AMQP bus as Server-Sent
// Events to the Desktop-App. The bus subscriber is a process-singleton —
// see lib/event-bus.ts. This handler only owns the per-connection stream.
//
// Lifecycle:
//   - on connect: ensure bus subscription, register a per-stream handler
//   - on each progress event: write SSE if tenant matches caller
//   - on terminal state (completed/failed/cancelled): close the stream
//   - on client disconnect: unsubscribe; do NOT throw
//
// Note: the route is registered as a plain Hono handler (not via
// `createRoute`) because streamSSE's Response type doesn't fit the
// zod-openapi typed-response generic. The endpoint is documented in
// DESKTOP_DATA_FLOW.md §6 — adding it to OpenAPI is a Step 7 hardening item.

export const transactionsRouter = new OpenAPIHono();
transactionsRouter.use("*", requireScope("transaction:read"));

const TransactionEventsParam = z.object({
  transactionId: z.string().min(1),
});

transactionsRouter.get("/transactions/:transactionId/events", async (c) => {
  const params = TransactionEventsParam.safeParse({
    transactionId: c.req.param("transactionId"),
  });
  if (!params.success) {
    return c.json({ error: "invalid_param", detail: params.error.flatten() }, 400);
  }
  const { transactionId } = params.data;
  const auth = c.get("auth");
  const requestId = c.get("requestId");

  // Connect lazily on first SSE request. If the bus is down we surface a
  // 502 — per D11 the gateway is online-only.
  try {
    await transactionProgressBus.ensureConnected();
  } catch (err) {
    logger.error({ err, requestId }, "event-bus connect failed");
    return c.json({ error: "bus_unavailable" }, 502);
  }

  return streamSSE(c, async (stream) => {
    let closed = false;
    const queue: Array<{ event: string; data: string; id: string }> = [];
    let resolveNext: (() => void) | undefined;

    const push = (event: string, data: unknown) => {
      const id = `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
      queue.push({
        id,
        event,
        data: typeof data === "string" ? data : JSON.stringify(data),
      });
      resolveNext?.();
      resolveNext = undefined;
    };

    const unsubscribe = transactionProgressBus.subscribe(transactionId, (payload) => {
      // Tenant gate: drop events that don't belong to caller's tenant.
      if (payload.tenantId !== auth.tenantId) return;
      // Per-row events only (DESKTOP_DATA_FLOW.md §6) — no terminal "end"
      // frame because no service can authoritatively declare a transaction
      // complete (dependency chain may legitimately drop companies).
      // Stream stays open until the client disconnects.
      push("progress", payload);
    });

    stream.onAbort(() => {
      closed = true;
      unsubscribe();
      resolveNext?.();
    });

    // Initial hello so clients know the stream is live.
    await stream.writeSSE({ event: "open", data: JSON.stringify({ transactionId }) });

    // Heartbeat to keep proxies from idling out (fly.io / CDNs).
    const heartbeat = setInterval(() => {
      if (closed) return;
      stream.writeSSE({ event: "ping", data: "" }).catch(() => {
        closed = true;
      });
    }, 25_000);

    try {
      while (!closed || queue.length > 0) {
        if (queue.length === 0) {
          await new Promise<void>((resolve) => {
            resolveNext = resolve;
          });
          continue;
        }
        const next = queue.shift()!;
        await stream.writeSSE(next);
      }
    } finally {
      clearInterval(heartbeat);
      unsubscribe();
    }
  });
});

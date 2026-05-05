// Per-producer AMQP queue depth — used by the desktop's Settings
// panel to surface "messages waiting" alongside each producer's
// status (§8.v3 cosmetics).
//
// We hit CloudAMQP/LavinMQ's management HTTP API rather than
// opening an AMQP channel + checkQueue: the management URL is
// derived from the same `EVENT_BUS_URL` secret the gateway already
// has, no additional creds, and the response includes both `ready`
// (waiting) and `unacked` counts in one shot.
//
// Cached briefly to avoid hammering the management API when the
// Settings panel is open and polling. 5 s TTL is enough for a
// human-readable depth indicator without staleness complaints.

import { loadEnv } from "./env";
import { logger } from "./logger";

interface QueueInfo {
  ready: number;
  unacked: number;
  total: number;
  consumers: number;
}

export type QueueDepths = Record<string, QueueInfo>;

const CACHE_TTL_MS = 5_000;
let cache: { at: number; data: QueueDepths } | undefined;

/**
 * Lazily extract the management HTTPS URL + basic-auth from the
 * AMQP URL the gateway uses for publish/consume. Both URLs share
 * host + credentials + vhost.
 *
 *   amqps://user:pass@kebnekaise.lmq.cloudamqp.com/myvhost
 *   →
 *   { base: "https://kebnekaise.lmq.cloudamqp.com",
 *     vhost: "myvhost",
 *     auth: "user:pass" }
 */
function parseAmqpManagementUrl(): {
  base: string;
  vhost: string;
  auth: string;
} | null {
  const env = loadEnv();
  try {
    const u = new URL(env.EVENT_BUS_URL);
    const auth = `${decodeURIComponent(u.username)}:${decodeURIComponent(u.password)}`;
    const vhost = u.pathname.replace(/^\//, "") || "/";
    return {
      base: `https://${u.host}`,
      vhost,
      auth,
    };
  } catch (err) {
    logger.warn(
      { err: err instanceof Error ? err.message : String(err) },
      "queue-depth: failed to parse EVENT_BUS_URL",
    );
    return null;
  }
}

/**
 * Fetch the LavinMQ-style queues list for our vhost. RabbitMQ
 * shares the same shape — the management plugin is the de-facto
 * standard. Each row has at least name + messages_ready +
 * messages_unacknowledged.
 */
async function fetchAllQueueDepths(): Promise<QueueDepths | null> {
  const cfg = parseAmqpManagementUrl();
  if (!cfg) return null;

  const url = `${cfg.base}/api/queues/${encodeURIComponent(cfg.vhost)}`;
  const res = await fetch(url, {
    method: "GET",
    headers: {
      authorization: `Basic ${Buffer.from(cfg.auth).toString("base64")}`,
      accept: "application/json",
    },
    // Short timeout — management API should respond fast or we'd
    // rather show stale data than block the Settings poll.
    signal: AbortSignal.timeout(3000),
  });
  if (!res.ok) {
    logger.warn(
      { status: res.status, url: url.replace(cfg.auth, "***") },
      "queue-depth: management API non-2xx",
    );
    return null;
  }

  const rows = (await res.json()) as Array<{
    name: string;
    messages_ready?: number;
    messages_unacknowledged?: number;
    messages?: number;
    consumers?: number;
  }>;
  const out: QueueDepths = {};
  for (const r of rows) {
    out[r.name] = {
      ready: r.messages_ready ?? 0,
      unacked: r.messages_unacknowledged ?? 0,
      total:
        r.messages ??
        (r.messages_ready ?? 0) + (r.messages_unacknowledged ?? 0),
      consumers: r.consumers ?? 0,
    };
  }
  return out;
}

export async function getProducerQueueDepths(): Promise<QueueDepths> {
  const now = Date.now();
  if (cache && now - cache.at < CACHE_TTL_MS) return cache.data;

  const fresh = (await fetchAllQueueDepths()) ?? {};
  cache = { at: now, data: fresh };
  return fresh;
}

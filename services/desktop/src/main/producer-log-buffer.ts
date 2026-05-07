// Per-producer in-memory log ring buffer + IPC fan-out source.
//
// ProducerSupervisor pipes child stdout/stderr to console.log today,
// which means the only place to see what a producer is doing is the
// terminal that the .app was launched from. That's fine for me-on-my-
// laptop debugging but useless for a production install.
//
// This buffer collects the same lines into a per-producer ring (cap
// per-producer, total memory bounded), and emits a "line" event for
// each new entry. The renderer's drill-down panel subscribes via IPC
// (see main/index.ts) to render a Logs tab live.
//
// Why a ring (not unbounded): producers can chatter — a single
// captcha-gated company-publication scrape easily drops 200+ lines.
// 6 producers × multi-hour sessions would consume real RAM if
// unbounded. 5000 lines/producer × 6 producers ≈ 3 MB peak.

import { EventEmitter } from "node:events";

const MAX_LINES_PER_PRODUCER = 5000;

export interface ProducerLogLine {
  /** Monotonic id within this process so the renderer can dedupe on
   *  reconnect / fast scroll. */
  id: number;
  /** Wallclock ms. */
  ts: number;
  stream: "stdout" | "stderr";
  text: string;
}

export interface ProducerLogEvent {
  producer: string;
  line: ProducerLogLine;
}

class ProducerLogBuffer extends EventEmitter {
  private buffers: Map<string, ProducerLogLine[]> = new Map();
  private nextId = 1;

  push(producer: string, stream: "stdout" | "stderr", raw: string): void {
    if (!raw) return;
    // amqplib / Selenium / chromedriver all emit multi-line bursts
    // in a single Buffer. Split so the renderer can scroll one line
    // at a time and the filter input matches per-line.
    const lines = raw.split(/\r?\n/);
    for (const line of lines) {
      if (!line) continue;
      const entry: ProducerLogLine = {
        id: this.nextId++,
        ts: Date.now(),
        stream,
        text: line,
      };
      let buf = this.buffers.get(producer);
      if (!buf) {
        buf = [];
        this.buffers.set(producer, buf);
      }
      buf.push(entry);
      if (buf.length > MAX_LINES_PER_PRODUCER) {
        // Drop from the head — keep the most recent. Splice is fine
        // here; the buffer hits the cap once per producer per session
        // and we're not in a tight loop.
        buf.splice(0, buf.length - MAX_LINES_PER_PRODUCER);
      }
      this.emit("line", { producer, line: entry } satisfies ProducerLogEvent);
    }
  }

  /**
   * Return the most recent `limit` lines for `producer`. Used by the
   * renderer when the Logs tab opens — it gets a backfill before
   * subscribing to the "line" event for the live tail.
   */
  tail(producer: string, limit = 500): ProducerLogLine[] {
    const buf = this.buffers.get(producer);
    if (!buf) return [];
    return buf.slice(Math.max(0, buf.length - limit));
  }

  /** Clear a producer's buffer — used when a producer respawns and
   *  the renderer wants a fresh slate. Not currently called; reserved. */
  clear(producer: string): void {
    this.buffers.delete(producer);
  }
}

/** Process-singleton. Imported by ProducerSupervisor (push) and
 *  main/index.ts (IPC handlers + push-to-renderer bridge). */
export const producerLogBuffer = new ProducerLogBuffer();

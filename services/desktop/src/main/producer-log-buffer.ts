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
import { app } from "electron";
import {
  createWriteStream,
  existsSync,
  mkdirSync,
  type WriteStream,
} from "node:fs";
import { join } from "node:path";

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
  // v0.1.163 — Per-producer append-only log file. Mirrors every line
  // the in-memory ring sees. Lives under
  // `<userData>/producer-logs/<name>.log` so users can `tail -f` from
  // a regular Terminal without launching AVA from the shell or going
  // through DevTools.
  private fileStreams: Map<string, WriteStream> = new Map();
  /** Resolved lazily on first push so unit tests that import this
   *  module without Electron's `app` ready don't blow up. */
  private fileLogDirCached: string | null = null;

  private fileLogDir(): string | null {
    if (this.fileLogDirCached) return this.fileLogDirCached;
    try {
      const dir = join(app.getPath("userData"), "producer-logs");
      if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
      this.fileLogDirCached = dir;
      return dir;
    } catch {
      // userData not available (test harness) — silently disable file
      // logging; the in-memory ring still works.
      return null;
    }
  }

  private fileStream(producer: string): WriteStream | null {
    const cached = this.fileStreams.get(producer);
    if (cached) return cached;
    const dir = this.fileLogDir();
    if (!dir) return null;
    try {
      // Append flag so the previous session's tail stays accessible
      // (useful for diagnosing a crash that happened just before a
      // restart). A boot-time session marker keeps things scannable.
      const path = join(dir, `${producer}.log`);
      const stream = createWriteStream(path, { flags: "a" });
      stream.write(
        `\n--- [${new Date().toISOString()}] session start (AVA pid=${process.pid}) ---\n`,
      );
      this.fileStreams.set(producer, stream);
      return stream;
    } catch {
      return null;
    }
  }

  push(producer: string, stream: "stdout" | "stderr", raw: string): void {
    if (!raw) return;
    // amqplib / Selenium / chromedriver all emit multi-line bursts
    // in a single Buffer. Split so the renderer can scroll one line
    // at a time and the filter input matches per-line.
    const lines = raw.split(/\r?\n/);
    const fileTarget = this.fileStream(producer);
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
      // v0.1.163 — file mirror. ISO-prefixed line so `tail -f` users
      // can correlate with other logs. We tag the stream so stderr
      // bursts are visually distinct in plaintext.
      if (fileTarget) {
        const ts = new Date(entry.ts).toISOString();
        const tag = stream === "stderr" ? "ERR" : "OUT";
        fileTarget.write(`${ts} ${tag} ${line}\n`);
      }
      this.emit("line", { producer, line: entry } satisfies ProducerLogEvent);
    }
  }

  /** v0.1.163 — Path of the on-disk log for `producer`, or null if
   *  the file mirror is disabled. Renderer surfaces this so the
   *  "Show in Finder" affordance has a target. */
  filePath(producer: string): string | null {
    const dir = this.fileLogDir();
    if (!dir) return null;
    return join(dir, `${producer}.log`);
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

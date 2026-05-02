import { createServer, type Server, type Socket } from "node:net";
import { EventEmitter } from "node:events";
import { mkdirSync } from "node:fs";
import { join } from "node:path";
import { app } from "electron";
import type {
  PostgresStatus,
  PostgresSupervisorState,
} from "../shared/types";

// Postgres supervisor (Phase 8.v1.0 — PGlite pivot).
//
// Replaces the earlier "spawn a bundled postgres binary" approach,
// which hit a hard wall on macOS: the kernel ships SysV-SHM defaults
// (kern.sysv.shmmax=4MB, kern.sysv.shmall=4MB) too small for
// PostgreSQL's bootstrap, and even a 56-byte shmget returns ENOMEM
// without sudo-level sysctl tuning. PG has needed SysV SHM at
// bootstrap for ~30 years; flag-based workaround does not exist.
//
// We instead embed PGlite — Postgres compiled to WebAssembly — and
// expose it over a TCP socket via `pg-gateway`. The wire protocol is
// identical to a real Postgres server, so producer services keep
// using their existing Prisma+pg stack with a standard
// `postgres://postgres@127.0.0.1:54329/<db>` DATABASE_URL.
//
// Per-database routing: pg-gateway hands us the client's startup
// `database` parameter; we lazy-create one PGlite instance per
// database under userData/pglite/<db-name>/. A connection asking for
// `database=company_profile` and another asking for
// `database=structured_content` get isolated PGlite engines, mirroring
// the per-service Postgres dev compose stack.
//
// Footprint: ~24 MB bundled (PGlite WASM + pg-gateway), vs ~133 MB
// for a portable PG binary. Zero binary signing concerns. Works
// identically on macOS, Windows, Linux without per-OS quirks.

const DEFAULT_HOST = "127.0.0.1";
const DEFAULT_BASE_PORT = 54329;
const PORT_RETRY_LIMIT = 5;
const PG_SERVER_VERSION = "17.0";

export interface PostgresSupervisorOptions {
  host?: string;
  /** Initial port to try; supervisor walks +1 on EADDRINUSE. */
  port?: number;
  /** Override the data root — primarily for tests. */
  dataRoot?: string;
}

export class PostgresSupervisor extends EventEmitter {
  private server: Server | null = null;
  private state: PostgresSupervisorState = "idle";
  private errorMessage: string | null = null;
  private boundPort: number | null = null;
  private dbs = new Map<string, unknown>();
  /** Lazily resolved on first start() to avoid pulling PGlite into the
   *  CommonJS module graph at boot time — keeps cold-start lean. */
  private PGliteCtor: (new (path: string) => PGliteInstance) | null = null;
  private fromNodeSocket: typeof import("pg-gateway/node").fromNodeSocket | null =
    null;

  private readonly host: string;
  private readonly basePort: number;
  private readonly dataRootOverride?: string;

  constructor(opts: PostgresSupervisorOptions = {}) {
    super();
    this.host = opts.host ?? DEFAULT_HOST;
    this.basePort = opts.port ?? DEFAULT_BASE_PORT;
    this.dataRootOverride = opts.dataRoot;
  }

  // ---- Status ---------------------------------------------------------------

  getStatus(): PostgresStatus {
    return {
      state: this.state,
      host:
        this.state === "ready" && this.boundPort !== null
          ? `postgres://postgres@${this.host}:${this.boundPort}`
          : null,
      port: this.boundPort,
      dataDir: this.resolveDataRoot(),
      version: this.state === "ready" ? PG_SERVER_VERSION + " (PGlite/WASM)" : null,
      errorMessage: this.errorMessage,
    };
  }

  private setState(next: PostgresSupervisorState, errorMessage?: string): void {
    this.state = next;
    this.errorMessage =
      errorMessage ?? (next === "error" ? this.errorMessage : null);
    this.emit("status", this.getStatus());
  }

  // ---- Lifecycle ------------------------------------------------------------

  async start(): Promise<void> {
    if (
      this.state === "starting" ||
      this.state === "ready" ||
      this.state === "initializing"
    ) {
      return;
    }
    this.setState("starting");

    if (!this.PGliteCtor || !this.fromNodeSocket) {
      try {
        // Dynamic imports — these packages are ESM-only and pulling
        // them at module top-level breaks the CommonJS bundle that
        // electron-vite emits for main. The runtime cost is paid once
        // at first start() and amortised across the app lifetime.
        const pgliteMod = (await import("@electric-sql/pglite")) as unknown as {
          PGlite: new (path: string) => PGliteInstance;
        };
        this.PGliteCtor = pgliteMod.PGlite;
        const gatewayMod = (await import("pg-gateway/node")) as typeof import(
          "pg-gateway/node"
        );
        this.fromNodeSocket = gatewayMod.fromNodeSocket;
      } catch (err) {
        this.setState(
          "error",
          `failed to load PGlite/pg-gateway: ${err instanceof Error ? err.message : String(err)}`,
        );
        return;
      }
    }

    try {
      mkdirSync(this.resolveDataRoot(), { recursive: true });
    } catch (err) {
      this.setState(
        "error",
        `cannot create data root: ${err instanceof Error ? err.message : String(err)}`,
      );
      return;
    }

    let port = this.basePort;
    let lastError: Error | null = null;
    for (let i = 0; i < PORT_RETRY_LIMIT; i++) {
      try {
        await this.listenOn(port);
        this.boundPort = port;
        this.setState("ready");
        return;
      } catch (err) {
        lastError = err instanceof Error ? err : new Error(String(err));
        if (
          lastError.message.toLowerCase().includes("eaddrinuse") ||
          lastError.message.toLowerCase().includes("address already in use")
        ) {
          port += 1;
          continue;
        }
        break;
      }
    }
    this.setState(
      "error",
      `pg-gateway did not start: ${lastError?.message ?? "unknown"}`,
    );
  }

  async stop(): Promise<void> {
    if (this.state === "idle" || this.state === "error") return;
    if (!this.server) {
      this.setState("idle");
      return;
    }
    this.setState("stopping");
    return new Promise<void>((resolveStop) => {
      const server = this.server!;
      server.close(() => {
        this.server = null;
        this.boundPort = null;
        // Flush all PGlite instances. Their close() persists any
        // in-memory write batches to disk.
        const pending: Promise<void>[] = [];
        for (const db of this.dbs.values()) {
          const close = (db as PGliteInstance).close;
          if (typeof close === "function") {
            try {
              const p = close.call(db);
              if (p && typeof (p as Promise<void>).then === "function") {
                pending.push(p as Promise<void>);
              }
            } catch {
              /* best-effort */
            }
          }
        }
        Promise.allSettled(pending).then(() => {
          this.dbs.clear();
          this.setState("idle");
          resolveStop();
        });
      });
    });
  }

  // ---- Internals ------------------------------------------------------------

  private listenOn(port: number): Promise<void> {
    return new Promise((resolveListen, rejectListen) => {
      const server = createServer((socket) => this.handleConnection(socket));
      server.once("error", (err) => {
        rejectListen(err);
      });
      server.listen(port, this.host, () => {
        this.server = server;
        // Swap the rejection handler for the post-bind error pathway:
        // unhandled connection-time errors should surface as a
        // supervisor `error` state instead of resolving the listen
        // promise twice.
        server.removeAllListeners("error");
        server.on("error", (err) => {
          console.error("[postgres] server error:", err);
        });
        resolveListen();
      });
    });
  }

  private async handleConnection(socket: Socket): Promise<void> {
    if (!this.fromNodeSocket || !this.PGliteCtor) return;
    let activeDb: PGliteInstance | null = null;
    const PGlite = this.PGliteCtor;
    const dataRoot = this.resolveDataRoot();
    const dbs = this.dbs;

    try {
      await this.fromNodeSocket(socket, {
        serverVersion: PG_SERVER_VERSION,
        auth: { method: "trust" },
        onStartup: async (info) => {
          // Database name is the routing key. Default to `postgres`
          // for clients that don't specify one (psql shell, etc.) so
          // they still reach a working DB.
          const dbName = sanitiseDbName(
            info.clientParams?.database ?? "postgres",
          );
          let db = dbs.get(dbName) as PGliteInstance | undefined;
          if (!db) {
            const dir = join(dataRoot, dbName);
            mkdirSync(dir, { recursive: true });
            db = new PGlite(dir);
            // PGlite exposes `waitReady` as a thenable that resolves
            // once the WASM module + persistence layer are warm.
            await db.waitReady;
            dbs.set(dbName, db);
          }
          activeDb = db;
        },
        onMessage: async (msg, { isAuthenticated }) => {
          if (!isAuthenticated || !activeDb) return undefined;
          // execProtocolRaw forwards the raw PostgreSQL wire-protocol
          // bytes to PGlite and returns the response bytes verbatim.
          // pg-gateway pipes them back to the client untouched.
          return activeDb.execProtocolRaw(msg);
        },
      });
    } catch (err) {
      console.warn(
        "[postgres] connection handler crashed:",
        err instanceof Error ? err.message : String(err),
      );
      try {
        socket.destroy();
      } catch {
        /* already closed */
      }
    }
  }

  // ---- Path resolution ------------------------------------------------------

  /**
   * Per-user data root. Each PGlite database gets its own subdir.
   * Lives under userData (Library/Application Support/AVA on macOS;
   * AppData/Roaming/AVA on Windows). Survives app updates.
   */
  private resolveDataRoot(): string {
    if (this.dataRootOverride) return this.dataRootOverride;
    return join(app.getPath("userData"), "pglite");
  }
}

// ---- Helpers ----------------------------------------------------------------

/**
 * Strict whitelist for database names. PGlite uses the value as a
 * directory name on disk, so we refuse path-injection shapes
 * (separators, leading dot) and force lowercase. Producer services
 * pick their own DB name from a fixed set
 * (`company_profile`, `structured_content`, …) — all match this
 * pattern, so this is defence-in-depth, not a constraint anyone
 * trips over.
 */
function sanitiseDbName(raw: string): string {
  const lower = raw.toLowerCase();
  if (!/^[a-z][a-z0-9_]{0,62}$/.test(lower)) return "postgres";
  return lower;
}

// Minimal PGlite shape we actually use — full types come from the
// imported module at runtime; this interface keeps the file
// type-checkable without a top-level `import` of an ESM-only package.
interface PGliteInstance {
  waitReady: Promise<void>;
  execProtocolRaw(msg: Uint8Array): Promise<Uint8Array>;
  close?(): Promise<void> | void;
}

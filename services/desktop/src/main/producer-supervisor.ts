import { spawn, type ChildProcessByStdio } from "node:child_process";
import type { Readable } from "node:stream";
import { EventEmitter } from "node:events";
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { app } from "electron";
import type {
  ProducerStatus,
  ProducerSupervisorState,
} from "../shared/types";

// Producer supervisor (Phase 8.v1.1).
//
// Spawns one of the producer Node services (company-profile,
// structured-content, …) as a child process of the desktop's main
// process. Each producer was originally deployed as a fly.io app;
// for the local-tenant pivot we bundle its dist/ + pruned
// node_modules under `resources/producers/<name>/` and run it via
// `process.execPath` with `ELECTRON_RUN_AS_NODE=1` so Electron's
// own binary acts as a plain Node interpreter (no separate Node
// runtime to bundle).
//
// The supervisor pattern mirrors `OllamaSupervisor` and
// `PostgresSupervisor`:
//
//   - Single instance per producer, constructed at boot
//   - State machine: idle → migrating → starting → ready → error
//     (with a separate `stopping` for graceful shutdown)
//   - `getStatus()` returns the snapshot the renderer mirrors via
//     IPC; status changes fire on the `status` event, broadcast to
//     all windows by main/index.ts
//   - Health-check is a TCP probe of the producer's chosen port
//     (each producer reads its port from `PORT` env)
//
// Migrations: before spawning the producer we run
// `prisma migrate deploy` against the same DATABASE_URL the
// producer will use. PGlite is wire-compatible enough that the
// existing producer-shipped migrations apply cleanly. The migrate
// step is idempotent (Prisma tracks applied rows in a
// `_prisma_migrations` table inside the database) so subsequent
// boots are fast.

const HEALTH_TIMEOUT_MS = 30_000;
const HEALTH_POLL_MS = 500;
const STOP_TIMEOUT_MS = 10_000;

export interface ProducerConfig {
  /** Stable identifier — also the resources/producers/<name>/ subdir. */
  name: string;
  /** Path to the producer entry inside its dist/ tree. */
  entry: string;
  /** PGlite database name to inject into DATABASE_URL. */
  databaseName: string;
  /** TCP port the producer listens on (each producer reads PORT env). */
  port: number;
}

export interface ProducerSupervisorOptions {
  config: ProducerConfig;
  /**
   * PGlite gateway URL prefix: postgres://postgres@127.0.0.1:<port>.
   * Passed as a getter because the actual port is decided by
   * `PostgresSupervisor` at runtime (it walks +1 on EADDRINUSE),
   * so we resolve it on every start() invocation.
   */
  postgresHost: () => string;
  /**
   * AMQP broker URL provider — async because the URL is fetched
   * from the gateway's `/v1/local-amqp-url` endpoint after the
   * user has authenticated. Returns null if the user isn't
   * signed in yet, in which case start() bails to `error` with
   * a helpful message instead of trying to connect to a default
   * unreachable broker.
   */
  amqpUrl: () => Promise<string | null>;
  /** Extra env merged in after the supervisor's defaults. */
  extraEnv?: Record<string, string>;
}

export class ProducerSupervisor extends EventEmitter {
  private child: ChildProcessByStdio<null, Readable, Readable> | null = null;
  private state: ProducerSupervisorState = "idle";
  private errorMessage: string | null = null;
  private exitCode: number | null = null;

  constructor(private readonly opts: ProducerSupervisorOptions) {
    super();
  }

  // ---- Status ---------------------------------------------------------------

  getStatus(): ProducerStatus {
    return {
      name: this.opts.config.name,
      state: this.state,
      port: this.state === "ready" ? this.opts.config.port : null,
      databaseName: this.opts.config.databaseName,
      pid: this.child?.pid ?? null,
      errorMessage: this.errorMessage,
      lastExitCode: this.exitCode,
    };
  }

  private setState(next: ProducerSupervisorState, errorMessage?: string): void {
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
      this.state === "migrating"
    ) {
      return;
    }
    const producerDir = this.resolveProducerDir();
    if (!producerDir) {
      this.setState(
        "error",
        `producer ${this.opts.config.name}: vendored dir not found. Reinstall the app or run \`pnpm fetch:producers\`.`,
      );
      return;
    }

    const env = await this.buildEnv();
    if (!env) {
      // amqpUrl() returned null — user not signed in or gateway
      // unreachable. Skip migrations and producer spawn entirely;
      // the caller (main/index.ts) restarts the supervisor when
      // auth status changes.
      this.setState(
        "error",
        `producer ${this.opts.config.name}: nicht angemeldet — Producer wartet auf Login.`,
      );
      return;
    }

    // 1. Run prisma migrations against the target database. Idempotent
    //    — already-applied migrations are no-ops in `_prisma_migrations`.
    this.setState("migrating");
    try {
      await this.runMigrations(producerDir, env);
    } catch (err) {
      this.setState(
        "error",
        `prisma migrate deploy failed: ${err instanceof Error ? err.message : String(err)}`,
      );
      return;
    }

    // 2. Spawn the producer.
    this.setState("starting");
    const entryPath = join(producerDir, this.opts.config.entry);
    if (!existsSync(entryPath)) {
      this.setState(
        "error",
        `producer entry missing: ${entryPath}`,
      );
      return;
    }

    try {
      this.child = spawn(process.execPath, [entryPath], {
        cwd: producerDir,
        env: { ...env, ELECTRON_RUN_AS_NODE: "1" },
        stdio: ["ignore", "pipe", "pipe"],
      });
    } catch (err) {
      this.setState(
        "error",
        `spawn failed: ${err instanceof Error ? err.message : String(err)}`,
      );
      return;
    }

    this.child.on("error", (err) => {
      const msg = err instanceof Error ? err.message : String(err);
      this.child = null;
      this.setState("error", `failed to launch ${this.opts.config.name}: ${msg}`);
    });

    const tag = `producer:${this.opts.config.name}`;
    this.child.stdout.on("data", (b: Buffer) => {
      console.log(`[${tag}] ${b.toString().trimEnd()}`);
    });
    this.child.stderr.on("data", (b: Buffer) => {
      console.warn(`[${tag}:err] ${b.toString().trimEnd()}`);
    });
    this.child.on("exit", (code, signal) => {
      const wasRunning = this.state === "ready" || this.state === "starting";
      this.child = null;
      this.exitCode = code;
      if (this.state === "stopping") {
        this.setState("idle");
      } else if (wasRunning) {
        this.setState(
          "error",
          `${this.opts.config.name} exited unexpectedly (code=${code ?? "null"}, signal=${signal ?? "null"})`,
        );
      }
    });

    const ok = await this.waitUntilReady();
    if (!ok) {
      this.killChild();
      this.setState(
        "error",
        `${this.opts.config.name} did not become healthy within ${HEALTH_TIMEOUT_MS / 1000}s`,
      );
      return;
    }
    this.setState("ready");
  }

  async stop(): Promise<void> {
    if (this.state === "idle" || this.state === "error") return;
    if (!this.child) {
      this.setState("idle");
      return;
    }
    this.setState("stopping");
    return new Promise<void>((resolveStop) => {
      const child = this.child;
      if (!child) {
        this.setState("idle");
        resolveStop();
        return;
      }
      const timer = setTimeout(() => {
        if (this.child) {
          try {
            this.child.kill("SIGKILL");
          } catch {
            /* already gone */
          }
        }
      }, STOP_TIMEOUT_MS);
      child.once("exit", () => {
        clearTimeout(timer);
        this.child = null;
        this.setState("idle");
        resolveStop();
      });
      try {
        child.kill("SIGTERM");
      } catch {
        /* exit listener cleans up */
      }
    });
  }

  // ---- Internals ------------------------------------------------------------

  /**
   * Apply Prisma-format SQL migrations directly to the producer's
   * database via the `pg` driver — no Prisma CLI subprocess.
   *
   * Why hand-rolled instead of `prisma migrate deploy`:
   *   - PGlite's wire-protocol implementation doesn't fully match
   *     real Postgres around prepared-statement reuse. Prisma's
   *     migration engine uses statement names like "s1" and reuses
   *     them across queries; against PGlite the second use raises
   *     "prepared statement s1 already exists" and migrate aborts.
   *   - Dropping the prisma CLI from the runtime bundle saves ~50 MB.
   *   - Idempotent via our own `_ava_migrations` tracking table —
   *     same shape as Prisma's `_prisma_migrations` but written by
   *     us, so the tracking is guaranteed to live in the same DB
   *     the migrations target.
   *
   * Migration source: `<producerDir>/prisma/migrations/<id>/migration.sql`
   * — this is what `prisma migrate dev` produces, vendored verbatim.
   * We sort by directory name (timestamp prefix) and apply in order.
   * Each migration runs as a single multi-statement `query()` call;
   * PGlite supports multi-statement strings on the simple-query
   * protocol path, which avoids the prepared-statement collision.
   */
  private async runMigrations(
    producerDir: string,
    env: NodeJS.ProcessEnv,
  ): Promise<void> {
    const migrationsDir = join(producerDir, "prisma", "migrations");
    if (!existsSync(migrationsDir)) {
      // Producer ships no migrations — nothing to do.
      return;
    }
    const databaseUrl = env.DATABASE_URL;
    if (!databaseUrl) {
      throw new Error("DATABASE_URL not set in producer env");
    }

    // Dynamic import — `pg` is ESM-friendly but bundled as CJS.
    // Loading it lazily keeps the supervisor's cold-start cheap if
    // the producer never starts.
    const { Client } = (await import("pg")) as typeof import("pg");
    const client = new Client({ connectionString: databaseUrl });
    await client.connect();
    const tag = `producer:${this.opts.config.name}:migrate`;
    try {
      await client.query(`
        CREATE TABLE IF NOT EXISTS _ava_migrations (
          id          text        PRIMARY KEY,
          applied_at  timestamptz NOT NULL DEFAULT now()
        );
      `);

      // Backfill: if a Prisma-managed `_prisma_migrations` table
      // already exists from a previous build that ran
      // `prisma migrate deploy` (v0.1.13/v0.1.14 lineage), pull its
      // applied migration names into `_ava_migrations`. Without
      // this, the SQL apply path below sees an empty tracking
      // table and tries to re-apply migrations that already left
      // CREATE TYPE / CREATE TABLE artefacts on disk, which fails
      // with "<x> already exists".
      const prismaTracking = await client.query<{ exists: boolean }>(
        `SELECT EXISTS (
           SELECT 1 FROM information_schema.tables
           WHERE table_schema = 'public' AND table_name = '_prisma_migrations'
         ) AS exists`,
      );
      if (prismaTracking.rows[0]?.exists) {
        console.log(
          `[${tag}] backfilling _ava_migrations from existing _prisma_migrations…`,
        );
        await client.query(`
          INSERT INTO _ava_migrations (id, applied_at)
          SELECT migration_name, COALESCE(finished_at, started_at, now())
          FROM _prisma_migrations
          WHERE finished_at IS NOT NULL
          ON CONFLICT (id) DO NOTHING;
        `);
      }

      const entries = readdirSync(migrationsDir, { withFileTypes: true });
      const dirs = entries
        .filter((e) => e.isDirectory())
        .map((e) => e.name)
        .sort(); // timestamp prefix sorts chronologically

      for (const id of dirs) {
        const sqlPath = join(migrationsDir, id, "migration.sql");
        if (!existsSync(sqlPath)) continue;

        const exists = await client.query(
          "SELECT 1 FROM _ava_migrations WHERE id = $1",
          [id],
        );
        if (exists.rows.length > 0) {
          continue; // already applied
        }

        console.log(`[${tag}] applying ${id}…`);
        const sql = readFileSync(sqlPath, "utf8");
        try {
          await client.query(sql);
        } catch (err) {
          throw new Error(
            `migration ${id} failed: ${err instanceof Error ? err.message : String(err)}`,
          );
        }
        await client.query(
          "INSERT INTO _ava_migrations (id) VALUES ($1)",
          [id],
        );
        console.log(`[${tag}] ✓ ${id}`);
      }
    } finally {
      await client.end();
    }
  }

  /**
   * Resolve the runtime env for the producer subprocess. Returns
   * null if the AMQP URL provider couldn't supply one (typically:
   * user signed out, or `/v1/local-amqp-url` is unreachable). The
   * caller treats null as a soft-failure → state="error" with a
   * "wait for login" message → restart on auth-changed event.
   */
  private async buildEnv(): Promise<NodeJS.ProcessEnv | null> {
    const amqpUrl = await this.opts.amqpUrl();
    if (!amqpUrl) return null;
    return {
      ...process.env,
      // Per-producer database routing. PGlite gateway lazy-creates
      // the database on first connect.
      DATABASE_URL: `${this.opts.postgresHost()}/${this.opts.config.databaseName}`,
      DIRECT_URL: `${this.opts.postgresHost()}/${this.opts.config.databaseName}`,
      AMQP_URL: amqpUrl,
      PORT: String(this.opts.config.port),
      LOGLEVEL: process.env.LOGLEVEL ?? "info",
      NODE_ENV: app.isPackaged ? "production" : "development",
      ...(this.opts.extraEnv ?? {}),
    };
  }

  private async waitUntilReady(): Promise<boolean> {
    const deadline = Date.now() + HEALTH_TIMEOUT_MS;
    while (Date.now() < deadline) {
      if (await this.probePort()) return true;
      await sleep(HEALTH_POLL_MS);
    }
    return false;
  }

  private async probePort(): Promise<boolean> {
    return new Promise<boolean>((resolveProbe) => {
      // eslint-disable-next-line @typescript-eslint/no-require-imports
      const net = require("node:net") as typeof import("node:net");
      const socket = new net.Socket();
      socket.setTimeout(500);
      socket.once("connect", () => {
        socket.destroy();
        resolveProbe(true);
      });
      socket.once("error", () => resolveProbe(false));
      socket.once("timeout", () => {
        socket.destroy();
        resolveProbe(false);
      });
      socket.connect(this.opts.config.port, "127.0.0.1");
    });
  }

  private killChild(): void {
    if (!this.child) return;
    try {
      this.child.kill("SIGKILL");
    } catch {
      /* already gone */
    }
    this.child = null;
  }

  // ---- Path resolution ------------------------------------------------------

  private resolveProducerDir(): string | null {
    // Packaged: <resourcesPath>/producers/<name>/
    if (app.isPackaged) {
      const packaged = join(
        process.resourcesPath,
        "producers",
        this.opts.config.name,
      );
      if (existsSync(packaged)) return packaged;
      return null;
    }
    // Dev: alongside the desktop's resources/ — vendored locally
    // by `pnpm fetch:producers`.
    const dev = join(
      app.getAppPath(),
      "resources",
      "producers",
      this.opts.config.name,
    );
    if (existsSync(dev)) return dev;
    return null;
  }
}

// ---- Helpers ----------------------------------------------------------------

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

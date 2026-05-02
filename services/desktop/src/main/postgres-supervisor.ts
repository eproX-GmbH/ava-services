import { spawn, type ChildProcessByStdio } from "node:child_process";
import type { Readable } from "node:stream";
import { EventEmitter } from "node:events";
import { existsSync, mkdirSync } from "node:fs";
import { join, dirname } from "node:path";
import { app } from "electron";
import type {
  PostgresStatus,
  PostgresSupervisorState,
} from "../shared/types";

// Postgres supervisor (Phase 8.v1.0).
//
// Spawns the bundled portable PostgreSQL 17 binary as a child process
// listening on 127.0.0.1:<port>, manages a per-app data directory under
// `userData/postgres-data/`, and exposes a small surface (start, stop,
// getStatus) the rest of the app uses to wait for the local DB before
// the producer subprocesses are spawned.
//
// Why a class with EventEmitter (same justification as OllamaSupervisor):
// the renderer pushes status updates via webContents.send. A single
// instance constructed once in main/index.ts is the source of truth.
//
// Binary layout — Zonky's portable Postgres ships:
//
//   resources/postgres/<platform>-<arch>/
//     bin/
//       postgres            ← what we spawn for runtime
//       initdb              ← run once on first launch
//       pg_ctl              ← used for graceful stop
//     lib/
//     share/
//
// Data directory: created by `initdb` on first run under
// `app.getPath("userData")/postgres-data/`. Survives app updates;
// nuking it requires the user to consciously click "Reset local data"
// (a future Settings action). The initdb-output PG_VERSION file is our
// "is this dir initialized" sentinel.
//
// Port: not the standard 5432 — that often collides with a system
// Postgres a developer or DBA already runs. We pick a high ephemeral
// port (54329) deterministically. If it's already taken on launch,
// the supervisor will retry on `port + 1` up to 5 times before
// giving up.

const DEFAULT_HOST = "127.0.0.1";
const DEFAULT_BASE_PORT = 54329;
const PORT_RETRY_LIMIT = 5;
const HEALTH_TIMEOUT_MS = 30_000;
const HEALTH_POLL_MS = 250;
const STOP_TIMEOUT_MS = 10_000;

export interface PostgresSupervisorOptions {
  host?: string;
  /** Override the binary directory lookup entirely (tests). */
  binDir?: string;
  /** Override the data directory — primarily for tests. */
  dataDir?: string;
  /** Initial port to try; supervisor walks +1 on EADDRINUSE. */
  port?: number;
}

export class PostgresSupervisor extends EventEmitter {
  private child: ChildProcessByStdio<null, Readable, Readable> | null = null;
  private state: PostgresSupervisorState = "idle";
  private errorMessage: string | null = null;
  private boundPort: number | null = null;
  private serverVersion: string | null = null;

  private readonly host: string;
  private readonly basePort: number;
  private readonly binDirOverride?: string;
  private readonly dataDirOverride?: string;

  constructor(opts: PostgresSupervisorOptions = {}) {
    super();
    this.host = opts.host ?? DEFAULT_HOST;
    this.basePort = opts.port ?? DEFAULT_BASE_PORT;
    this.binDirOverride = opts.binDir;
    this.dataDirOverride = opts.dataDir;
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
      dataDir: this.resolveDataDir(),
      version: this.serverVersion,
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
    if (this.state === "starting" || this.state === "ready" || this.state === "initializing") {
      return;
    }

    const binDir = this.resolveBinDir();
    if (!binDir) {
      this.setState(
        "error",
        "Postgres binary not found. Reinstall the app or set AVA_POSTGRES_BIN_DIR.",
      );
      return;
    }

    const exeSuffix = process.platform === "win32" ? ".exe" : "";
    const postgresBin = join(binDir, `postgres${exeSuffix}`);
    const initdbBin = join(binDir, `initdb${exeSuffix}`);
    const pgCtlBin = join(binDir, `pg_ctl${exeSuffix}`);

    if (!existsSync(postgresBin) || !existsSync(initdbBin) || !existsSync(pgCtlBin)) {
      this.setState(
        "error",
        `Postgres binaries incomplete in ${binDir} (need postgres, initdb, pg_ctl).`,
      );
      return;
    }

    // Read version once for the status payload — cheap, deterministic,
    // independent of whether initdb has been run yet.
    if (!this.serverVersion) {
      try {
        const out = await runAndCapture(postgresBin, ["--version"]);
        // "postgres (PostgreSQL) 17.5"
        const match = out.match(/(\d+(?:\.\d+)+)/);
        this.serverVersion = (match ? match[1] : out.trim()) ?? null;
      } catch {
        /* leave null; not fatal for startup */
      }
    }

    const dataDir = this.resolveDataDir();
    try {
      mkdirSync(dirname(dataDir), { recursive: true });
    } catch {
      /* surfaced below if it actually mattered */
    }

    // Initdb on first launch. Sentinel: PG_VERSION inside the data dir.
    // Postgres refuses to start without an initialized cluster, so this
    // step is mandatory. ~5s on a Mac the first time.
    const sentinel = join(dataDir, "PG_VERSION");
    if (!existsSync(sentinel)) {
      this.setState("initializing");
      try {
        // --auth-local=trust + --auth-host=trust: we're loopback-only and
        // the bundled instance has no remote exposure. The producer
        // services connect with a fixed `postgres` superuser without
        // password. Future hardening: random-per-machine password stored
        // via safeStorage and injected into producer env. Not critical
        // for v0 because anyone with read access to userData/postgres-data
        // already has the database files anyway.
        await runAndCapture(initdbBin, [
          "-D",
          dataDir,
          "--username=postgres",
          "--auth-local=trust",
          "--auth-host=trust",
          "--encoding=UTF8",
          "--locale=C",
        ]);
      } catch (err) {
        this.setState(
          "error",
          `initdb failed: ${err instanceof Error ? err.message : String(err)}`,
        );
        return;
      }
    }

    // Pick a free port, walking up from basePort.
    let port = this.basePort;
    let lastError: Error | null = null;
    for (let i = 0; i < PORT_RETRY_LIMIT; i++) {
      this.setState("starting");
      try {
        await this.spawnPostgres(postgresBin, dataDir, port);
        this.boundPort = port;
        await this.waitUntilReady(pgCtlBin, dataDir);
        this.setState("ready");
        return;
      } catch (err) {
        lastError = err instanceof Error ? err : new Error(String(err));
        this.killChild();
        if (lastError.message.toLowerCase().includes("address already in use")) {
          port += 1;
          continue;
        }
        break;
      }
    }
    this.setState(
      "error",
      `postgres did not start: ${lastError?.message ?? "unknown"}`,
    );
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
        // Force-kill if graceful stop doesn't land in time. Postgres
        // is normally well-behaved on SIGTERM, but if the WAL is busy
        // it can take a few seconds.
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
        this.boundPort = null;
        this.setState("idle");
        resolveStop();
      });
      try {
        child.kill("SIGTERM");
      } catch {
        // Process already dead. The exit listener will fire.
      }
    });
  }

  // ---- Internals ------------------------------------------------------------

  private spawnPostgres(
    postgresBin: string,
    dataDir: string,
    port: number,
  ): Promise<void> {
    return new Promise((resolveSpawn, rejectSpawn) => {
      const args = [
        "-D",
        dataDir,
        "-p",
        String(port),
        "-h",
        this.host,
        // Disable unix socket — we're loopback-only by design and on
        // some macOS sandbox setups /tmp isn't writable from inside the
        // packaged app. TCP-only keeps the connection model uniform.
        "-c",
        "unix_socket_directories=",
        // Quiet down the log to stderr; we forward it to console.
        "-c",
        "log_min_messages=warning",
      ];
      try {
        this.child = spawn(postgresBin, args, {
          stdio: ["ignore", "pipe", "pipe"],
        });
      } catch (err) {
        rejectSpawn(err instanceof Error ? err : new Error(String(err)));
        return;
      }

      this.child.on("error", (err) => {
        const msg = err instanceof Error ? err.message : String(err);
        this.child = null;
        rejectSpawn(new Error(`spawn failed: ${msg}`));
      });

      this.child.stdout.on("data", (b: Buffer) => {
        console.log(`[postgres] ${b.toString().trimEnd()}`);
      });
      this.child.stderr.on("data", (b: Buffer) => {
        const line = b.toString().trimEnd();
        console.warn(`[postgres:err] ${line}`);
        // Detect the most common boot failure: another process owns
        // the port. Surface it through reject so start() can pick a
        // different port.
        if (line.toLowerCase().includes("could not bind ipv4 socket")
          || line.toLowerCase().includes("address already in use")) {
          rejectSpawn(new Error("address already in use"));
        }
      });

      this.child.on("exit", (code, signal) => {
        const wasRunning = this.state === "ready" || this.state === "starting";
        this.child = null;
        if (this.state === "stopping") {
          this.setState("idle");
        } else if (wasRunning) {
          this.setState(
            "error",
            `postgres exited unexpectedly (code=${code ?? "null"}, signal=${signal ?? "null"})`,
          );
        }
      });

      // We can't tell from spawn alone that postgres is up — only
      // pg_isready can. Resolve the spawn promise immediately; the
      // caller's waitUntilReady() handles the readiness gate.
      resolveSpawn();
    });
  }

  private async waitUntilReady(pgCtlBin: string, dataDir: string): Promise<void> {
    const deadline = Date.now() + HEALTH_TIMEOUT_MS;
    let lastErr = "no probe yet";
    while (Date.now() < deadline) {
      try {
        // pg_ctl status -D <dir> exits 0 if the postmaster is running.
        // Combined with our spawn check, that's enough to call it ready.
        await runAndCapture(pgCtlBin, ["status", "-D", dataDir]);
        // Belt-and-braces: also probe the loopback port. pg_ctl's
        // "running" message can come a moment before postmaster has
        // bound the socket.
        if (await this.probePort()) return;
      } catch (err) {
        lastErr = err instanceof Error ? err.message : String(err);
      }
      await sleep(HEALTH_POLL_MS);
    }
    throw new Error(`pg_isready timeout: ${lastErr}`);
  }

  private async probePort(): Promise<boolean> {
    if (this.boundPort === null) return false;
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
      socket.connect(this.boundPort!, this.host);
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

  private resolveBinDir(): string | null {
    if (this.binDirOverride) return this.binDirOverride;

    const fromEnv = process.env.AVA_POSTGRES_BIN_DIR;
    if (fromEnv && existsSync(join(fromEnv, `postgres${process.platform === "win32" ? ".exe" : ""}`))) {
      return fromEnv;
    }

    const platformDir = `${process.platform}-${process.arch}`;

    // Packaged: <resourcesPath>/postgres/<platform>-<arch>/bin
    if (app.isPackaged) {
      const packaged = join(process.resourcesPath, "postgres", platformDir, "bin");
      if (existsSync(packaged)) return packaged;
      return null;
    }

    // Dev: alongside the repo's resources/ folder.
    const devCandidate = join(
      app.getAppPath(),
      "resources",
      "postgres",
      platformDir,
      "bin",
    );
    if (existsSync(devCandidate)) return devCandidate;

    return null;
  }

  /**
   * Per-user data directory. Lives under userData (Library/Application
   * Support/AVA on macOS; AppData/Roaming/AVA on Windows). Shared
   * across app updates — only a deliberate "Reset local data" Settings
   * action should wipe it.
   */
  private resolveDataDir(): string {
    if (this.dataDirOverride) return this.dataDirOverride;
    return join(app.getPath("userData"), "postgres-data");
  }
}

// ---- Helpers ----------------------------------------------------------------

function runAndCapture(cmd: string, args: string[]): Promise<string> {
  return new Promise((resolveRun, rejectRun) => {
    const child = spawn(cmd, args, { stdio: ["ignore", "pipe", "pipe"] });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (b) => (stdout += b.toString()));
    child.stderr.on("data", (b) => (stderr += b.toString()));
    child.on("error", rejectRun);
    child.on("exit", (code) => {
      if (code === 0) resolveRun(stdout);
      else rejectRun(new Error(`${cmd} exited ${code}: ${stderr.trim() || stdout.trim()}`));
    });
  });
}

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

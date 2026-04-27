import { spawn, type ChildProcessByStdio } from "node:child_process";
import type { Readable } from "node:stream";
import { EventEmitter } from "node:events";
import { existsSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { app } from "electron";
import type {
  OllamaInstalledModel,
  OllamaPullProgress,
  OllamaStatus,
  OllamaSupervisorState,
} from "../shared/types";
import { REQUIRED_MODELS, missingModels } from "./ollama-models";

// Ollama supervisor (D7).
//
// Spawns the bundled `ollama serve` binary as a child process, health-checks
// it on a loopback port, and exposes a small surface (status, pull, stop)
// for the rest of the app via IPC.
//
// Why a class with EventEmitter rather than module-level state: the renderer
// pushes status updates via `webContents.send`, and we want a single source
// of truth that ipcMain handlers can subscribe to and broadcast from. The
// instance is constructed once in main/index.ts.
//
// Binary discovery rules (most → least specific):
//   1. `OLLAMA_BIN` env var (devs override during local testing)
//   2. Packaged: `<resourcesPath>/ollama/<platform>-<arch>/ollama[.exe]`
//      (electron-builder copies this from `resources/ollama/<…>` per
//      `extraResources` in electron-builder.yml)
//   3. Dev (electron-vite): `<repoRoot>/services/desktop/resources/ollama/<…>`
//   4. Fallback: a system-installed `ollama` on PATH (developers who already
//      run Ollama locally — the dev-mode default)
//
// We do NOT silently fall back to PATH in packaged builds: if the bundled
// binary is missing the supervisor moves to `error` state and the renderer
// surfaces a "broken installation, please reinstall" screen. Otherwise a
// half-working build would silently drift to whatever Ollama version the
// user had pre-installed (defeats the "App garantiert eine getestete
// Ollama-Version" rationale of D7).
//
// Process model: one `ollama serve` per app instance, listening on
// 127.0.0.1:11434 by default. Multiple Electron instances on the same host
// would collide on the port — a future "another AVA instance is running"
// detection is a separate concern and not needed for v0.

const DEFAULT_HOST = "127.0.0.1";
const DEFAULT_PORT = 11434;
const HEALTH_TIMEOUT_MS = 30_000;
const HEALTH_POLL_MS = 250;

export interface OllamaSupervisorOptions {
  host?: string;
  port?: number;
  /**
   * Override the binary path lookup entirely. Tests pass a stub script here
   * so the supervisor can be exercised without a real Ollama install.
   */
  binPath?: string;
}

export class OllamaSupervisor extends EventEmitter {
  private child: ChildProcessByStdio<null, Readable, Readable> | null = null;
  private state: OllamaSupervisorState = "idle";
  private installed: OllamaInstalledModel[] = [];
  private errorMessage: string | null = null;

  private readonly host: string;
  private readonly port: number;
  private readonly binPathOverride?: string;

  /**
   * Coalesced pull-progress emitter. We get one frame per ~50ms from
   * Ollama's stream API; the renderer doesn't need that resolution and
   * forwarding all of them clogs IPC. We buffer per-model and flush at
   * ~5Hz.
   */
  private readonly pullBuffer = new Map<string, OllamaPullProgress>();
  private pullFlushTimer: NodeJS.Timeout | null = null;

  constructor(opts: OllamaSupervisorOptions = {}) {
    super();
    this.host = opts.host ?? DEFAULT_HOST;
    this.port = opts.port ?? DEFAULT_PORT;
    this.binPathOverride = opts.binPath;
  }

  // ---- Status ---------------------------------------------------------------

  getStatus(): OllamaStatus {
    return {
      state: this.state,
      host: this.state === "idle" ? null : this.baseUrl(),
      required: REQUIRED_MODELS,
      installed: this.installed,
      missing: missingModels(this.installed),
      errorMessage: this.errorMessage,
    };
  }

  private setState(next: OllamaSupervisorState, errorMessage?: string): void {
    this.state = next;
    this.errorMessage = errorMessage ?? (next === "error" ? this.errorMessage : null);
    this.emit("status", this.getStatus());
  }

  // ---- Lifecycle ------------------------------------------------------------

  async start(): Promise<void> {
    if (this.state === "starting" || this.state === "ready") return;
    this.setState("starting");

    // Adopt-existing path. If something is already serving Ollama on the
    // loopback port (typical in dev: `ava-ollama` Docker container, or a
    // user's own `ollama serve`), skip spawning and treat that instance as
    // ours. This avoids the "ollama not on PATH" ENOENT in dev and is
    // forward-compatible with multi-instance scenarios.
    if (await this.probeReachable()) {
      console.log("[ollama] adopting existing instance at " + this.baseUrl());
      await this.refreshInstalledModels();
      this.setState("ready");
      return;
    }

    const bin = this.resolveBinaryPath();
    if (!bin) {
      this.setState(
        "error",
        "Ollama binary not found. Reinstall the app or set OLLAMA_BIN.",
      );
      return;
    }

    const modelsDir = this.resolveModelsDir();
    try {
      mkdirSync(modelsDir, { recursive: true });
    } catch {
      // best-effort; if mkdir fails the spawn below will surface the real
      // error via stderr.
    }

    try {
      this.child = spawn(bin, ["serve"], {
        env: {
          ...process.env,
          OLLAMA_HOST: `${this.host}:${this.port}`,
          OLLAMA_MODELS: modelsDir,
        },
        stdio: ["ignore", "pipe", "pipe"],
      });
    } catch (err) {
      this.setState(
        "error",
        `spawn failed: ${err instanceof Error ? err.message : String(err)}`,
      );
      return;
    }

    // ENOENT (binary missing) and EACCES (not executable) surface here, NOT
    // as a synchronous throw from spawn(). Without this listener Node escalates
    // to an uncaughtException — which in Electron pops a "JavaScript error"
    // dialog. Catching it here funnels the failure into the normal status flow.
    this.child.on("error", (err) => {
      const msg = err instanceof Error ? err.message : String(err);
      this.child = null;
      this.setState("error", `failed to launch ollama (${bin}): ${msg}`);
    });

    this.child.stdout.on("data", (b: Buffer) => {
      // Ollama is chatty on stdout — we keep it for diagnostics but don't
      // surface it to the renderer to avoid log-spam.
      console.log(`[ollama] ${b.toString().trimEnd()}`);
    });
    this.child.stderr.on("data", (b: Buffer) => {
      console.warn(`[ollama:err] ${b.toString().trimEnd()}`);
    });
    this.child.on("exit", (code, signal) => {
      const wasRunning = this.state === "ready" || this.state === "starting";
      this.child = null;
      if (this.state === "stopping") {
        this.setState("idle");
      } else if (wasRunning) {
        this.setState(
          "error",
          `ollama exited unexpectedly (code=${code ?? "null"}, signal=${signal ?? "null"})`,
        );
      }
    });

    // Poll the loopback API until it answers. If we never get a 200 within
    // the budget, kill the child and go to error state.
    const ok = await this.waitUntilReady();
    if (!ok) {
      this.killChild();
      this.setState("error", "ollama did not become healthy within 30s");
      return;
    }
    await this.refreshInstalledModels();
    this.setState("ready");
  }

  async stop(): Promise<void> {
    if (this.state === "idle" || this.state === "stopping") return;
    this.setState("stopping");
    this.killChild();
    // Don't await exit — the "exit" handler above flips state to idle.
    // Callers that need a hard guarantee can bind to the next "status" event.
  }

  private killChild(): void {
    if (!this.child) return;
    try {
      // SIGTERM gives Ollama a chance to flush; the OS will follow up with
      // SIGKILL via electron's own quit shutdown path if needed.
      this.child.kill("SIGTERM");
    } catch {
      // ignored — the exit handler will pick up the actual outcome
    }
  }

  // ---- HTTP helpers ---------------------------------------------------------

  private baseUrl(): string {
    return `http://${this.host}:${this.port}`;
  }

  /**
   * One-shot health probe with a short timeout — used to detect a pre-running
   * Ollama (e.g. dev-mode Docker container) before we try to spawn our own.
   * Distinct from {@link waitUntilReady} which polls during boot.
   */
  private async probeReachable(): Promise<boolean> {
    try {
      const ctrl = new AbortController();
      const timer = setTimeout(() => ctrl.abort(), 500);
      try {
        const res = await fetch(`${this.baseUrl()}/api/tags`, {
          method: "GET",
          signal: ctrl.signal,
        });
        return res.ok;
      } finally {
        clearTimeout(timer);
      }
    } catch {
      return false;
    }
  }

  private async waitUntilReady(): Promise<boolean> {
    const deadline = Date.now() + HEALTH_TIMEOUT_MS;
    while (Date.now() < deadline) {
      try {
        const res = await fetch(`${this.baseUrl()}/api/tags`, {
          method: "GET",
        });
        if (res.ok) return true;
      } catch {
        // child still booting — retry until the deadline
      }
      await sleep(HEALTH_POLL_MS);
    }
    return false;
  }

  private async refreshInstalledModels(): Promise<void> {
    try {
      const res = await fetch(`${this.baseUrl()}/api/tags`);
      if (!res.ok) return;
      const body = (await res.json()) as {
        models?: Array<{
          name: string;
          size: number;
          digest: string;
          modified_at: string;
        }>;
      };
      this.installed = (body.models ?? []).map((m) => ({
        name: m.name,
        size: m.size,
        digest: m.digest,
        modifiedAt: m.modified_at,
      }));
      // Re-emit status so the missing-models list updates after a pull.
      this.emit("status", this.getStatus());
    } catch (err) {
      console.warn("[ollama] refreshInstalledModels failed:", err);
    }
  }

  // ---- Model pull -----------------------------------------------------------

  /**
   * Stream `POST /api/pull` and forward coalesced progress frames via
   * `progress` events. Resolves on the final frame (success or failure);
   * the supervisor refreshes the installed-model list before resolving so
   * the renderer's `getStatus` after `pullModel` sees the new model.
   */
  async pullModel(modelName: string): Promise<OllamaPullProgress> {
    if (this.state !== "ready") {
      throw new Error(
        `pullModel requires supervisor in 'ready' state (current: ${this.state})`,
      );
    }

    const res = await fetch(`${this.baseUrl()}/api/pull`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ name: modelName, stream: true }),
    });
    if (!res.ok || !res.body) {
      const message = `ollama pull HTTP ${res.status}`;
      const final: OllamaPullProgress = {
        modelName,
        status: "error",
        done: true,
        errorMessage: message,
      };
      this.bufferProgress(final);
      this.flushPullProgress(true);
      throw new Error(message);
    }

    const reader = res.body.getReader();
    const decoder = new TextDecoder();
    let buf = "";
    let finalFrame: OllamaPullProgress = {
      modelName,
      status: "starting",
      done: false,
    };

    try {
      // eslint-disable-next-line no-constant-condition
      while (true) {
        const { value, done } = await reader.read();
        if (done) break;
        buf += decoder.decode(value, { stream: true });
        // Ollama emits one JSON object per line.
        let nl: number;
        while ((nl = buf.indexOf("\n")) >= 0) {
          const line = buf.slice(0, nl).trim();
          buf = buf.slice(nl + 1);
          if (!line) continue;
          let frame: {
            status?: string;
            completed?: number;
            total?: number;
            error?: string;
          };
          try {
            frame = JSON.parse(line);
          } catch {
            continue;
          }
          const isError = typeof frame.error === "string" && frame.error.length > 0;
          const progress: OllamaPullProgress = {
            modelName,
            status: frame.status ?? (isError ? "error" : "pulling"),
            completed: frame.completed,
            total: frame.total,
            done: false,
            errorMessage: isError ? frame.error : undefined,
          };
          this.bufferProgress(progress);
          finalFrame = progress;
          if (isError) {
            finalFrame = { ...progress, done: true };
            this.bufferProgress(finalFrame);
            this.flushPullProgress(true);
            throw new Error(frame.error);
          }
        }
      }
    } finally {
      reader.releaseLock?.();
    }

    finalFrame = { ...finalFrame, done: true, status: "success" };
    this.bufferProgress(finalFrame);
    this.flushPullProgress(true);
    await this.refreshInstalledModels();
    return finalFrame;
  }

  private bufferProgress(p: OllamaPullProgress): void {
    this.pullBuffer.set(p.modelName, p);
    if (this.pullFlushTimer === null) {
      this.pullFlushTimer = setTimeout(() => this.flushPullProgress(false), 200);
    }
  }

  private flushPullProgress(force: boolean): void {
    if (this.pullFlushTimer !== null) {
      clearTimeout(this.pullFlushTimer);
      this.pullFlushTimer = null;
    }
    for (const frame of this.pullBuffer.values()) {
      this.emit("progress", frame);
    }
    this.pullBuffer.clear();
    if (!force) {
      // No-op — the next bufferProgress call will arm a new timer.
    }
  }

  // ---- Path resolution ------------------------------------------------------

  private resolveBinaryPath(): string | null {
    if (this.binPathOverride) return this.binPathOverride;

    const fromEnv = process.env.OLLAMA_BIN;
    if (fromEnv && existsSync(fromEnv)) return fromEnv;

    const platformDir = `${process.platform}-${process.arch}`; // e.g. "darwin-arm64"
    const exe = process.platform === "win32" ? "ollama.exe" : "ollama";

    // Packaged: <resourcesPath>/ollama/<platform>-<arch>/ollama
    if (app.isPackaged) {
      const packaged = join(process.resourcesPath, "ollama", platformDir, exe);
      if (existsSync(packaged)) return packaged;
      return null; // packaged build MUST find the bundled binary
    }

    // Dev: alongside the repo's resources/ folder.
    const devCandidate = join(app.getAppPath(), "resources", "ollama", platformDir, exe);
    if (existsSync(devCandidate)) return devCandidate;

    // Last resort in dev: rely on a system-installed `ollama` on PATH.
    return "ollama";
  }

  private resolveModelsDir(): string {
    return join(app.getPath("userData"), "ollama", "models");
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

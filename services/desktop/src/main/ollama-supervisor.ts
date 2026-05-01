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

// Pull retry budget. Picked to ride out a typical ISP/Cloudflare hiccup
// (~30s of bad weather) without dragging the user through a 10-minute
// silent stall on a permanently-broken route. Total worst-case wait
// across backoffs is 1+2+4+8 = 15s, plus per-attempt I/O.
const MAX_PULL_ATTEMPTS = 5;
const PULL_RETRY_BASE_MS = 1000;
const PULL_RETRY_MAX_MS = 16_000;

/**
 * Classify a pull-attempt failure as retryable or fatal. Retryable
 * covers the long tail of transient network and CDN issues we've seen
 * against Ollama's R2 backend (TLS handshake timeouts, connection
 * resets, HTTP/2 stream stalls). Fatal covers things where retrying
 * just spams the registry — bad model name, auth, etc.
 *
 * Default: retry. The user can always click Retry on a failed row, so
 * leaning toward retry is the lower-friction default; the explicit
 * fatal list is what we *don't* burn the budget on.
 */
function isRetryablePullError(err: Error): boolean {
  const msg = err.message.toLowerCase();
  // Fatal — registry-level errors that won't change on retry.
  if (
    msg.includes("manifest") &&
    (msg.includes("not found") || msg.includes("unknown"))
  ) {
    return false;
  }
  if (msg.includes("unauthorized") || msg.includes("forbidden")) return false;
  if (msg.includes("invalid model")) return false;
  if (msg.includes("http 400") || msg.includes("http 404")) return false;
  return true;
}

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

  /**
   * Stop + start, awaiting both. Used when the agent observes a
   * runner-level crash ("llama runner process has terminated"): the
   * outer `ollama serve` is still alive but its internal runner state
   * is wedged, and the cleanest recovery is a fresh process. Resolves
   * once the supervisor is `ready` again or transitions to `error` —
   * callers should re-check `getStatus()` afterwards.
   *
   * Concurrency: callers must serialize themselves. We bail early if a
   * stop/start is already in flight rather than racing transitions.
   */
  async restart(): Promise<void> {
    if (this.state === "stopping" || this.state === "starting") return;
    if (this.state === "idle") {
      await this.start();
      return;
    }
    await this.stop();
    // Wait for the child's exit handler to flip us to "idle". The exit
    // handler runs synchronously off the child's "exit" event, but we
    // can race ahead of it here — poll briefly with a short cap.
    const deadline = Date.now() + 5_000;
    // Cast: TS narrows `this.state` based on the pre-await snapshot,
    // but the child's "exit" handler mutates it asynchronously to
    // "idle" — which is exactly what we're polling for.
    while ((this.state as OllamaSupervisorState) !== "idle" && Date.now() < deadline) {
      await sleep(50);
    }
    await this.start();
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
   *
   * Phase 8.k10d — retry harness. Cloudflare R2 (where Ollama serves the
   * blob layers) regularly hits TLS handshake timeouts and connection
   * resets on residential connections, especially for the multi-GB Gemma
   * tags. Without retry the user is stuck on "Failed" after one bad
   * minute. Strategy:
   *
   *   - Up to {@link MAX_PULL_ATTEMPTS} attempts with exponential backoff
   *     (1s, 2s, 4s, 8s, 16s capped). Ollama's `/api/pull` is resumable:
   *     re-POSTing with the same model name continues from existing
   *     partial layer files on disk, so retries don't lose progress.
   *   - Network errors, HTTP 5xx, and *transient-looking* body-level
   *     errors ("stalled", "reset by peer", "timeout", "EOF",
   *     "connection") are retried.
   *   - Fatal errors (manifest not found, unauthorized, invalid model
   *     name) abort immediately — retrying won't help.
   *   - Between attempts we emit a frame with `retrying: true` so the
   *     dock can show "Reconnecting (attempt 3/5)…" instead of jumping
   *     to "Failed".
   *
   * The renderer can also surface a Retry button on truly-failed rows
   * by re-invoking `pullModel(modelName)` — same code path, fresh budget.
   */
  async pullModel(modelName: string): Promise<OllamaPullProgress> {
    if (this.state !== "ready") {
      throw new Error(
        `pullModel requires supervisor in 'ready' state (current: ${this.state})`,
      );
    }

    let lastError: Error | null = null;
    let lastProgress: OllamaPullProgress | null = null;
    for (let attempt = 1; attempt <= MAX_PULL_ATTEMPTS; attempt++) {
      try {
        const result = await this.pullModelOnce(modelName, attempt, lastProgress);
        // Success — flush + refresh + resolve.
        this.bufferProgress(result);
        this.flushPullProgress(true);
        await this.refreshInstalledModels();
        return result;
      } catch (err) {
        lastError = err instanceof Error ? err : new Error(String(err));
        lastProgress = this.pullBuffer.get(modelName) ?? lastProgress;
        const retryable = isRetryablePullError(lastError);
        const hasBudget = attempt < MAX_PULL_ATTEMPTS;
        if (!retryable || !hasBudget) break;

        // Tell the renderer we're not actually dead — we're between
        // attempts. Preserve the last completed/total so the bar geometry
        // doesn't snap back to 0.
        const backoffMs = Math.min(
          PULL_RETRY_BASE_MS * 2 ** (attempt - 1),
          PULL_RETRY_MAX_MS,
        );
        this.bufferProgress({
          modelName,
          status: `reconnecting (${lastError.message})`,
          completed: lastProgress?.completed,
          total: lastProgress?.total,
          done: false,
          retrying: true,
          attempt: attempt + 1,
          maxAttempts: MAX_PULL_ATTEMPTS,
        });
        this.flushPullProgress(true);
        console.warn(
          `[ollama] pull ${modelName} attempt ${attempt}/${MAX_PULL_ATTEMPTS} failed: ${lastError.message}; retrying in ${backoffMs}ms`,
        );
        await sleep(backoffMs);
      }
    }

    const message = lastError?.message ?? "unknown pull error";
    const final: OllamaPullProgress = {
      modelName,
      status: "error",
      completed: lastProgress?.completed,
      total: lastProgress?.total,
      done: true,
      errorMessage: message,
      attempt: MAX_PULL_ATTEMPTS,
      maxAttempts: MAX_PULL_ATTEMPTS,
    };
    this.bufferProgress(final);
    this.flushPullProgress(true);
    throw lastError ?? new Error(message);
  }

  /**
   * One attempt at `POST /api/pull` + streaming the response. Throws on
   * any failure (HTTP, body-level error, stream abort). The outer
   * {@link pullModel} decides whether to retry.
   */
  private async pullModelOnce(
    modelName: string,
    attempt: number,
    priorProgress: OllamaPullProgress | null,
  ): Promise<OllamaPullProgress> {
    const res = await fetch(`${this.baseUrl()}/api/pull`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ name: modelName, stream: true }),
    });
    if (!res.ok || !res.body) {
      throw new Error(`ollama pull HTTP ${res.status}`);
    }

    const reader = res.body.getReader();
    const decoder = new TextDecoder();
    let buf = "";
    // Seed with the prior attempt's last-known position so a frame-less
    // first read in the retry doesn't visually reset the bar.
    let finalFrame: OllamaPullProgress = {
      modelName,
      status: attempt === 1 ? "starting" : "resuming",
      completed: priorProgress?.completed,
      total: priorProgress?.total,
      done: false,
      attempt: attempt > 1 ? attempt : undefined,
      maxAttempts: attempt > 1 ? MAX_PULL_ATTEMPTS : undefined,
    };
    // Ollama's pull stream ends with `{"status":"success"}` on a clean
    // completion. If the underlying TCP connection drops mid-stream
    // (R2/Cloudflare hiccup, ISP burp, etc), the body ends without
    // that sentinel. We MUST distinguish the two — earlier we
    // unconditionally stamped `status: "success"` after the reader
    // returned `done: true`, which silently treated half-finished
    // pulls as complete. The user then restarted the app and was
    // re-prompted to "download" because Ollama's `/api/tags` correctly
    // reported the model as still missing on disk.
    let sawSuccess = false;

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
          if (isError) {
            // Surface the body-level error to the retry harness — don't
            // mark `done` here; the harness decides whether this becomes
            // a final failure or a retry.
            throw new Error(frame.error!);
          }
          if (frame.status === "success") sawSuccess = true;
          const progress: OllamaPullProgress = {
            modelName,
            status: frame.status ?? "pulling",
            completed: frame.completed,
            total: frame.total,
            done: false,
            attempt: attempt > 1 ? attempt : undefined,
            maxAttempts: attempt > 1 ? MAX_PULL_ATTEMPTS : undefined,
          };
          this.bufferProgress(progress);
          finalFrame = progress;
        }
      }
    } finally {
      reader.releaseLock?.();
    }

    if (!sawSuccess) {
      // Stream ended without Ollama's success sentinel. Treat as a
      // transient connection drop so the retry harness gets a chance
      // to resume — `/api/pull` is resumable, so a fresh POST will
      // continue from the layers already on disk.
      throw new Error(
        `pull stream ended before completion (last status: ${finalFrame.status})`,
      );
    }
    return { ...finalFrame, done: true, status: "success" };
  }

  /**
   * Delete a model from disk via Ollama's `DELETE /api/delete`. Used by
   * the Whoami "free disk space" affordance — the user is in charge of
   * which models stay on disk; we don't garbage-collect anything
   * silently. Refreshes the installed-models list before resolving so
   * the renderer's next status read sees the change.
   */
  async deleteModel(modelName: string): Promise<void> {
    if (this.state !== "ready") {
      throw new Error(
        `deleteModel requires supervisor in 'ready' state (current: ${this.state})`,
      );
    }
    const res = await fetch(`${this.baseUrl()}/api/delete`, {
      method: "DELETE",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ name: modelName }),
    });
    // Ollama returns 200 on success, 404 if the model wasn't there. We
    // treat 404 as a no-op success — the end-state ("model gone") is
    // already true, and a stale UI race shouldn't surface an error.
    if (!res.ok && res.status !== 404) {
      const text = await res.text().catch(() => "");
      throw new Error(
        `ollama delete HTTP ${res.status}${text ? `: ${text}` : ""}`,
      );
    }
    await this.refreshInstalledModels();
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

  /**
   * Where the Ollama child process keeps its blob/manifest files.
   *
   * We deliberately use the *standard* Ollama dir (`~/.ollama/models`,
   * or whatever `OLLAMA_MODELS` already points to in the user's
   * environment) instead of an app-private path under `userData`.
   * Two reasons:
   *
   *   1. Sharing with the CLI. Users often have `ollama` installed
   *      already and run `ollama list` / `ollama pull` from a terminal.
   *      An app-private dir means models pulled there are invisible to
   *      the CLI and vice versa, which is the bug a user just hit:
   *      `ollama list` showed two installed models and the app insisted
   *      it had none.
   *
   *   2. Survival across uninstall. Multi-GB pulls are expensive — if
   *      the user reinstalls the app or wipes `userData`, we don't want
   *      to silently force a re-download. The standard dir lives in
   *      `$HOME` and persists.
   *
   * Override hierarchy:
   *   1. `OLLAMA_MODELS` env var if already set (developer/CI override)
   *   2. `~/.ollama/models` (Ollama's default — what the CLI uses)
   */
  private resolveModelsDir(): string {
    const fromEnv = process.env.OLLAMA_MODELS;
    if (fromEnv && fromEnv.length > 0) return fromEnv;
    return join(app.getPath("home"), ".ollama", "models");
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

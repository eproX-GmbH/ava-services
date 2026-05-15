import { spawn, type ChildProcessByStdio } from "node:child_process";
import { producerLogBuffer } from "./producer-log-buffer";
import { screenshotDirForProducer } from "./producer-screenshots";
import type { Readable } from "node:stream";
import { EventEmitter } from "node:events";
import { existsSync } from "node:fs";
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
/**
 * v0.1.192 — minimum gap between consecutive `authError` emits from a
 * single producer. A stale Anthropic token surfaces the same 401 on
 * every redelivered AMQP message; without the debounce a packed queue
 * would fire dozens of refresh attempts per second.
 */
const AUTH_ERROR_DEBOUNCE_MS = 30_000;

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
   * DATABASE_URL for the producer — pulled from the gateway via
   * `/v1/local-credentials`. Each producer hits the cloud-managed
   * Postgres for its own database (ava_company_profile, etc.); no
   * local persistence. Returns null if the user isn't signed in
   * yet, in which case start() bails to `error` with a "wartet"
   * message.
   */
  databaseUrl: () => Promise<string | null>;
  /**
   * AMQP broker URL provider — async because the URL is fetched
   * from the gateway's `/v1/local-amqp-url` endpoint after the
   * user has authenticated. Returns null if the user isn't
   * signed in yet, in which case start() bails to `error` with
   * a helpful message instead of trying to connect to a default
   * unreachable broker.
   */
  amqpUrl: () => Promise<string | null>;
  /**
   * JWKS endpoint the producer uses to verify inbound JWTs on its
   * HTTP API. Same Keycloak realm the desktop authenticates
   * against. Eagerly resolved (not async) — the URL is part of
   * the bundled boot config.
   */
  jwksUri: string;
  /**
   * Provider/LLM config for the producer's AI calls. Pulled from
   * the user's saved provider config; null when no provider is
   * configured yet.
   */
  llmConfig: () => Promise<{
    provider: string;
    model?: string;
    openaiApiKey?: string;
    anthropicApiKey?: string;
    anthropicSubscriptionToken?: string;
    googleApiKey?: string;
    mistralApiKey?: string;
    ollamaUrl?: string;
  } | null>;
  /**
   * When `llmConfig()` returns null, this returns a German one-liner
   * naming the specific blocker (e.g. "Subscription-Login wird vom
   * lokalen Producer noch nicht unterstützt — wechsle auf API-Key").
   * Optional — falls back to the generic message if unset.
   */
  llmConfigBlockerReason?: () => Promise<string | null>;
  /**
   * Provider for the gateway Bearer token the producer subprocess
   * uses to call gateway-mediated endpoints (today: /v1/proxy/* —
   * operator-paid valueserp for website + company-contact). Same
   * token the desktop main uses for its own gateway calls.
   *
   * Captured at spawn time. If it expires mid-session the producer's
   * gateway calls will 401; supervisor restart-on-error picks up a
   * fresh token from the next call. For the pilot's typical
   * Keycloak access-token TTLs this is acceptable — accept-the-401
   * is simpler than threading a live refresh channel into a Node
   * subprocess.
   */
  getAccessToken: () => Promise<string | null>;
  /**
   * v0.1.53 — JWT subject (auth.actorId) used to scope AMQP queues
   * + routing keys per-user. Each producer:
   *   - Asserts a queue named `<base>-<userId>` instead of `<base>`.
   *   - Binds `<context>.<operation>.<userId>` (master-data publishes
   *     with the same suffix to land messages on this user's queue).
   *   - Cascades downstream publishes with the same suffix so the
   *     next producer in the chain receives them on its per-user
   *     queue too.
   * When null (signed-out / dev / tests) producers fall back to the
   * legacy shared base names.
   */
  getUserId: () => Promise<string | null>;
  /** Extra env merged in after the supervisor's defaults. */
  extraEnv?: Record<string, string>;
  /** v0.1.105 — dynamic extra env, evaluated at each spawn. Used for
   *  values that depend on runtime state (e.g. the structured-content
   *  upstream picker, which reads live reachability). */
  extraEnvAsync?: () => Promise<Record<string, string>>;
}

export class ProducerSupervisor extends EventEmitter {
  private child: ChildProcessByStdio<null, Readable, Readable> | null = null;
  private state: ProducerSupervisorState = "idle";
  private errorMessage: string | null = null;
  private exitCode: number | null = null;
  /**
   * v0.1.170 — last LLM config we applied at spawn time. Captured here
   * so getStatus() can derive `featureWarnings` (e.g. "Deep Research
   * deaktiviert" when website was started without an OpenAI key). Null
   * until the first successful spawn.
   */
  private lastLlmConfig:
    | { openaiApiKey?: string; anthropicSubscriptionToken?: string; anthropicApiKey?: string; googleApiKey?: string; mistralApiKey?: string }
    | null = null;

  /**
   * v0.1.192 — debounce for the auth-error stderr watcher. We emit at
   * most one `authError` per producer per AUTH_ERROR_DEBOUNCE_MS so a
   * crashloop on a stale token (every redelivered AMQP message logs
   * the same 401) doesn't fire dozens of refresh attempts back-to-back.
   */
  private lastAuthErrorAt = 0;

  constructor(private readonly opts: ProducerSupervisorOptions) {
    super();
  }

  /**
   * v0.1.201 — opt-in audit-event channel from producer subprocesses.
   *
   * Convention: a producer can emit a single line of stdout/stderr
   * matching `__AVA_AUDIT__<json-payload>__/AVA_AUDIT__` and the
   * supervisor forwards the parsed payload as an `auditEvent` event
   * on its own EventEmitter surface. main/index.ts subscribes and
   * writes the entry to the local PGlite-backed audit store.
   *
   * Why a stdout marker and not a new AMQP topic:
   *   - producers already log heavily to stdout; adding a structured
   *     line costs nothing
   *   - no extra AMQP plumbing, no cloud round-trip — fully local
   *   - failure-mode is graceful: a non-AVA developer running the
   *     producer standalone just sees the marker line in their logs
   *
   * Producer-side helper (recommended, not yet shipped to producers):
   *   function auditEmit(event) {
   *     console.log(`__AVA_AUDIT__${JSON.stringify(event)}__/AVA_AUDIT__`);
   *   }
   *
   * The payload must be a single line of JSON matching AuditEventInput
   * (see shared/types.ts). Malformed lines are silently dropped.
   */
  private detectAuditMarker(text: string): void {
    // Cheap pre-check before regex'ing the whole buffer
    if (!text.includes("__AVA_AUDIT__")) return;
    const re = /__AVA_AUDIT__(.+?)__\/AVA_AUDIT__/g;
    let m: RegExpExecArray | null;
    while ((m = re.exec(text)) !== null) {
      const captured = m[1];
      if (!captured) continue;
      try {
        const payload = JSON.parse(captured) as Record<string, unknown>;
        if (
          typeof payload.category !== "string" ||
          typeof payload.action !== "string" ||
          typeof payload.summary !== "string"
        ) {
          continue;
        }
        // Default actor to the producer name so emitters can keep
        // their payload minimal.
        if (!payload.actorType) payload.actorType = "producer";
        if (!payload.actorId) payload.actorId = this.opts.config.name;
        this.emit("auditEvent", payload);
      } catch {
        // Bad JSON — ignore. Producer logs surface the line anyway,
        // so debugging is possible from the Producer-Status panel.
      }
    }
  }

  /**
   * v0.1.192 — scan producer stdio for credential-rejection patterns
   * and emit a single `authError` event per debounce window.
   *
   * Matched patterns (all case-insensitive):
   *   - "Invalid authentication credentials" — Anthropic's literal
   *     401 body for OAuth bearers and API keys.
   *   - "authentication_error"               — Anthropic SDK wrapper
   *     classification.
   *   - "Incorrect API key"                  — OpenAI's wording.
   *
   * The desktop main listens via `supervisor.on("authError")` and
   * forces an immediate token-refresh + cycles all producers when it
   * fires. See main/index.ts.
   */
  private detectAuthErrorPattern(text: string): void {
    if (
      !/invalid authentication credentials/i.test(text) &&
      !/authentication_error/i.test(text) &&
      !/incorrect api key/i.test(text)
    ) {
      return;
    }
    const now = Date.now();
    if (now - this.lastAuthErrorAt < AUTH_ERROR_DEBOUNCE_MS) return;
    this.lastAuthErrorAt = now;
    // Best-effort provider hint: we don't actually parse the message,
    // but `lastLlmConfig` tells us which provider the producer was
    // spawned with. The main process uses this to refresh the right
    // credential source.
    const provider = this.inferProviderFromConfig();
    console.warn(
      `[producer:${this.opts.config.name}] auth-error pattern detected (provider=${provider ?? "unknown"})`,
    );
    this.emit("authError", {
      producerName: this.opts.config.name,
      provider,
    });
  }

  private inferProviderFromConfig(): string | null {
    const c = this.lastLlmConfig;
    if (!c) return null;
    if (c.anthropicSubscriptionToken || c.anthropicApiKey) return "anthropic";
    if (c.openaiApiKey) return "openai";
    if (c.googleApiKey) return "google";
    if (c.mistralApiKey) return "mistral";
    return null;
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
      featureWarnings: this.computeFeatureWarnings(),
    };
  }

  /**
   * v0.1.170 — translate the active LLM config + producer name into
   * the list of degraded-feature warnings the renderer surfaces.
   *
   * v0.1.172 Phase F update: the old "Deep Research deaktiviert
   * (OpenAI-Key fehlt)"-warning is gone. With per-feature Settings
   * the user has explicit control over both pipelines, and the
   * `expansionTenders=off, jobPostings=off`-state is the documented
   * default — not a degradation. Warnings only fire when something
   * is _wrong_ (e.g. configured but unreachable), not when something
   * is intentionally inactive.
   *
   * The hook stays in place; per-producer warnings can be added
   * here as they emerge without touching the renderer.
   */
  private computeFeatureWarnings(): string[] {
    if (this.state !== "ready") return [];
    return [];
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
    // Flip to `starting` synchronously *before* any await. Two
    // concurrent callers (e.g. postgres.then() in main/index.ts and
    // the auth `signedIn` listener that fires on the same tick) both
    // observe `idle` if we wait until after `buildEnv()` resolves —
    // both pass the guard, both spawn, the second one EADDRINUSEs.
    // The pre-emptive setState narrows the race window to the
    // synchronous prefix, which Node guarantees is uninterruptible.
    this.setState("starting");
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
      // Either AMQP URL, DATABASE URL, or LLM provider config is
      // missing — user not signed in, no LLM key, or the user is on
      // an auth-mode the local producer doesn't yet support (e.g.
      // Anthropic-Subscription-OAuth). Skip producer spawn entirely;
      // main/index.ts restarts the supervisor when auth/config flips.
      const specific = this.opts.llmConfigBlockerReason
        ? await this.opts.llmConfigBlockerReason().catch(() => null)
        : null;
      const message = specific
        ? `producer ${this.opts.config.name}: ${specific}`
        : `producer ${this.opts.config.name}: nicht angemeldet oder kein LLM-Provider konfiguriert, Producer wartet.`;
      this.setState("error", message);
      return;
    }

    // Migrations are NOT run here — the cloud-managed Postgres
    // schema is owned by each producer's fly deploy (via
    // `prisma migrate deploy` at container start). Local
    // producers connect to the same cloud DB and use the
    // already-migrated schema. See AGENT_PLAN.md §8.v1.5 for the
    // architecture clarification.

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
    // Tee child stdio into:
    //   - the launching console (existing developer affordance — quit
    //     and re-launch the .app from Terminal to see live output)
    //   - the in-process producer log buffer (renderer-visible Logs
    //     tab via IPC, see main/index.ts and producer-log-buffer.ts)
    this.child.stdout.on("data", (b: Buffer) => {
      const text = b.toString().trimEnd();
      console.log(`[${tag}] ${text}`);
      producerLogBuffer.push(this.opts.config.name, "stdout", text);
      this.detectAuthErrorPattern(text);
      this.detectAuditMarker(text);
    });
    this.child.stderr.on("data", (b: Buffer) => {
      const text = b.toString().trimEnd();
      console.warn(`[${tag}:err] ${text}`);
      producerLogBuffer.push(this.opts.config.name, "stderr", text);
      this.detectAuthErrorPattern(text);
      this.detectAuditMarker(text);
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

  // (8.v1.5: runMigrations() removed — schema is owned by the
  // matching fly producer's deploy. Local producer connects to
  // the already-migrated cloud DB.)

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
    const databaseUrl = await this.opts.databaseUrl();
    if (!databaseUrl) return null;
    const llm = await this.opts.llmConfig();
    if (!llm) return null;
    // v0.1.170 — remember the active config so getStatus() can compute
    // featureWarnings based on which provider keys are absent.
    this.lastLlmConfig = {
      ...(llm.openaiApiKey ? { openaiApiKey: llm.openaiApiKey } : {}),
      ...(llm.anthropicApiKey ? { anthropicApiKey: llm.anthropicApiKey } : {}),
      ...(llm.anthropicSubscriptionToken
        ? { anthropicSubscriptionToken: llm.anthropicSubscriptionToken }
        : {}),
      ...(llm.googleApiKey ? { googleApiKey: llm.googleApiKey } : {}),
      ...(llm.mistralApiKey ? { mistralApiKey: llm.mistralApiKey } : {}),
    };
    // Bearer token for the producer's outbound gateway calls (today
    // only the valueserp proxy). Captured once at spawn — see
    // ProducerSupervisorOptions.getAccessToken docstring for the
    // expiry-handling philosophy. Null token is OK; producers that
    // don't need gateway calls (company-profile) ignore it.
    const accessToken = await this.opts.getAccessToken();
    // v0.1.53 — per-user AMQP routing. Resolved at spawn; if the
    // user signs out and back in as a different identity the
    // supervisor cycles (auth-status branch in main/index.ts), so
    // a new userId is captured fresh.
    const userId = await this.opts.getUserId();
    return {
      ...process.env,
      // Cloud-managed Postgres URL fetched from gateway. The
      // producer's prisma client connects directly to fly's MPG
      // cluster; schema migrations were applied by the matching
      // fly producer's deploy, not here.
      DATABASE_URL: databaseUrl,
      DIRECT_URL: databaseUrl,
      AMQP_URL: amqpUrl,
      // 8.v2: split producers into compute (local) + persist (cloud).
      // Local producers do LLM/scraping with the user's API key, emit
      // result events, and DON'T touch a database. Cloud-deployed
      // producers run with PRODUCER_MODE=persist and consume the
      // result events.
      PRODUCER_MODE: "compute",
      PORT: String(this.opts.config.port),
      // simple-probe k8s-style health-check ports. Producers
      // refuse to boot without them. Pin to PORT+100/+101 so each
      // producer has a unique liveness/readiness pair without
      // bookkeeping in this file.
      PROBE_LIVENESS_PORT: String(this.opts.config.port + 100),
      PROBE_READINESS_PORT: String(this.opts.config.port + 101),
      LOGLEVEL: process.env.LOGLEVEL ?? "info",
      NODE_ENV: app.isPackaged ? "production" : "development",
      // JWT verification — producer's HTTP API verifies inbound
      // tokens against the same Keycloak realm the desktop uses.
      JWKS_URI: this.opts.jwksUri,
      // LLM provider config — pulled from the user's saved
      // provider settings via the llmConfig() callback. Producer
      // crashes at boot without these, so we treat null as a
      // soft-skip ("nicht konfiguriert" status), not a try-anyway.
      LLM_PROVIDER: llm.provider,
      ...(llm.model ? { LLM_MODEL: llm.model } : {}),
      ...(llm.openaiApiKey ? { OPENAI_API_KEY: llm.openaiApiKey } : {}),
      ...(llm.anthropicApiKey
        ? { ANTHROPIC_API_KEY: llm.anthropicApiKey }
        : {}),
      // v0.1.145 — Anthropic-Subscription-OAuth token. The producer's
      // @ava/ai-provider getLLM() reads this env and applies the
      // shared bearer-fetch wrapper from `anthropic-oauth-fetch.ts`.
      ...(llm.anthropicSubscriptionToken
        ? { ANTHROPIC_AUTH_TOKEN: llm.anthropicSubscriptionToken }
        : {}),
      ...(llm.googleApiKey ? { GOOGLE_API_KEY: llm.googleApiKey } : {}),
      ...(llm.mistralApiKey ? { MISTRAL_API_KEY: llm.mistralApiKey } : {}),
      ...(llm.ollamaUrl ? { OLLAMA_URL: llm.ollamaUrl } : {}),
      // v0.1.184 — EMBED_PROVIDER / EMBED_MODEL are set per-producer
      // via the extraEnvAsync hook in index.ts (currently only
      // company-evaluation cares, hardcoded to ollama + embeddinggemma).
      // The user-level LLM choice no longer influences embeddings.
      // Gateway URL + Bearer for /v1/proxy/* calls (operator-paid
      // valueserp etc.). Same gateway the desktop main itself uses.
      GATEWAY_URL: process.env.GATEWAY_URL ?? "https://ava-db-gateway.fly.dev",
      ...(accessToken ? { PRODUCER_GATEWAY_TOKEN: accessToken } : {}),
      // v0.1.53 — per-user AMQP queue + routing-key suffix. See
      // utils/per-user-routing.ts in each producer for the read
      // path. Empty / unset on legacy / dev paths; producer falls
      // back to the shared base queue then.
      ...(userId ? { AVA_USER_ID: userId } : {}),
      // Selenium-driven producers (structured-content,
      // company-publication, website) write per-step screenshots
      // here so the renderer can show them in the matrix drill-down.
      // The producer creates per-runId subdirectories itself; we
      // just give it the per-producer root. Producers that don't
      // run Selenium ignore this env var.
      AVA_SCREENSHOT_DIR: screenshotDirForProducer(this.opts.config.name),
      ...(this.opts.extraEnv ?? {}),
      ...(this.opts.extraEnvAsync ? await this.opts.extraEnvAsync() : {}),
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

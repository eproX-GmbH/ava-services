import { EventEmitter } from "node:events";
import { streamText, jsonSchema, tool, stepCountIs } from "ai";
import type {
  ModelMessage,
  TextStreamPart,
  ToolSet,
} from "ai";
import { createLLM, type RuntimeProvider } from "@ava/ai-provider";
import type { OllamaSupervisor } from "../../ollama-supervisor";
import type { AgentMessage, LlmProviderKind } from "../../../shared/types";
import type { OllamaToolSpec } from "../types";
import type {
  LlmProvider,
  LlmProviderStatus,
  LlmStreamFrame,
  LlmStreamRequest,
  LlmStreamToolCall,
  LlmUsageSnapshot,
} from "./types";

// AiSdkProvider (Phase 8.k1).
//
// One generic provider class that wraps Vercel AI SDK's `streamText` for
// every supported vendor (ollama, openai, anthropic, google, mistral).
// Replaces the hand-rolled SSE/NDJSON parsers from 8.j.
//
// Why one class instead of one per kind:
//   - The branching in 8.j was minor (different status sources, different
//     wire formats). Wire format is now AI SDK's `fullStream`, which is
//     identical across vendors. The remaining variance is: "what does
//     'ready' mean for this provider?" — one method, three lines.
//   - New providers (anthropic, google, mistral) drop in by adding a
//     `kind` to the runtime config and a status branch. No new files.
//
// Status semantics:
//   - ollama: ready iff supervisor reports `state==='ready'` AND a model
//     id is known. The supervisor owns the child process, this provider
//     just reads its status.
//   - hosted (openai/anthropic/google/mistral): ready iff a key is
//     present in the safeStorage-backed store. Key validity (does it
//     authenticate against the API?) is verified lazily on first call —
//     reporting "ready" off mere presence keeps the picker responsive
//     and matches what 8.j shipped.
//
// Tool-call shape:
//   - Inputs: orchestrator passes `OllamaToolSpec[]` (a JSON-Schema
//     function descriptor, the legacy name predates the abstraction).
//     We wrap each `parameters` JSON Schema with AI SDK's `jsonSchema()`
//     and feed it to `tool({ inputSchema })`. No `execute` function is
//     supplied — the orchestrator runs tools and feeds results back via
//     the next `streamChat` call, exactly as it did pre-migration.
//   - Outputs: AI SDK's `tool-call` events arrive whole (they coalesce
//     argument fragments internally). We collect them and yield once on
//     the terminal frame so the orchestrator's contract — tool calls
//     visible only on the final `done:true` frame — is preserved.

export interface AiSdkProviderOptions {
  kind: LlmProviderKind;
  /** Resolves the model id for this provider. Re-read each turn so a
   *  picker change mid-session takes effect on the next send. */
  getModel: () => string;
  /**
   * Key resolver. Returns `null` for ollama (keyless) and
   * "key-not-set" / "decrypt-failed" / a plaintext key for the rest.
   * Async so the caller can hit safeStorage on demand without retaining
   * plaintext between turns.
   */
  getApiKey: () => Promise<string | null>;
  /**
   * Sync "is a key file present?" check — drives the status flag so the
   * badge matches what the API-keys panel shows ("stored"). We deliberately
   * do NOT gate status on decrypt success: a keychain that's temporarily
   * locked or rotated would otherwise silently flip the provider to "not
   * set" even though the user just saved a key. Decryption failures
   * surface at streamChat time with an actionable message instead.
   */
  hasStoredKey: () => boolean;
  /**
   * Subscribe to "the upstream key store moved" — fires for any provider
   * key change, the resolver decides if it's relevant. Returns an
   * unsubscribe handle.
   */
  onKeyChanged: (cb: () => void) => () => void;
  /**
   * Ollama-only — supervisor handle for status + base URL. Required
   * iff `kind === "ollama"`. Ignored otherwise.
   */
  supervisor?: OllamaSupervisor;
  /**
   * Phase A1 — Anthropic-only auth-mode resolver. Returns "api-key"
   * (default) or "subscription". When "subscription", the provider
   * pulls the OAuth token via `getAnthropicSubscriptionToken` instead
   * of `getApiKey` and forwards it to `createLLM` as
   * `anthropicSubscriptionToken`. Optional for non-Anthropic kinds.
   */
  getAnthropicAuthMode?: () => "api-key" | "subscription";
  /**
   * Phase A1 — Anthropic-only OAuth token resolver. Mirrors
   * `getApiKey` semantics. Required iff `kind === "anthropic"`
   * and the auth-mode resolver may return "subscription".
   */
  getAnthropicSubscriptionToken?: () => Promise<string | null>;
  /**
   * Phase A1 — sync "is the OAuth token file present?" check.
   * Drives the status flag when the active Anthropic auth mode is
   * "subscription". Optional for non-Anthropic kinds.
   */
  hasStoredAnthropicSubscriptionToken?: () => boolean;
  /**
   * Phase A1 — subscribe to subscription-token store mutations
   * (set / clear). Returns an unsubscribe handle.
   */
  onAnthropicSubscriptionTokenChanged?: (cb: () => void) => () => void;
}

export class AiSdkProvider extends EventEmitter implements LlmProvider {
  readonly kind: LlmProviderKind;
  private readonly getModel: () => string;
  private readonly getApiKey: () => Promise<string | null>;
  private readonly hasStoredKey: () => boolean;
  private readonly supervisor?: OllamaSupervisor;
  private readonly unsubscribeKey: () => void;
  private readonly unsubscribeOllama?: () => void;
  private readonly unsubscribeSubscriptionToken?: () => void;
  private readonly getAnthropicAuthMode?: () => "api-key" | "subscription";
  private readonly getAnthropicSubscriptionToken?: () => Promise<string | null>;
  private readonly hasStoredAnthropicSubscriptionToken?: () => boolean;

  constructor(opts: AiSdkProviderOptions) {
    super();
    this.kind = opts.kind;
    this.getModel = opts.getModel;
    this.getApiKey = opts.getApiKey;
    this.hasStoredKey = opts.hasStoredKey;
    this.supervisor = opts.supervisor;
    this.getAnthropicAuthMode = opts.getAnthropicAuthMode;
    this.getAnthropicSubscriptionToken = opts.getAnthropicSubscriptionToken;
    this.hasStoredAnthropicSubscriptionToken =
      opts.hasStoredAnthropicSubscriptionToken;

    this.unsubscribeKey = opts.onKeyChanged(() => {
      // The flag is recomputed sync each time getStatus() runs, so we
      // just need to fan a status event out to subscribers when the key
      // file appears or disappears.
      this.emit("status", this.getStatus());
    });

    if (opts.onAnthropicSubscriptionTokenChanged) {
      this.unsubscribeSubscriptionToken =
        opts.onAnthropicSubscriptionTokenChanged(() => {
          this.emit("status", this.getStatus());
        });
    }

    if (this.kind === "ollama" && opts.supervisor) {
      const handler = (): void => {
        this.emit("status", this.getStatus());
      };
      opts.supervisor.on("status", handler);
      this.unsubscribeOllama = () =>
        opts.supervisor?.removeListener("status", handler);
    }
  }

  // ---- Status --------------------------------------------------------------

  getStatus(): LlmProviderStatus {
    if (this.kind === "ollama") return this.ollamaStatus();
    return this.hostedStatus();
  }

  onStatusChanged(listener: (s: LlmProviderStatus) => void): () => void {
    const handler = (s: LlmProviderStatus): void => listener(s);
    this.on("status", handler);
    return () => this.off("status", handler);
  }

  dispose(): void {
    this.unsubscribeKey();
    this.unsubscribeOllama?.();
    this.unsubscribeSubscriptionToken?.();
    this.removeAllListeners();
  }

  private ollamaStatus(): LlmProviderStatus {
    const oll = this.supervisor?.getStatus();
    if (!oll) {
      return {
        kind: "ollama",
        model: null,
        ready: false,
        errorMessage: "Ollama supervisor not attached.",
      };
    }
    const model = this.getModel() || null;
    const ready = oll.state === "ready" && model !== null;
    return {
      kind: "ollama",
      model,
      ready,
      errorMessage:
        oll.state === "error"
          ? (oll.errorMessage ?? "Ollama is not running.")
          : oll.state !== "ready"
            ? "Ollama is starting."
            : !model
              ? "No LLM-role model configured."
              : null,
    };
  }

  private hostedStatus(): LlmProviderStatus {
    const model = this.getModel() || null;
    // Phase A1 — for anthropic, the credential we need depends on the
    // active auth mode. Subscription mode looks at the OAuth token blob
    // instead of `anthropic.enc`. Other hosted providers behave exactly
    // as before.
    const authMode =
      this.kind === "anthropic" && this.getAnthropicAuthMode
        ? this.getAnthropicAuthMode()
        : "api-key";
    const hasCredential =
      this.kind === "anthropic" && authMode === "subscription"
        ? (this.hasStoredAnthropicSubscriptionToken?.() ?? false)
        : this.hasStoredKey();
    const credLabel =
      this.kind === "anthropic" && authMode === "subscription"
        ? `${labelFor(this.kind)} subscription token not set.`
        : `${labelFor(this.kind)} API key not set.`;
    return {
      kind: this.kind,
      model,
      ready: hasCredential && model !== null,
      errorMessage: !hasCredential
        ? credLabel
        : !model
          ? `No model selected for ${labelFor(this.kind)}.`
          : null,
    };
  }

  // ---- Streaming -----------------------------------------------------------

  async *streamChat(
    req: LlmStreamRequest,
  ): AsyncGenerator<LlmStreamFrame, void, void> {
    const status = this.getStatus();
    if (!status.ready || !status.model) {
      throw new Error(status.errorMessage ?? `${this.kind} provider not ready.`);
    }

    // Build the AI SDK LanguageModel. We construct fresh per call rather
    // than caching: keys can rotate between turns and Ollama's base URL
    // can shift if the supervisor restarts on a different port.
    const authMode =
      this.kind === "anthropic" && this.getAnthropicAuthMode
        ? this.getAnthropicAuthMode()
        : "api-key";
    let apiKey: string | undefined;
    let anthropicSubscriptionToken: string | undefined;
    if (this.kind === "anthropic" && authMode === "subscription") {
      anthropicSubscriptionToken =
        (await this.getAnthropicSubscriptionToken?.()) ?? undefined;
      if (
        !anthropicSubscriptionToken &&
        this.hasStoredAnthropicSubscriptionToken?.()
      ) {
        throw new Error(
          `${labelFor(this.kind)} subscription token is unreadable. The OS keychain may have changed since it was saved. Open Whoami → API keys and re-enter the token.`,
        );
      }
    } else {
      apiKey = (await this.getApiKey()) ?? undefined;
      if (this.kind !== "ollama" && !apiKey && this.hasStoredKey()) {
        throw new Error(
          `${labelFor(this.kind)} API key is unreadable. The OS keychain may have changed since it was saved. Open Whoami → API keys and re-enter the key.`,
        );
      }
    }
    const baseURL =
      this.kind === "ollama"
        ? this.ollamaBaseURL()
        : undefined;
    // v0.1.7 diagnostic: log key shape (length + masked head/tail) and
    // request shape so we can tell, post-mortem in DevTools, whether
    // the key reached this layer intact and which model the SDK is
    // about to talk to. Never logs the full key.
    if (this.kind !== "ollama") {
      const k = anthropicSubscriptionToken ?? apiKey ?? "";
      const masked =
        k.length > 8 ? `${k.slice(0, 4)}…${k.slice(-4)}` : `len=${k.length}`;
      const ascii = /^[\x20-\x7E]*$/.test(k);
      const hasWS = /\s/.test(k);
      const credKind = anthropicSubscriptionToken
        ? "oauth-bearer"
        : "api-key";
      // eslint-disable-next-line no-console
      console.log(
        `[${this.kind}] outgoing call → model=${status.model} cred=${credKind} key=${masked} keyLen=${k.length} ascii=${ascii} hasWhitespace=${hasWS}`,
      );
    }
    const model = createLLM({
      provider: this.kind as RuntimeProvider,
      model: status.model,
      apiKey,
      baseURL,
      ...(anthropicSubscriptionToken
        ? { anthropicSubscriptionToken }
        : {}),
    });

    const tools = req.tools ? buildToolSet(req.tools) : undefined;

    // v0.1.185 — Anthropic prompt-caching.
    //
    // Without caching, every turn re-bills the full system prompt
    // (~13 k tokens) + tool schemas (~12 k tokens). Tier-1 users hit
    // the 30 k/min input-token rate-limit on the first multi-tool
    // turn, and a 5-turn session costs ~$0.60.
    //
    // We mark the system message and the LAST tool with
    // `cacheControl: { type: "ephemeral" }`. Anthropic caches
    // everything UP TO the marker, so a single marker on the last
    // tool covers the whole tools array; a separate marker on the
    // system message keeps the prompt block cacheable on its own
    // when the tool set changes between turns.
    //
    // Cache TTL is 5 min by default. First request after a stable
    // prefix costs 1.25× (cache write); every subsequent hit within
    // 5 min costs 0.1×. For multi-turn sessions that's a 60–80 %
    // input-token discount, and rate-limit counters drop with it.
    //
    // The `providerOptions.anthropic` namespace is ignored by other
    // providers (OpenAI / Ollama / Google), so leaving the markers
    // in place for those is a no-op. OpenAI does its own automatic
    // caching ≥1024 tokens regardless.
    const modelMessages = toModelMessages(req.messages);
    const cachedMessages = modelMessages.map((m) => {
      if (m.role === "system") {
        return {
          ...m,
          providerOptions: {
            anthropic: { cacheControl: { type: "ephemeral" as const } },
          },
        };
      }
      return m;
    });
    let cachedTools = tools;
    if (cachedTools && this.kind === "anthropic") {
      const keys = Object.keys(cachedTools);
      const lastKey = keys.length > 0 ? keys[keys.length - 1] : null;
      if (lastKey) {
        const lastTool = cachedTools[lastKey];
        if (lastTool) {
          const withCache = {
            ...lastTool,
            providerOptions: {
              anthropic: { cacheControl: { type: "ephemeral" as const } },
            },
          } as typeof lastTool;
          cachedTools = {
            ...cachedTools,
            [lastKey]: withCache,
          } as ToolSet;
        }
      }
    }

    const result = streamText({
      model,
      messages: cachedMessages,
      ...(cachedTools ? { tools: cachedTools } : {}),
      // Stop after a single assistant turn — we run the ReAct loop
      // ourselves so the orchestrator can interleave UI prompts /
      // user-confirmation flows between tool calls.
      stopWhen: stepCountIs(1),
      abortSignal: req.signal,
    });

    // Coalesce tool calls until the stream finishes. AI SDK already
    // accumulates argument fragments per tool-call into a single event,
    // so this is effectively just "collect until finish".
    const collected: LlmStreamToolCall[] = [];
    // v0.1.210 — Usage wird vom AI-SDK auf `finish` mitgeliefert
    // (`totalUsage` / `usage`). Wir sammeln es hier und yielden es
    // auf dem terminalen Frame, damit der Orchestrator es in den
    // UsageStore schreiben kann.
    let collectedUsage: LlmUsageSnapshot | undefined;

    try {
      for await (const part of result.fullStream as AsyncIterable<
        TextStreamPart<ToolSet>
      >) {
        switch (part.type) {
          case "text-delta": {
            const delta = (part as { text?: string }).text ?? "";
            if (delta.length > 0) {
              yield { done: false, contentDelta: delta };
            }
            break;
          }
          case "tool-call": {
            const tc = part as {
              toolCallId: string;
              toolName: string;
              input?: unknown;
            };
            collected.push({
              id: tc.toolCallId,
              function: {
                name: tc.toolName,
                arguments:
                  tc.input == null
                    ? {}
                    : (tc.input as Record<string, unknown>),
              },
            });
            break;
          }
          case "error": {
            const err = (part as { error?: unknown }).error;
            // v0.1.7 diagnostic: dump the full error including the
            // cause chain so DevTools shows undici's underlying
            // ECONNRESET / TLS / etc., not just the SDK's wrapper.
            // eslint-disable-next-line no-console
            console.error(`[${this.kind}] stream error part:`, err, {
              cause: err instanceof Error ? (err as { cause?: unknown }).cause : undefined,
              stack: err instanceof Error ? err.stack : undefined,
            });
            const rawMsg =
              err instanceof Error
                ? err.message
                : typeof err === "string"
                  ? err
                  : "ai-sdk stream error";
            const msg = humanizeProviderError(this.kind, rawMsg);
            yield { done: true, errorMessage: msg };
            return;
          }
          case "finish":
          case "abort": {
            // v0.1.210 — Usage-Snapshot aus dem finish-Frame ziehen.
            // Schema je nach AI-SDK-Version etwas variant; wir lesen
            // defensiv beides (`totalUsage` neu, `usage` alt).
            const finishPart = part as unknown as {
              totalUsage?: Record<string, unknown>;
              usage?: Record<string, unknown>;
              providerMetadata?: Record<string, Record<string, unknown>>;
              response?: { headers?: Record<string, string> };
            };
            collectedUsage = extractUsageFromFinish(
              this.kind,
              finishPart,
            );
            yield {
              done: true,
              ...(collected.length > 0 ? { toolCalls: collected } : {}),
              ...(collectedUsage ? { usage: collectedUsage } : {}),
            };
            return;
          }
          default:
            // Ignore other event kinds (reasoning, sources, step-start,
            // step-finish, tool-input-* deltas) — the orchestrator
            // doesn't surface them yet. Adding visibility is a follow-up.
            break;
        }
      }
    } catch (err) {
      // streamText throws on auth errors / network failures before the
      // first frame. Translate into our terminal error frame so the
      // orchestrator's catch block treats the turn as a sticky error.
      //
      // v0.1.7 diagnostic: dump the full error + cause chain to
      // DevTools console. The wrapped message shown to the user often
      // hides the underlying network reason (e.g. SDK says
      // "Cannot connect to API: read ECONNRESET" but the cause has
      // the actual TLS or DNS detail).
      // eslint-disable-next-line no-console
      console.error(`[${this.kind}] streamText threw before first frame:`, err, {
        cause: err instanceof Error ? (err as { cause?: unknown }).cause : undefined,
        stack: err instanceof Error ? err.stack : undefined,
        name: err instanceof Error ? err.name : typeof err,
      });
      const msg = err instanceof Error ? err.message : String(err);
      yield { done: true, errorMessage: msg };
      return;
    }

    // Defensive: if the iterable ended without a `finish`/`abort` part
    // (shouldn't happen, but cheap to guard) emit a terminal anyway.
    yield {
      done: true,
      ...(collected.length > 0 ? { toolCalls: collected } : {}),
      ...(collectedUsage ? { usage: collectedUsage } : {}),
    };
  }

  private ollamaBaseURL(): string {
    const oll = this.supervisor?.getStatus();
    // ollama-ai-provider-v2 expects the `/api` suffix.
    return (oll?.host ?? "http://localhost:11434") + "/api";
  }
}

// ---- Translation helpers ---------------------------------------------------

/**
 * Translate AVA's internal `AgentMessage[]` into AI SDK's `ModelMessage[]`.
 * The shapes diverge in three ways the orchestrator is blind to:
 *  - assistant `tool_calls` become `content: [{ type: "tool-call", … }]`.
 *  - `tool` role messages become `content: [{ type: "tool-result", … }]`.
 *  - tool-call inputs are always objects, never the string-encoded JSON
 *    that some vendors (OpenAI) historically returned.
 */
function toModelMessages(messages: AgentMessage[]): ModelMessage[] {
  // v0.1.277 — Anti-corruption pass. Anthropic ist strikt: jeder text-
  // Content-Block muss non-empty sein, sonst lehnt das API mit
  // "messages: text content blocks must be non-empty" ab und der
  // ganze Turn schlägt fehl. Quellen für leere Texte in unserer History:
  //   - Abort mitten im Stream (assistantContent="" + ggf. toolCalls)
  //   - Tool-Result, dessen run() {} oder null returnt
  //   - Defekte alte Transcripts aus früheren Versionen
  // Strategie: (a) No-Op-Assistant-Turns rauswerfen, (b) für alle anderen
  // einen Platzhalter einsetzen damit Anthropic nicht 400t.
  const PLACEHOLDER = "[leer]";
  const safe = (s: string | null | undefined): string => {
    if (typeof s !== "string") return PLACEHOLDER;
    return s.trim().length > 0 ? s : PLACEHOLDER;
  };

  return messages
    .filter((m) => {
      if (m.role !== "assistant") return true;
      const hasContent =
        typeof m.content === "string" && m.content.trim().length > 0;
      const hasTools = m.toolCalls && m.toolCalls.length > 0;
      // Komplett leere Assistant-Messages (kein Text, keine Tools) sind
      // No-Op-Turns aus abgebrochenen Streams — raus damit.
      return hasContent || hasTools;
    })
    .map((m): ModelMessage => {
      if (m.role === "tool") {
        return {
          role: "tool",
          content: [
            {
              type: "tool-result",
              toolCallId: m.toolCallId ?? "",
              toolName: extractToolNameFromContent(m.content),
              output: { type: "text", value: safe(m.content) },
            },
          ],
        };
      }
      if (m.role === "system") {
        return { role: "system", content: safe(m.content) };
      }
      if (m.role === "user") {
        // v0.1.257 — wenn der Turn Bilder enthält, Multipart-Content. Die
        // AI-SDK normalisiert das pro-Provider (Anthropic → image_url,
        // OpenAI → image_url, Google → inlineData, …). Provider ohne
        // Vision lassen die Bilder im SDK-Adapter durchrutschen und
        // ignorieren sie — wir gaten zusätzlich im Renderer (D13).
        if (m.images && m.images.length > 0) {
          const parts: Array<
            | { type: "text"; text: string }
            | { type: "image"; image: string; mediaType?: string }
          > = [];
          if (m.content && m.content.trim().length > 0) {
            parts.push({ type: "text", text: m.content });
          }
          for (const img of m.images) {
            parts.push({
              type: "image",
              image: `data:${img.mimeType};base64,${img.base64}`,
              mediaType: img.mimeType,
            });
          }
          // Wenn kein text-Part UND keine Images (theoretisch unmöglich
          // weil images.length > 0 hier), kein leerer Content.
          return { role: "user", content: parts };
        }
        return { role: "user", content: safe(m.content) };
      }
      // assistant
      if (!m.toolCalls || m.toolCalls.length === 0) {
        return { role: "assistant", content: safe(m.content) };
      }
      const parts: Array<
        | { type: "text"; text: string }
        | {
            type: "tool-call";
            toolCallId: string;
            toolName: string;
            input: Record<string, unknown>;
          }
      > = [];
      if (m.content && m.content.trim().length > 0) {
        parts.push({ type: "text", text: m.content });
      }
      for (const tc of m.toolCalls) {
        const input =
          typeof tc.args === "string"
            ? safeJsonParseObject(tc.args)
            : ((tc.args ?? {}) as Record<string, unknown>);
        parts.push({
          type: "tool-call",
          toolCallId: tc.id,
          toolName: tc.name,
          input,
        });
      }
      return { role: "assistant", content: parts };
    });
}

function safeJsonParseObject(raw: string): Record<string, unknown> {
  try {
    const parsed = JSON.parse(raw);
    return typeof parsed === "object" && parsed !== null
      ? (parsed as Record<string, unknown>)
      : {};
  } catch {
    return {};
  }
}

/**
 * Tool-result messages don't carry the original tool name in our
 * AgentMessage shape — orchestrator pairs them by toolCallId. AI SDK's
 * tool-result part requires `toolName`, but it doesn't validate against
 * the tool registry, so an empty string would be accepted. We do the
 * minimal-effort thing: leave it blank when we can't recover it. The
 * orchestrator never reads it back.
 */
function extractToolNameFromContent(_content: string): string {
  return "";
}

/**
 * Wrap our internal `OllamaToolSpec[]` (raw JSON-Schema function
 * descriptors) into AI SDK's `ToolSet` format. Each tool becomes a
 * declaration-only entry — the orchestrator handles execution.
 */
function buildToolSet(specs: OllamaToolSpec[]): ToolSet {
  const out: ToolSet = {};
  for (const spec of specs) {
    out[spec.function.name] = tool({
      description: spec.function.description,
      inputSchema: jsonSchema(spec.function.parameters),
    });
  }
  return out;
}

/**
 * v0.1.186 — translate provider error strings into actionable German
 * for the chat UI. The renderer currently surfaces `errorMessage` as
 * a plain inline error bubble; raw Anthropic / OpenAI messages are
 * English, very long, and bury the actionable bit ("you're rate
 * limited, wait 30 s") under SDK boilerplate.
 *
 * We pattern-match on common cases and leave anything we don't
 * recognise untouched so unknown errors still surface verbatim.
 *
 * Recognised buckets:
 *   - Rate-limit (HTTP 429 / "rate limit" / "exceed your org's …"):
 *     tell the user we hit the per-minute input-token cap and what
 *     to do (warten / Tier upgraden).
 *   - Auth / 401 / invalid key: tell them to re-enter the key in
 *     Settings — we don't echo the key.
 *   - Quota / 402 / "insufficient_quota": tell them billing is the
 *     issue (kein Tier-Wechsel, sondern Guthaben).
 */
function humanizeProviderError(kind: LlmProviderKind, raw: string): string {
  const lower = raw.toLowerCase();
  const label = labelFor(kind);

  // Rate-limit (both Anthropic "exceed your organization's rate limit"
  // and OpenAI "rate_limit_exceeded" / "429").
  if (
    lower.includes("rate limit") ||
    lower.includes("rate_limit") ||
    lower.includes("429") ||
    lower.includes("too many requests")
  ) {
    // Try to surface the specific numeric limit if Anthropic gave one.
    const tokenLimitMatch = raw.match(
      /rate limit of\s+([\d.,]+)\s+input tokens per minute/i,
    );
    const limitDetail = tokenLimitMatch
      ? ` (Limit: ${tokenLimitMatch[1]} Eingabe-Tokens pro Minute)`
      : "";
    // v0.1.209 — `retry-after`-Wert aus der Fehlermeldung extrahieren,
    // falls vorhanden. Anthropic schreibt das in den Body als
    // `Please retry after 23 seconds` o. Ä.
    const retryMatch = raw.match(/retry[- ]?after[: ]+(\d+)\s*(seconds|s)\b/i);
    const retryDetail = retryMatch
      ? ` Anthropic empfiehlt ${retryMatch[1]} Sekunden Wartezeit.`
      : " Bitte 30–60 Sekunden warten und erneut versuchen.";

    // v0.1.209 — Anthropic-spezifisch: direkter Deeplink zur Console-
    // Limits-Seite + Tier-2-Erklärung. Für andere Provider bleibt der
    // generische Hinweis.
    if (kind === "anthropic") {
      return (
        `Anthropic: Minutenlimit erreicht${limitDetail}.${retryDetail}\n\n` +
        `Anthropics Standard-Tier (Tier 1) liegt bei 30 000 Input-Tokens ` +
        `pro Minute — bei längeren Recherchen knapp. Tier 2 verdoppelt ` +
        `das Limit und schaltet automatisch frei, sobald 5 USD über ` +
        `die API verbraucht oder vorab eingezahlt wurden. ` +
        `Status prüfen: https://console.anthropic.com/settings/limits`
      );
    }
    return (
      `${label}: Anfrage-Limit pro Minute überschritten${limitDetail}.${retryDetail} ` +
      `Falls das häufig passiert, kannst du in deinem ${label}-Konto ` +
      `den Tier (Guthaben aufladen) erhöhen, um das Limit anzuheben.`
    );
  }

  // Auth / invalid key.
  if (
    lower.includes("401") ||
    lower.includes("invalid_api_key") ||
    lower.includes("authentication") ||
    lower.includes("unauthorized") ||
    lower.includes("invalid authentication")
  ) {
    return (
      `${label}: Authentifizierung fehlgeschlagen. ` +
      `Bitte API-Key in den Einstellungen prüfen und ggf. neu eintragen.`
    );
  }

  // Quota / billing.
  if (
    lower.includes("insufficient_quota") ||
    lower.includes("billing") ||
    lower.includes("402") ||
    lower.includes("payment required") ||
    lower.includes("purchase credits")
  ) {
    return (
      `${label}: Kein Guthaben mehr auf dem API-Konto. ` +
      `Bitte im ${label}-Konto Guthaben aufladen, dann erneut versuchen.`
    );
  }

  // Model not found / wrong model id.
  if (
    lower.includes("model_not_found") ||
    lower.includes("does not exist") ||
    (lower.includes("model") && lower.includes("not found"))
  ) {
    return (
      `${label}: Das gewählte Modell ist mit deinem Konto nicht verfügbar. ` +
      `Bitte in den Einstellungen ein anderes Modell wählen.`
    );
  }

  // Fall-through: prefix with the provider label so it's clear who
  // failed, but otherwise pass the raw message through.
  return `${label}: ${raw}`;
}

function labelFor(kind: LlmProviderKind): string {
  switch (kind) {
    case "ollama":
      return "Ollama";
    case "openai":
      return "OpenAI";
    case "anthropic":
      return "Anthropic";
    case "google":
      return "Google";
    case "mistral":
      return "Mistral";
  }
}

// ---- v0.1.210 — Usage-Extraktor -------------------------------------------
//
// Liest aus dem AI-SDK-finish-Part:
//   - totalUsage / usage: { inputTokens, outputTokens, ... }
//   - providerMetadata.anthropic: { cacheCreationInputTokens, cacheReadInputTokens }
//   - response.headers: rate-limit-Header pro Provider
//
// Provider-spezifische Header werden in `quotaSnapshot` aggregiert. UI
// rendert nur, was tatsächlich gesetzt wurde.

function extractUsageFromFinish(
  kind: LlmProviderKind,
  part: {
    totalUsage?: Record<string, unknown>;
    usage?: Record<string, unknown>;
    providerMetadata?: Record<string, Record<string, unknown>>;
    response?: { headers?: Record<string, string> };
  },
): LlmUsageSnapshot | undefined {
  const u = (part.totalUsage ?? part.usage ?? {}) as Record<string, unknown>;
  const num = (v: unknown): number | undefined =>
    typeof v === "number" && Number.isFinite(v) ? v : undefined;
  const inputTokens =
    num(u.inputTokens) ?? num(u.promptTokens) ?? num(u.input_tokens);
  const outputTokens =
    num(u.outputTokens) ?? num(u.completionTokens) ?? num(u.output_tokens);
  // Anthropic-Cache: in providerMetadata.anthropic. AI-SDK 5 mappt das
  // teilweise auch nach totalUsage.cachedInputTokens / nicht-standard.
  const anth = part.providerMetadata?.anthropic ?? {};
  const cacheReadTokens =
    num((anth as Record<string, unknown>).cacheReadInputTokens) ??
    num(u.cachedInputTokens);
  const cacheWriteTokens = num(
    (anth as Record<string, unknown>).cacheCreationInputTokens,
  );
  const quotaSnapshot = headersToQuotaSnapshot(kind, part.response?.headers);

  const empty =
    inputTokens == null &&
    outputTokens == null &&
    cacheReadTokens == null &&
    cacheWriteTokens == null &&
    !quotaSnapshot;
  if (empty) return undefined;
  return {
    ...(inputTokens != null ? { inputTokens } : {}),
    ...(outputTokens != null ? { outputTokens } : {}),
    ...(cacheReadTokens != null ? { cacheReadTokens } : {}),
    ...(cacheWriteTokens != null ? { cacheWriteTokens } : {}),
    ...(quotaSnapshot ? { quotaSnapshot } : {}),
  };
}

/**
 * Pro Provider die Rate-Limit-Header in eine getypte QuotaSnapshot
 * mappen. Was wir kennen, kommt in die strukturierten Felder; den Rest
 * legen wir als `raw` ab — die UI kann selber entscheiden was sie
 * davon rendert.
 */
function headersToQuotaSnapshot(
  kind: LlmProviderKind,
  headers: Record<string, string> | undefined,
): NonNullable<LlmUsageSnapshot["quotaSnapshot"]> | undefined {
  if (!headers || Object.keys(headers).length === 0) return undefined;
  const lower: Record<string, string> = {};
  for (const [k, v] of Object.entries(headers)) lower[k.toLowerCase()] = v;
  const out: NonNullable<LlmUsageSnapshot["quotaSnapshot"]> = {};
  const num = (k: string): number | undefined => {
    const v = lower[k];
    if (v == null) return undefined;
    const n = parseInt(v, 10);
    return Number.isFinite(n) ? n : undefined;
  };
  const raw: Record<string, string> = {};

  if (kind === "anthropic") {
    const i = num("anthropic-ratelimit-input-tokens-remaining");
    const o = num("anthropic-ratelimit-output-tokens-remaining");
    const r = num("anthropic-ratelimit-requests-remaining");
    if (i != null) out.inputTokensRemaining = i;
    if (o != null) out.outputTokensRemaining = o;
    if (r != null) out.requestsRemaining = r;
    const reset = lower["anthropic-ratelimit-input-tokens-reset"];
    if (reset) out.resetAt = reset;
    // Anthropic-OAuth-Abo-Priority-Window (falls Anthropic ihn jemals
    // surface't — Stand 2026-05 inkonsistent dokumentiert). Wir
    // legen alle anthropic-Header zusätzlich roh ab.
    for (const [k, v] of Object.entries(lower)) {
      if (k.startsWith("anthropic-ratelimit-")) raw[k] = v;
    }
  } else if (kind === "openai") {
    const i = num("x-ratelimit-remaining-tokens");
    const r = num("x-ratelimit-remaining-requests");
    if (i != null) out.inputTokensRemaining = i;
    if (r != null) out.requestsRemaining = r;
    const reset = lower["x-ratelimit-reset-tokens"];
    if (reset) out.resetAt = reset;
    for (const [k, v] of Object.entries(lower)) {
      if (k.startsWith("x-ratelimit-")) raw[k] = v;
    }
  } else if (kind === "mistral") {
    const i = num("ratelimit-remaining-tokens");
    const r = num("ratelimit-remaining-requests");
    if (i != null) out.inputTokensRemaining = i;
    if (r != null) out.requestsRemaining = r;
    const reset = lower["ratelimit-reset"];
    if (reset) out.resetAt = reset;
    for (const [k, v] of Object.entries(lower)) {
      if (k.startsWith("ratelimit-")) raw[k] = v;
    }
  }
  // Google + Ollama: aktuell keine zuverlässigen Rate-Limit-Header.

  const empty =
    out.inputTokensRemaining == null &&
    out.outputTokensRemaining == null &&
    out.requestsRemaining == null &&
    out.resetAt == null &&
    Object.keys(raw).length === 0;
  if (empty) return undefined;
  if (Object.keys(raw).length > 0) out.raw = raw;
  return out;
}

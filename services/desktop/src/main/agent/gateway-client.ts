// Gateway HTTP client used by agent tools.
//
// Why a thin wrapper instead of letting each tool call fetch directly:
//   - Auth: every call needs a fresh access token. The Auth service in
//     main owns the OIDC flow and refresh; tools shouldn't know that
//     contract. We funnel through `getAccessToken()`.
//   - Errors: the gateway returns `{ message, code, ... }` on 4xx/5xx.
//     Surfacing those messages back to the model dramatically improves
//     recovery — the agent often rephrases the query or backs off.
//   - Aborts: tools receive a cancellation signal from the orchestrator;
//     we wire it into fetch so a stop-button click really stops the HTTP
//     request mid-flight.

/**
 * Active LLM provider context — Option D BYO-key passthrough.
 *
 *   { provider: "openai", key: "sk-...", model: "gpt-4o-mini" }
 *
 * The desktop owns the user's API key (encrypted in safeStorage,
 * decrypted on demand). Dispatch tools attach it on outbound
 * gateway calls so the producers running on fly can use it for
 * LLM calls without ever holding a copy at rest.
 */
export interface UserLlmContext {
  provider: string;
  key: string;
  model?: string;
}

export interface GatewayClientDeps {
  /** Static gateway URL (no trailing slash). Captured at construction. */
  baseUrl: string;
  /** Returns a fresh-enough access token, or throws if signed out. */
  getAccessToken: () => Promise<string | null>;
  /**
   * Returns the user's active LLM provider + key, or null when
   * no provider is configured (e.g. user hasn't run the first-run
   * wizard yet). Only called for requests with `attachUserLlm: true`.
   * Returning null means "no headers attached, producer falls back
   * to env-baked LLM" — the same behaviour as legacy clients.
   */
  getUserLlm?: () => Promise<UserLlmContext | null>;
}

/** Query value: scalar, repeated as an array, or undefined to skip. */
export type QueryValue =
  | string
  | number
  | boolean
  | undefined
  | Array<string | number | boolean>;

export interface RequestOptions {
  method?: "GET" | "POST" | "PUT" | "DELETE";
  query?: Record<string, QueryValue>;
  /**
   * JSON-serialisable body. For binary uploads use `multipart` instead —
   * we treat the two paths separately so the JSON branch can stay simple
   * (auto Content-Type: application/json) without sniffing the body for
   * FormData / Blob.
   */
  body?: unknown;
  /**
   * `multipart/form-data` body. The runtime fetch (Node 20+ / Electron)
   * sets Content-Type with the right boundary automatically; we just
   * hand it the FormData. Used by `import_excel` for spreadsheet upload.
   */
  multipart?: FormData;
  signal?: AbortSignal;
  /** Set on writes to make the gateway dedupe replays (Phase 7 work). */
  idempotencyKey?: string;
  /**
   * Opt-in: attach `X-Ava-User-Llm-{Provider,Key,Model}` headers from
   * the active provider. Set on dispatch endpoints (`/v1/imports/excel`,
   * `/v1/companies` POST) so master-data can forward them as AMQP
   * headers to producers. Read endpoints leave this off — no reason
   * to broadcast the user's key on every paginated list query.
   */
  attachUserLlm?: boolean;
}

export class GatewayClient {
  private readonly baseUrl: string;
  private readonly getAccessToken: () => Promise<string | null>;
  private readonly getUserLlm?: () => Promise<UserLlmContext | null>;

  constructor(deps: GatewayClientDeps) {
    this.baseUrl = deps.baseUrl.replace(/\/+$/, "");
    this.getAccessToken = deps.getAccessToken;
    this.getUserLlm = deps.getUserLlm;
  }

  async request<T = unknown>(path: string, opts: RequestOptions = {}): Promise<T> {
    const token = await this.getAccessToken();
    if (!token) {
      throw new Error("not signed in (no access token available)");
    }

    const url = new URL(this.baseUrl + (path.startsWith("/") ? path : `/${path}`));
    if (opts.query) {
      for (const [k, v] of Object.entries(opts.query)) {
        if (v === undefined || v === null) continue;
        if (Array.isArray(v)) {
          // Repeated key form (`?foo=a&foo=b`) — what the gateway's
          // `companyNameIdentifiers[]` and `city[]` params expect.
          for (const item of v) {
            if (item === undefined || item === null) continue;
            url.searchParams.append(k, String(item));
          }
        } else {
          url.searchParams.set(k, String(v));
        }
      }
    }

    const headers: Record<string, string> = {
      authorization: `Bearer ${token}`,
      accept: "application/json",
    };
    let body: string | FormData | undefined;
    if (opts.multipart !== undefined) {
      // Don't set content-type here — fetch fills in the multipart
      // boundary. Manually setting it would break the upload.
      body = opts.multipart;
    } else if (opts.body !== undefined) {
      headers["content-type"] = "application/json";
      body = JSON.stringify(opts.body);
    }
    if (opts.idempotencyKey) headers["idempotency-key"] = opts.idempotencyKey;

    if (opts.attachUserLlm && this.getUserLlm) {
      const llm = await this.getUserLlm().catch(() => null);
      if (llm?.provider && llm?.key) {
        headers["x-ava-user-llm-provider"] = llm.provider;
        headers["x-ava-user-llm-key"] = llm.key;
        if (llm.model) headers["x-ava-user-llm-model"] = llm.model;
      }
      // No header == producer uses its env-baked LLM. Logged at trace
      // level only — info-level would print on every dispatch.
    }

    const res = await fetch(url, {
      method: opts.method ?? "GET",
      headers,
      body,
      signal: opts.signal,
    });

    // Always read text first — a 502 from the gateway often comes with an
    // HTML body from upstream which would crash res.json(). We try JSON and
    // fall back to a string snippet for the error message.
    const text = await res.text();
    if (!res.ok) {
      let message = `gateway ${res.status}`;
      try {
        const parsed = JSON.parse(text) as { message?: string; code?: string };
        if (parsed.message) message = `${message}: ${parsed.message}`;
        if (parsed.code) message += ` [${parsed.code}]`;
      } catch {
        if (text) message += `: ${text.slice(0, 160)}`;
      }
      throw new Error(message);
    }
    if (!text) return undefined as unknown as T;
    try {
      return JSON.parse(text) as T;
    } catch (err) {
      throw new Error(
        `gateway returned non-JSON body for ${path}: ${
          err instanceof Error ? err.message : String(err)
        }`,
      );
    }
  }
}

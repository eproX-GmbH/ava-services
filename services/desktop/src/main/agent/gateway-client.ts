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

export interface GatewayClientDeps {
  /** Static gateway URL (no trailing slash). Captured at construction. */
  baseUrl: string;
  /** Returns a fresh-enough access token, or throws if signed out. */
  getAccessToken: () => Promise<string | null>;
}

export interface RequestOptions {
  method?: "GET" | "POST" | "PUT" | "DELETE";
  query?: Record<string, string | number | boolean | undefined>;
  body?: unknown;
  signal?: AbortSignal;
  /** Set on writes to make the gateway dedupe replays (Phase 7 work). */
  idempotencyKey?: string;
}

export class GatewayClient {
  private readonly baseUrl: string;
  private readonly getAccessToken: () => Promise<string | null>;

  constructor(deps: GatewayClientDeps) {
    this.baseUrl = deps.baseUrl.replace(/\/+$/, "");
    this.getAccessToken = deps.getAccessToken;
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
        url.searchParams.set(k, String(v));
      }
    }

    const headers: Record<string, string> = {
      authorization: `Bearer ${token}`,
      accept: "application/json",
    };
    let body: string | undefined;
    if (opts.body !== undefined) {
      headers["content-type"] = "application/json";
      body = JSON.stringify(opts.body);
    }
    if (opts.idempotencyKey) headers["idempotency-key"] = opts.idempotencyKey;

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

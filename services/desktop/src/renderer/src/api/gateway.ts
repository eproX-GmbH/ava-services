import { getAccessToken, getGatewayUrl } from "../store/config";

// Tiny gateway client.
//
// Every call goes through `gatewayFetch` so request-id, auth header, and
// JSON parsing live in one place. We deliberately don't pull in axios /
// ky etc. — the gateway's contract is small and the wrapper stays one
// page, which is easier to reason about than another dependency.

export class GatewayError extends Error {
  constructor(
    message: string,
    public readonly status: number,
    public readonly body: unknown,
  ) {
    super(message);
  }
}

function newRequestId(): string {
  // crypto.randomUUID exists in renderer (Chromium).
  return crypto.randomUUID();
}

interface GatewayOptions {
  method?: "GET" | "POST" | "PUT" | "DELETE";
  query?: Record<string, string | number | boolean | string[] | undefined>;
  body?: unknown;
  signal?: AbortSignal;
}

export async function gatewayFetch<T>(path: string, opts: GatewayOptions = {}): Promise<T> {
  const url = new URL(path.startsWith("/") ? path : `/${path}`, getGatewayUrl());
  if (opts.query) {
    for (const [k, v] of Object.entries(opts.query)) {
      if (v === undefined) continue;
      if (Array.isArray(v)) for (const item of v) url.searchParams.append(k, String(item));
      else url.searchParams.set(k, String(v));
    }
  }

  const headers: Record<string, string> = {
    "x-request-id": newRequestId(),
  };
  const token = getAccessToken();
  if (token) headers["authorization"] = `Bearer ${token}`;
  if (opts.body !== undefined) headers["content-type"] = "application/json";

  const res = await fetch(url, {
    method: opts.method ?? "GET",
    headers,
    body: opts.body === undefined ? undefined : JSON.stringify(opts.body),
    signal: opts.signal,
  });

  const text = await res.text();
  const parsed = text ? safeParse(text) : undefined;
  if (!res.ok) {
    throw new GatewayError(
      typeof parsed === "object" && parsed && "message" in parsed
        ? String((parsed as { message: unknown }).message)
        : `gateway ${res.status}`,
      res.status,
      parsed,
    );
  }
  return parsed as T;
}

function safeParse(s: string): unknown {
  try {
    return JSON.parse(s);
  } catch {
    return s;
  }
}

// SSE wrapper.
//
// Native EventSource doesn't support custom headers (Authorization). For v0
// we rely on the gateway accepting the bearer via cookie or query param;
// long-term the right answer is the @microsoft/fetch-event-source polyfill
// (uses fetch streaming, supports headers). Tracked as Step 6 follow-up.
//
// Returns a teardown function. Call it from the component's effect cleanup.
export function gatewaySSE(
  path: string,
  onEvent: (ev: { type: string; data: unknown }) => void,
  onError?: (err: Event) => void,
): () => void {
  const url = new URL(path.startsWith("/") ? path : `/${path}`, getGatewayUrl());
  const token = getAccessToken();
  // Stop-gap: pass token as query param. Gateway must support this for the
  // SSE route; if it doesn't yet, the auth middleware will reject and we'll
  // see it in the error handler.
  if (token) url.searchParams.set("access_token", token);

  const es = new EventSource(url.toString());
  es.onmessage = (e) => onEvent({ type: "message", data: safeParse(e.data) });
  es.addEventListener("progress", (e) =>
    onEvent({ type: "progress", data: safeParse((e as MessageEvent).data) }),
  );
  es.addEventListener("ping", (e) =>
    onEvent({ type: "ping", data: safeParse((e as MessageEvent).data) }),
  );
  es.onerror = (e) => onError?.(e);
  return () => es.close();
}

import type { Context } from "hono";
import { HTTPException } from "hono/http-exception";
import { loadEnv } from "./env";
import { logger } from "./logger";

// Upstream fetch helper.
//
// Forwards the caller's Bearer token so the upstream service can apply its
// existing JWT validation (same JWKS as today's services). Also forwards the
// X-Request-Id so audit traces stitch across the hop.
//
// Per D11 the gateway is online-only — we surface upstream failures as plain
// 5xx to the caller rather than retry. The Desktop-App is expected to show
// a clear error, not a degraded mode.

export type UpstreamName =
  | "masterData"
  | "companyProfile"
  | "companyContact"
  | "companyPublication"
  | "companyEvaluation"
  | "website"
  | "structuredContent";

function baseUrlFor(name: UpstreamName): string {
  const env = loadEnv();
  switch (name) {
    case "masterData":
      return env.UPSTREAM_MASTER_DATA_URL;
    case "companyProfile":
      return env.UPSTREAM_COMPANY_PROFILE_URL;
    case "companyContact":
      return env.UPSTREAM_COMPANY_CONTACT_URL;
    case "companyPublication":
      return env.UPSTREAM_COMPANY_PUBLICATION_URL;
    case "companyEvaluation":
      return env.UPSTREAM_COMPANY_EVALUATION_URL;
    case "website":
      return env.UPSTREAM_WEBSITE_URL;
    case "structuredContent":
      return env.UPSTREAM_STRUCTURED_CONTENT_URL;
  }
}

interface UpstreamOptions {
  method?: "GET" | "POST" | "PUT" | "DELETE";
  query?: Record<string, string | number | undefined>;
  body?: unknown;
}

export async function callUpstream<T = unknown>(
  c: Context,
  name: UpstreamName,
  path: string,
  opts: UpstreamOptions = {},
): Promise<T> {
  const base = baseUrlFor(name);
  const url = new URL(path, base);
  if (opts.query) {
    for (const [k, v] of Object.entries(opts.query)) {
      if (v !== undefined) url.searchParams.set(k, String(v));
    }
  }

  const headers: Record<string, string> = {
    "content-type": "application/json",
    "x-request-id": c.get("requestId"),
  };
  const auth = c.req.header("authorization");
  if (auth) headers["authorization"] = auth;

  const res = await fetch(url, {
    method: opts.method ?? "GET",
    headers,
    body: opts.body === undefined ? undefined : JSON.stringify(opts.body),
  });

  if (!res.ok) {
    // Read the body for log context but don't leak upstream internals to the caller.
    const bodySnippet = await res.text().catch(() => "");
    logger.warn(
      {
        upstream: name,
        path,
        status: res.status,
        body: bodySnippet.slice(0, 500),
        requestId: c.get("requestId"),
      },
      "upstream call failed",
    );
    // 404 passes through; everything else becomes a 502 Bad Gateway.
    if (res.status === 404) throw new HTTPException(404, { message: "not_found" });
    throw new HTTPException(502, { message: `upstream_${name}_failed` });
  }

  // Services return JSON; guard against empty bodies.
  const text = await res.text();
  if (!text) return undefined as T;
  return JSON.parse(text) as T;
}

// Binary upstream call.
//
// Used for endpoints that take a raw binary body (file uploads) and where we
// care about response headers more than the response body — e.g. the §5.1
// excel import: master-data's `POST /api/v1/data-care` consumes
// `application/octet-stream` and signals the persisted transactionId via the
// `Transaction-Id` response header (the body is the legacy xlsx report we
// don't need on the desktop async path).
//
// We don't share `callUpstream`'s code path because the content-type, body
// pass-through, and "headers-not-body" return contract diverge enough that
// branching the existing helper would muddy it.

interface UpstreamBinaryOptions {
  query?: Record<string, string | number | string[] | undefined>;
  contentType?: string;
}

export interface UpstreamBinaryResult {
  status: number;
  headers: Headers;
}

export async function callUpstreamBinary(
  c: Context,
  name: UpstreamName,
  path: string,
  body: ArrayBuffer | Uint8Array,
  opts: UpstreamBinaryOptions = {},
): Promise<UpstreamBinaryResult> {
  const base = baseUrlFor(name);
  const url = new URL(path, base);
  if (opts.query) {
    for (const [k, v] of Object.entries(opts.query)) {
      if (v === undefined) continue;
      if (Array.isArray(v)) {
        // Express parses repeated `?key=a&key=b` as string[] — match that.
        for (const item of v) url.searchParams.append(k, String(item));
      } else {
        url.searchParams.set(k, String(v));
      }
    }
  }

  const headers: Record<string, string> = {
    "content-type": opts.contentType ?? "application/octet-stream",
    "x-request-id": c.get("requestId"),
  };
  const auth = c.req.header("authorization");
  if (auth) headers["authorization"] = auth;

  // TS lib.dom's BodyInit doesn't currently accept Uint8Array under all
  // @types/node + @types/bun matrices we run on (the union widens to
  // ArrayBuffer | Uint8Array<ArrayBufferLike> after Node 22). Cast at the
  // boundary — the runtime accepts both forms identically since fetch
  // delegates to undici/Node's HTTP layer.
  const res = await fetch(url, {
    method: "POST",
    headers,
    body: body as unknown as BodyInit,
  });

  if (!res.ok) {
    const bodySnippet = await res.text().catch(() => "");
    logger.warn(
      {
        upstream: name,
        path,
        status: res.status,
        body: bodySnippet.slice(0, 500),
        requestId: c.get("requestId"),
      },
      "upstream binary call failed",
    );
    if (res.status === 404) throw new HTTPException(404, { message: "not_found" });
    if (res.status === 413) throw new HTTPException(413, { message: "payload_too_large" });
    // Forward client-error statuses (400/422 etc.) so the Desktop sees the
    // upstream's validation message instead of an opaque 502. Server-side
    // failures (5xx, network errors) still map to 502 — the upstream is
    // unreachable from the client's perspective.
    if (res.status >= 400 && res.status < 500) {
      throw new HTTPException(res.status as 400, {
        message: bodySnippet || `upstream_${name}_${res.status}`,
      });
    }
    throw new HTTPException(502, { message: `upstream_${name}_failed` });
  }

  // Drain the body so the connection can be reused; we don't need it.
  await res.arrayBuffer().catch(() => undefined);
  return { status: res.status, headers: res.headers };
}

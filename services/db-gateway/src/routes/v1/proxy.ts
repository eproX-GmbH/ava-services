// §8.v3 — operator-paid API key proxies.
//
// Some producer code paths use APIs the operator pays for, not the
// user (today: only valueserp). Localizing those producers naively
// would require shipping the operator's key inside the desktop
// binary, which is a fundamental DRM problem — any user who reads
// the binary recovers the key. We mediate instead: the desktop POSTs
// to `/v1/proxy/<service>` with a JWT, the gateway reads its own
// fly-secret, makes the upstream call, and returns the response.
//
// Two practical effects:
//   - Operator's key never leaves db-gateway memory.
//   - Operator can rotate / revoke / rate-limit per tenant without
//     touching the desktop bundle.
//
// Compute (parsing/scoring/classification) still runs locally in the
// producer subprocess. Only the upstream HTTP hop is server-mediated.

import { OpenAPIHono } from "@hono/zod-openapi";
import { HTTPException } from "hono/http-exception";
import { loadEnv } from "../../lib/env";
import { logger } from "../../lib/logger";

export const proxyRouter = new OpenAPIHono();

const env = loadEnv();

// ---- valueserp ------------------------------------------------------------
//
// Pass-through to https://api.valueserp.com/search. The desktop sends
// the search params it wants (`q`, `num`, `location`, `gl`, `hl`); the
// gateway adds `api_key` from its env and forwards. We deliberately
// allow-list params instead of blindly forwarding the request body —
// keeps the surface small and prevents a malicious client from e.g.
// pointing the call at a different valueserp endpoint.

interface ValueserpRequest {
  q: string;
  num?: number;
  location?: string;
  gl?: string;
  hl?: string;
}

const VALUESERP_ENDPOINT = "https://api.valueserp.com/search";

proxyRouter.post("/v1/proxy/valueserp", async (c) => {
  if (!env.VALUESERP_API_KEY) {
    logger.error("VALUESERP_API_KEY not set on gateway");
    throw new HTTPException(503, {
      message: "valueserp_proxy_unconfigured",
    });
  }

  let body: ValueserpRequest;
  try {
    body = (await c.req.json()) as ValueserpRequest;
  } catch {
    throw new HTTPException(400, { message: "invalid_json" });
  }
  if (!body?.q || typeof body.q !== "string") {
    throw new HTTPException(400, { message: "missing_query_param_q" });
  }

  const params = new URLSearchParams();
  params.set("api_key", env.VALUESERP_API_KEY);
  params.set("q", body.q);
  if (body.num != null) params.set("num", String(body.num));
  if (body.location) params.set("location", body.location);
  if (body.gl) params.set("gl", body.gl);
  if (body.hl) params.set("hl", body.hl);

  const auth = c.get("auth");
  const url = `${VALUESERP_ENDPOINT}?${params.toString()}`;

  const upstream = await fetch(url, { method: "GET" });
  const text = await upstream.text();

  if (!upstream.ok) {
    logger.warn(
      {
        tenantId: auth?.tenantId,
        actorId: auth?.actorId,
        status: upstream.status,
        // Don't log `q` at warn level — it's user search content
        // (potentially PII / business-sensitive).
        bodySnippet: text.slice(0, 200),
      },
      "valueserp upstream non-2xx",
    );
    // Pass status through unless it's 401 (would imply our key was
    // revoked — a 401 to the client would be misleading; surface as
    // 503 so the desktop retries / surfaces "service unavailable").
    if (upstream.status === 401 || upstream.status === 403) {
      throw new HTTPException(503, { message: "valueserp_auth_failed" });
    }
    if (upstream.status === 429) {
      throw new HTTPException(429, { message: "valueserp_rate_limited" });
    }
    throw new HTTPException(502, { message: "valueserp_upstream_failed" });
  }

  // Parse + return as JSON. Keep the full body so callers can read
  // `organic_results`, `related_searches`, etc. without us dictating
  // the shape — the existing producer SDK already knows it.
  try {
    const parsed = JSON.parse(text);
    return c.json(parsed);
  } catch {
    throw new HTTPException(502, {
      message: "valueserp_upstream_invalid_json",
    });
  }
});

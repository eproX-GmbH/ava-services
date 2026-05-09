// v0.1.54 — OAuth Authorization Code + PKCE flow for CRM providers.
//
// Mirrors the Keycloak flow in main/auth.ts: open the system browser
// to the provider's authorize URL, capture the redirect on a
// loopback HTTP server, send the code to the gateway's CRM proxy
// for token exchange, return the access + refresh tokens.
//
// Why the gateway proxies token exchange (despite this being a
// public-client flow for Salesforce + Dynamics):
//   1. HubSpot needs `client_secret` — desktop binaries can't safely
//      embed it. Operator-side fly secret is the right home.
//   2. One uniform code path for all 3 providers — easier to reason
//      about + audit; provider-specific quirks live on one side.
//   3. Future: gateway can mint short-lived access tokens for the
//      user's API calls without ever exposing the long-lived refresh
//      token to the renderer process.

import { createHash, randomBytes } from "node:crypto";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { shell, app, BrowserWindow } from "electron";
import type { CrmProvider, CrmTokens } from "./types";

interface AuthorizeUrlPayload {
  authorizeUrl: string;
  /** Random state we generated; same value comes back as a query
   *  param in the redirect. CSRF guard. */
  state: string;
  /** PKCE verifier we generated. Server stored only the challenge;
   *  we send the verifier with the code-exchange request. */
  codeVerifier: string;
  /** Loopback redirect_uri the IdP will hit; we listen there. */
  redirectUri: string;
}

interface GatewayExchangeResponse {
  accessToken: string;
  refreshToken: string | null;
  expiresIn: number;
  /** Provider-specific extras the gateway extracted from the IdP
   *  response and forwards verbatim (e.g. instance_url). */
  extra: Record<string, string>;
  /** Best-effort display label the gateway derived from the token
   *  response (org name + user email when the IdP returns it). */
  account: string;
}

const STATE_BYTES = 32;
const VERIFIER_BYTES = 32;
const FLOW_TIMEOUT_MS = 5 * 60_000;

/**
 * Fixed loopback port for the OAuth redirect (v0.1.55).
 *
 * Why fixed instead of ephemeral: HubSpot enforces exact-match on
 * redirect URIs and won't accept wildcards or "any port". Salesforce
 * and Microsoft Identity both work with a fixed port, so we
 * standardize on one across all three providers.
 *
 * 51080 was picked to sit in the same band as the local producer
 * subprocess ports (51010-51060) for operator clarity, but stays
 * outside the producer range so a producer collision is impossible.
 *
 * On `localhost` rather than `127.0.0.1`: HubSpot's HTTP allowlist
 * accepts only the literal string `http://localhost` for non-HTTPS
 * redirects (RFC 8252 mentions both as equivalent, but HubSpot
 * disagrees). `localhost` resolves to 127.0.0.1 anyway, so binding
 * the loopback server on 127.0.0.1 + advertising the redirect with
 * the `localhost` hostname is functionally identical.
 */
const LOOPBACK_HOST = "localhost";
const LOOPBACK_PORT = 51080;

/**
 * Run the full connect flow end-to-end:
 *   1. Build authorize URL (via gateway helper that knows each
 *      provider's URL + scopes + client_id).
 *   2. Boot loopback server, open browser to authorize URL.
 *   3. Wait for callback containing the auth code.
 *   4. Send code + verifier to gateway exchange.
 *   5. Return tokens + account label.
 */
export async function runConnectFlow(opts: {
  provider: CrmProvider;
  /** Bearer for gateway calls — same JWT the rest of the app uses. */
  bearer: string;
  /** Gateway base URL. */
  gatewayUrl: string;
  /** Optional org URL (Dynamics needs it; passed straight to gateway). */
  orgUrl?: string;
}): Promise<{ tokens: CrmTokens; account: string }> {
  const { provider, bearer, gatewayUrl, orgUrl } = opts;

  // 1 + 2: ask the gateway for the authorize URL parameters. The
  // gateway holds client_id and scope strings per provider; we just
  // get back a ready-to-open URL plus the PKCE verifier we'll need
  // at exchange time.
  const verifier = base64url(randomBytes(VERIFIER_BYTES));
  const challenge = base64url(createHash("sha256").update(verifier).digest());
  const state = base64url(randomBytes(STATE_BYTES));

  const { code, redirectUri } = await runLoopbackFlow(
    state,
    async (port) => {
      const redirectUri = `http://${LOOPBACK_HOST}:${port}/callback`;
      const params = new URLSearchParams({
        provider,
        codeChallenge: challenge,
        state,
        redirectUri,
        ...(orgUrl ? { orgUrl } : {}),
      });
      const res = await fetch(
        `${gatewayUrl.replace(/\/+$/, "")}/v1/crm/${encodeURIComponent(provider)}/authorize-url?${params.toString()}`,
        { headers: { authorization: `Bearer ${bearer}` } },
      );
      if (!res.ok) {
        const body = await res.text().catch(() => "");
        throw new Error(
          `gateway authorize-url failed: ${res.status} ${body.slice(0, 200)}`,
        );
      }
      const payload = (await res.json()) as AuthorizeUrlPayload;
      void shell.openExternal(payload.authorizeUrl);
    },
  );

  // 3 + 4: exchange the code at the gateway. Gateway hits the
  // provider's token endpoint with whatever credentials the operator
  // configured (client_secret for HubSpot, none for the others).
  const exchangeRes = await fetch(
    `${gatewayUrl.replace(/\/+$/, "")}/v1/crm/${encodeURIComponent(provider)}/exchange`,
    {
      method: "POST",
      headers: {
        authorization: `Bearer ${bearer}`,
        "content-type": "application/json",
      },
      body: JSON.stringify({
        provider,
        code,
        codeVerifier: verifier,
        redirectUri,
        ...(orgUrl ? { orgUrl } : {}),
      }),
    },
  );
  if (!exchangeRes.ok) {
    const body = await exchangeRes.text().catch(() => "");
    throw new Error(
      `gateway token exchange failed: ${exchangeRes.status} ${body.slice(0, 200)}`,
    );
  }
  const exchange = (await exchangeRes.json()) as GatewayExchangeResponse;

  return {
    tokens: {
      accessToken: exchange.accessToken,
      refreshToken: exchange.refreshToken,
      expiresAt: Date.now() + exchange.expiresIn * 1000,
      extra: exchange.extra,
    },
    account: exchange.account,
  };
}

/** Refresh a near-expired access token via the gateway's refresh
 *  proxy. Returns the new bundle; caller persists. */
export async function runRefreshFlow(opts: {
  provider: CrmProvider;
  refreshToken: string;
  bearer: string;
  gatewayUrl: string;
  orgUrl?: string;
}): Promise<CrmTokens> {
  const res = await fetch(
    `${opts.gatewayUrl.replace(/\/+$/, "")}/v1/crm/${encodeURIComponent(opts.provider)}/refresh`,
    {
      method: "POST",
      headers: {
        authorization: `Bearer ${opts.bearer}`,
        "content-type": "application/json",
      },
      body: JSON.stringify({
        refreshToken: opts.refreshToken,
        ...(opts.orgUrl ? { orgUrl: opts.orgUrl } : {}),
      }),
    },
  );
  if (!res.ok) {
    const body = await res.text().catch(() => "");
    throw new Error(
      `gateway crm refresh failed: ${res.status} ${body.slice(0, 200)}`,
    );
  }
  const payload = (await res.json()) as GatewayExchangeResponse;
  return {
    accessToken: payload.accessToken,
    refreshToken: payload.refreshToken ?? opts.refreshToken,
    expiresAt: Date.now() + payload.expiresIn * 1000,
    extra: payload.extra,
  };
}

// =============================================================================
// Loopback callback server — copy of the working pattern in main/auth.ts
// (adapted for CRM use; the auth.ts version is JWT-bound to Keycloak so we
// can't share it directly without leaking auth-specific semantics).
// =============================================================================

const CALLBACK_HTML = `<!doctype html><meta charset="utf-8">
<title>AVA · CRM verbunden</title>
<style>
  body{font:16px/1.5 -apple-system,system-ui,sans-serif;margin:0;min-height:100vh;display:flex;align-items:center;justify-content:center;background:#0b0d12;color:#e5e7eb}
  .card{text-align:center;padding:2.5rem 3rem;border:1px solid #1f2937;border-radius:12px;background:#111827}
  h1{margin:0 0 .5rem;font-size:1.5rem;color:#f3f4f6}
  p{margin:0;color:#9ca3af}
  .check{display:inline-flex;width:48px;height:48px;border-radius:50%;background:#00c0a7;color:#04221b;align-items:center;justify-content:center;font-size:24px;margin-bottom:1rem;font-weight:700}
</style>
<div class="card">
  <div class="check">&#10003;</div>
  <h1>CRM-Verbindung abgeschlossen</h1>
  <p>Sie können dieses Fenster schließen und zur AVA-App zurückkehren.</p>
</div>
<script>setTimeout(()=>window.close(),800)</script>`;

function focusAppAfterCallback(): void {
  try {
    app.focus({ steal: true });
    const wins = BrowserWindow.getAllWindows();
    if (wins.length > 0) {
      const w = wins[0]!;
      if (w.isMinimized()) w.restore();
      w.show();
      w.focus();
    }
  } catch {
    // Focus is cosmetic.
  }
}

function runLoopbackFlow(
  expectedState: string,
  onListening: (port: number) => Promise<void>,
): Promise<{ code: string; redirectUri: string }> {
  return new Promise((resolve, reject) => {
    let timer: NodeJS.Timeout | null = null;
    const server: Server = createServer((req, res) => {
      const url = new URL(req.url ?? "/", `http://${req.headers.host}`);
      if (url.pathname !== "/callback") {
        res.writeHead(404).end("not found");
        return;
      }
      const code = url.searchParams.get("code");
      const state = url.searchParams.get("state");
      const error = url.searchParams.get("error");
      res
        .writeHead(200, { "content-type": "text/html; charset=utf-8" })
        .end(CALLBACK_HTML);
      setImmediate(() => server.close());
      if (timer) clearTimeout(timer);
      if (error) return reject(new Error(`provider error: ${error}`));
      if (!code) return reject(new Error("missing authorization code"));
      if (state !== expectedState)
        return reject(new Error("state mismatch (CSRF guard)"));
      focusAppAfterCallback();
      const port = (server.address() as AddressInfo).port;
      resolve({
        code,
        redirectUri: `http://${LOOPBACK_HOST}:${port}/callback`,
      });
    });
    server.on("listening", () => {
      const port = (server.address() as AddressInfo).port;
      onListening(port).catch((err) => {
        if (timer) clearTimeout(timer);
        server.close();
        reject(err);
      });
    });
    server.on("error", (err: NodeJS.ErrnoException) => {
      if (timer) clearTimeout(timer);
      if (err.code === "EADDRINUSE") {
        // Most likely cause: a previous OAuth flow still listening
        // (the timeout below should have closed it, but rapid retries
        // can race). German message so the Settings card can render
        // it directly without re-translation.
        reject(
          new Error(
            `OAuth-Port ${LOOPBACK_PORT} ist belegt. Bitte schließe andere AVA-Verbindungsversuche und versuche es erneut.`,
          ),
        );
        return;
      }
      reject(err);
    });
    // v0.1.55 — fixed loopback port (51080). HubSpot's redirect-URI
    // allowlist requires exact match (no wildcards / "any port"), so
    // we standardize on one port across all three providers. Bound on
    // 127.0.0.1 — `localhost` resolves there anyway and the redirect
    // URI uses the `localhost` hostname for HubSpot's allowlist.
    server.listen(LOOPBACK_PORT, "127.0.0.1");

    timer = setTimeout(() => {
      server.close();
      reject(new Error("CRM-Verbindung abgebrochen (Timeout)"));
    }, FLOW_TIMEOUT_MS);
  });
}

function base64url(buf: Buffer): string {
  return buf
    .toString("base64")
    .replace(/\+/g, "-")
    .replace(/\//g, "_")
    .replace(/=+$/, "");
}

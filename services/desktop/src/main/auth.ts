import { app, BrowserWindow, safeStorage, shell } from "electron";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { createHash, randomBytes } from "node:crypto";
import { promises as fs } from "node:fs";
import { join } from "node:path";
import { EventEmitter } from "node:events";
import type { AuthStatus } from "../shared/types";
export type { AuthStatus } from "../shared/types";

// =============================================================================
// OIDC Authorization Code + PKCE flow for the desktop app.
//
// Why this shape (vs an in-app BrowserWindow login):
//   RFC 8252 (OAuth 2.0 for Native Apps) recommends the *system browser* +
//   loopback redirect over an embedded webview. Reasons:
//     - The user's existing session cookie / password manager is reused.
//     - Phishing protection: the user sees the real Keycloak URL bar.
//     - Keycloak / Auth0 / Okta increasingly block embedded webviews.
//
// Flow:
//   1. Boot a one-shot HTTP server on 127.0.0.1:<random>.
//   2. The moment it's listening, open the user's default browser to
//      Keycloak's authorize URL with redirect_uri pointing at the loopback.
//   3. Keycloak redirects the browser to /callback?code=…&state=….
//   4. Loopback captures the code, returns a "you can close this tab"
//      page, and shuts down.
//   5. Exchange the code at the token endpoint with the PKCE verifier.
//   6. Access token kept in memory; refresh token persisted to the OS
//      keychain via electron's safeStorage so the next launch is silent.
//
// Keycloak client config (one-time, on the auth server side):
//   - Public client (no secret).
//   - Standard flow enabled.
//   - Valid redirect URIs include `http://127.0.0.1:*` (RFC 8252 native
//     app pattern).
//   - PKCE required (S256).
// =============================================================================

interface DiscoveryDoc {
  authorization_endpoint: string;
  token_endpoint: string;
  end_session_endpoint?: string;
}


const SIGNED_OUT: AuthStatus = {
  signedIn: false,
  accessToken: null,
  expiresAt: null,
  actorId: null,
  tenantId: null,
  scopes: [],
};

interface TokenResponse {
  access_token: string;
  expires_in: number;
  refresh_token?: string;
  token_type: string;
  id_token?: string;
}

/** Discriminator codes for `registerAccount()` failures. Match the
 *  gateway's `error` field on POST /v1/auth/register response. */
export type RegistrationErrorCode =
  | "email_taken"
  | "weak_password"
  | "invalid_input"
  | "rate_limited"
  | "registration_disabled"
  | "keycloak_error"
  | "network_error"
  | "server_error";

export class RegistrationError extends Error {
  constructor(
    public readonly code: RegistrationErrorCode,
    message: string,
    public readonly cause?: Error,
  ) {
    super(message);
    this.name = "RegistrationError";
  }
}

// Refresh ahead of expiry by this much so requests in flight don't trip a
// stale token. 60 s comfortably covers the slowest gateway round-trip
// (file uploads at §5.1) without burning refresh calls.
const REFRESH_LEAD_MS = 60_000;

// Default app scopes the gateway recognises (see middleware/auth.ts).
//
// `valueserp:enabled` is the per-tenant gate for the operator-paid
// search proxy (`/v1/proxy/valueserp`). The desktop requests it
// optimistically — Keycloak is configured to grant it to every user
// in the `ava` realm by default, but the operator can flip it off
// per-user/per-role from the admin UI to cut a tenant's access to
// the upstream API without a code change. If Keycloak doesn't grant
// the scope, the website producer's valueserp calls fall back to
// 403 and the producer surfaces a clear "feature disabled" error.
const APP_SCOPES = [
  "openid",
  "profile",
  "email",
  "company:read",
  "company:write",
  "transaction:read",
  "evaluation:read",
  "evaluation:write",
  "import:write",
  "valueserp:enabled",
];

export class Auth extends EventEmitter {
  private status: AuthStatus = SIGNED_OUT;
  private discovery: DiscoveryDoc | null = null;
  private refreshTimer: NodeJS.Timeout | null = null;
  private inFlight: Promise<void> | null = null;
  // v0.1.151 — id_token kept in-process for RP-Initiated Logout
  // (OIDC 1.0 §5). Passed back to Keycloak's end_session_endpoint as
  // `id_token_hint` so it (a) skips the "are you sure?" confirmation
  // page and (b) actually terminates the realm SSO session — the only
  // way to make the next sign-in show the account selector instead of
  // silently re-using the cached identity. Not exposed on AuthStatus
  // because no renderer code legitimately needs it.
  private idToken: string | null = null;

  constructor(
    private readonly issuer: string,
    private readonly clientId: string,
    private readonly gatewayUrl: string,
    private readonly scopes: string[] = APP_SCOPES,
  ) {
    super();
  }

  getStatus(): AuthStatus {
    return this.status;
  }

  /** Boot-time silent sign-in. true ↦ refresh token found and accepted. */
  async tryRestoreSession(): Promise<boolean> {
    try {
      const refreshToken = await this.loadRefreshToken();
      if (!refreshToken) return false;
      await this.ensureDiscovery();
      await this.exchangeRefreshToken(refreshToken);
      return this.status.signedIn;
    } catch (err) {
      console.warn("auth: silent restore failed:", (err as Error).message);
      // Persisted token is unusable — wipe it so we don't loop on it.
      await this.clearRefreshToken();
      return false;
    }
  }

  async signIn(): Promise<void> {
    if (this.inFlight) return this.inFlight;
    this.inFlight = this.runInteractiveFlow().finally(() => {
      this.inFlight = null;
    });
    return this.inFlight;
  }

  /**
   * In-App-Registration entry point.
   *
   * Talks to the gateway's `POST /v1/auth/register` endpoint, which
   * (a) creates the user via the Keycloak Admin API and (b) ROPC-
   * exchanges the just-set password for a token-set. Both steps run
   * server-side; the desktop never speaks to the Keycloak Admin API
   * directly.
   *
   * On success, the tokens go through the SAME `applyTokens()` path
   * as a normal OIDC sign-in, so persistence + scheduled-refresh +
   * status-event are all reused for free. The user is signed in the
   * moment this resolves.
   *
   * Errors come back as a typed code (`email_taken`, `weak_password`,
   * etc.) so the renderer can highlight the offending form field.
   * Non-2xx responses we don't recognise become `RegistrationError`
   * with a code of `server_error` — the form renders a generic
   * banner in that case.
   */
  async registerAccount(input: {
    firstName: string;
    lastName: string;
    email: string;
    password: string;
    acceptTerms: true;
  }): Promise<void> {
    const url = `${this.gatewayUrl.replace(/\/+$/, "")}/v1/auth/register`;
    let res: Response;
    try {
      res = await fetchWithRetry(
        url,
        {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify(input),
        },
        // Registration is a single, user-blocking action; retries on
        // a 4xx would be pointless (the server already rejected). We
        // only auto-retry on transport errors (timeout / disconnect).
        { retries: 2, timeoutMs: 15_000 },
      );
    } catch (err) {
      throw new RegistrationError(
        "network_error",
        "Verbindung zum Server fehlgeschlagen. Bitte Netzwerk prüfen und erneut versuchen.",
        err instanceof Error ? err : undefined,
      );
    }
    if (res.status === 201) {
      const data = (await res.json()) as {
        accessToken: string;
        refreshToken: string;
        idToken?: string;
        expiresIn: number;
        refreshExpiresIn?: number;
        tokenType: string;
      };
      // Adapt the gateway's camelCase shape to the OIDC-style snake_case
      // applyTokens() expects (it was originally fed the Keycloak token
      // endpoint response directly).
      await this.applyTokens({
        access_token: data.accessToken,
        refresh_token: data.refreshToken,
        id_token: data.idToken,
        expires_in: data.expiresIn,
        token_type: data.tokenType,
      });
      return;
    }
    // Non-2xx — surface the gateway's structured error so the form
    // can field-target the message.
    let parsed: { error?: string; message?: string } | null = null;
    try {
      parsed = (await res.json()) as { error?: string; message?: string };
    } catch {
      /* body may be empty or non-JSON */
    }
    const code = (parsed?.error ?? "server_error") as RegistrationErrorCode;
    const message =
      parsed?.message ??
      "Konto konnte nicht angelegt werden. Bitte später erneut versuchen.";
    throw new RegistrationError(code, message);
  }

  async signOut(): Promise<void> {
    if (this.refreshTimer) clearTimeout(this.refreshTimer);
    this.refreshTimer = null;

    // v0.1.151 — capture before wipe. The id_token is the only thing
    // Keycloak accepts as proof-of-prior-session on the logout endpoint
    // (the access token isn't sufficient — it represents authorization,
    // not authentication). Without `id_token_hint` Keycloak prompts the
    // user "are you sure you want to log out?" on logout, which breaks
    // the unattended-logout UX.
    const idTokenHint = this.idToken;
    // Discovery may or may not be cached at this point — load it before
    // we tear down state so the end_session_endpoint URL is available.
    let endSessionEndpoint: string | undefined;
    try {
      const disc = await this.ensureDiscovery();
      endSessionEndpoint = disc.end_session_endpoint;
    } catch (err) {
      // Discovery failure here is non-fatal — we still wipe local state
      // below. The remote session will time out on its own.
      console.warn(
        "auth: end_session discovery failed:",
        (err as Error).message,
      );
    }

    await this.clearRefreshToken();
    this.idToken = null;
    this.setStatus(SIGNED_OUT);

    // v0.1.151 — RP-Initiated Logout (OIDC 1.0 §5). Without this the
    // realm SSO cookie in the system browser survives sign-out, and
    // the NEXT sign-in silently re-uses the same identity (Keycloak
    // sees the cookie, skips the login screen, hands back a new code
    // for the SAME `sub`). That blocks account-switching, which is
    // exactly what the user reported.
    //
    // We deliberately do NOT pass `post_logout_redirect_uri`: that
    // would require an extra entry in the Keycloak client config
    // (`Valid post logout redirect URIs`), and we don't have anywhere
    // useful to redirect to from a native app anyway. Without it
    // Keycloak shows its built-in "You are logged out" page in the
    // browser, which is the right final state — the next time the
    // user clicks sign-in, the app pops a fresh browser tab and
    // Keycloak shows the login form because the SSO cookie is gone.
    if (endSessionEndpoint) {
      // v0.1.253 — Wenn der id_token aus dem Registration-Flow stammt
      // (ROPC gegen ava-registration), hat er azp=ava-registration.
      // Keycloak's RP-Initiated-Logout verlangt dass client_id zum
      // azp des id_token passt — sonst "Ungültiger Parameter:
      // id_token_hint". Wir decoden den id_token kurz, ziehen den
      // azp raus und benutzen DEN als client_id. Fallback auf
      // this.clientId, wenn kein id_token vorhanden (für ältere
      // Sessions bevor wir id_tokens gecacht haben).
      const azpFromIdToken = idTokenHint
        ? (decodeJwtPayload(idTokenHint)["azp"] as string | undefined)
        : undefined;
      const effectiveClientId = azpFromIdToken ?? this.clientId;
      const params = new URLSearchParams({
        client_id: effectiveClientId,
      });
      if (idTokenHint) params.set("id_token_hint", idTokenHint);
      const url = `${endSessionEndpoint}?${params.toString()}`;
      try {
        await shell.openExternal(url);
      } catch (err) {
        // openExternal failure is non-fatal: local state is already
        // wiped, so the worst case is a stale realm-side cookie that
        // the user can clear from the browser if they care.
        console.warn(
          "auth: openExternal(end_session) failed:",
          (err as Error).message,
        );
      }
    }
  }

  /** Returns a token guaranteed-valid for at least REFRESH_LEAD_MS. The
   *  preload bridge calls this on every gateway request so renderer code
   *  never sees a near-expired token. */
  async getAccessToken(): Promise<string | null> {
    if (!this.status.signedIn || !this.status.accessToken) return null;
    if (this.status.expiresAt && this.status.expiresAt - Date.now() < REFRESH_LEAD_MS) {
      const refreshToken = await this.loadRefreshToken();
      if (refreshToken) {
        try {
          await this.exchangeRefreshToken(refreshToken);
        } catch (err) {
          console.warn("auth: on-demand refresh failed:", (err as Error).message);
          this.setStatus(SIGNED_OUT);
          return null;
        }
      }
    }
    return this.status.accessToken;
  }

  /**
   * v0.1.338 — unconditionally exchange the refresh token for a fresh
   * access token, ignoring the REFRESH_LEAD_MS window.
   *
   * Why this exists separately from `getAccessToken()`: the reactive
   * gateway-401 recovery path (producer's captured
   * `PRODUCER_GATEWAY_TOKEN` was rejected by the gateway) can't rely on
   * the lead-time gate. The token may have been rejected for a reason
   * that doesn't show up in our local `expiresAt` — server-side
   * revocation, clock skew, or simply that the producer captured an
   * older token than the one main currently holds. In all of those a
   * lead-time-gated `getAccessToken()` would early-return the SAME
   * stale/rejected token and the producer cycle would loop on 401.
   *
   * Returns the fresh access token, or null when we can't refresh
   * (signed out / no refresh token on disk / exchange failed). On a
   * hard failure it leaves the existing session intact rather than
   * forcing a sign-out — the caller decides how to surface it.
   */
  async forceRefresh(): Promise<string | null> {
    if (!this.status.signedIn) return null;
    const refreshToken = await this.loadRefreshToken();
    if (!refreshToken) return this.status.accessToken ?? null;
    try {
      await this.exchangeRefreshToken(refreshToken);
    } catch (err) {
      console.warn("auth: forced refresh failed:", (err as Error).message);
      return null;
    }
    return this.status.accessToken;
  }

  // ---------------------------------------------------------------------------
  // Internals
  // ---------------------------------------------------------------------------

  private async runInteractiveFlow(): Promise<void> {
    const disc = await this.ensureDiscovery();

    const verifier = base64url(randomBytes(32));
    const challenge = base64url(createHash("sha256").update(verifier).digest());
    const state = base64url(randomBytes(16));

    const { code, redirectUri } = await runLoopbackFlow(state, (port) => {
      const params = new URLSearchParams({
        client_id: this.clientId,
        response_type: "code",
        redirect_uri: `http://127.0.0.1:${port}/callback`,
        scope: this.scopes.join(" "),
        code_challenge: challenge,
        code_challenge_method: "S256",
        state,
      });
      void shell.openExternal(`${disc.authorization_endpoint}?${params.toString()}`);
    });

    await this.exchangeAuthorizationCode(code, verifier, redirectUri);
  }

  private async ensureDiscovery(): Promise<DiscoveryDoc> {
    if (this.discovery) return this.discovery;
    const url = `${this.issuer.replace(/\/$/, "")}/.well-known/openid-configuration`;
    // v0.1.204 — harden the first network call. The bare `fetch(url)`
    // failed silently on a tester's older Intel Mac with "TypeError:
    // fetch failed", which is undici's generic surface and hides the
    // real cause (DNS / TLS / connection-refused / IPv6-only network /
    // proxy / cold-start). The renderer then displayed only the
    // wrapped IPC error and we couldn't tell what was wrong.
    //
    //   - 10s timeout per attempt (prev: no timeout → hung forever
    //     when the network silently dropped packets).
    //   - Three attempts with backoff (250ms, 1s) to absorb a Fly
    //     cold-start or a single packet loss.
    //   - Surface the cause chain on final failure so the renderer
    //     shows a useful message (e.g. "DNS lookup failed" /
    //     "self-signed cert" / "operation timed out") instead of
    //     undici's opaque "fetch failed".
    const res = await fetchWithRetry(url, {}, { retries: 3, timeoutMs: 10_000 });
    if (!res.ok) throw new Error(`discovery failed: ${res.status} ${url}`);
    this.discovery = (await res.json()) as DiscoveryDoc;
    return this.discovery;
  }

  private async exchangeAuthorizationCode(
    code: string,
    verifier: string,
    redirectUri: string,
  ): Promise<void> {
    const disc = await this.ensureDiscovery();
    const body = new URLSearchParams({
      grant_type: "authorization_code",
      client_id: this.clientId,
      code,
      redirect_uri: redirectUri,
      code_verifier: verifier,
    });
    // v0.1.208 — same hardening as `ensureDiscovery` (v0.1.204). The
    // bare `fetch()` had no timeout; on a background-wake the macOS
    // networking stack can be sluggish for a few seconds (App Nap /
    // suspended sockets / IPv6 fallback). The browser-side OAuth flow
    // completed fine (separate process), the loopback callback fired
    // fine (in-process), but this POST hung forever → the renderer's
    // "Anmelden" button spun without ever resolving. Wrap with the
    // same retry+timeout helper that surfaces the cause chain.
    const res = await fetchWithRetry(
      disc.token_endpoint,
      {
        method: "POST",
        headers: { "content-type": "application/x-www-form-urlencoded" },
        body: body.toString(),
      },
      { retries: 3, timeoutMs: 10_000 },
    );
    if (!res.ok) {
      const text = await res.text().catch(() => "");
      throw new Error(`token exchange failed: ${res.status} ${text.slice(0, 200)}`);
    }
    const tokens = (await res.json()) as TokenResponse;
    await this.applyTokens(tokens);
  }

  private async exchangeRefreshToken(refreshToken: string): Promise<void> {
    const disc = await this.ensureDiscovery();
    const body = new URLSearchParams({
      grant_type: "refresh_token",
      client_id: this.clientId,
      refresh_token: refreshToken,
    });
    // v0.1.208 — see exchangeAuthorizationCode. Refresh-token exchange
    // runs on a timer AND on background-wake, both of which are the
    // exact moments where the bare fetch could hang.
    const res = await fetchWithRetry(
      disc.token_endpoint,
      {
        method: "POST",
        headers: { "content-type": "application/x-www-form-urlencoded" },
        body: body.toString(),
      },
      { retries: 3, timeoutMs: 10_000 },
    );
    if (!res.ok) {
      const text = await res.text().catch(() => "");
      throw new Error(`refresh failed: ${res.status} ${text.slice(0, 200)}`);
    }
    const tokens = (await res.json()) as TokenResponse;
    await this.applyTokens(tokens);
  }

  private async applyTokens(tokens: TokenResponse): Promise<void> {
    const expiresAt = Date.now() + tokens.expires_in * 1000;
    // v0.1.151 — cache the id_token for the eventual RP-initiated
    // logout. Keycloak returns a new id_token on every refresh, so
    // overwriting here keeps the cached hint fresh; on the rare path
    // where a refresh response omits it (some IdPs only mint id_tokens
    // on the initial auth_code exchange), keep the previously-stored
    // value rather than wiping it.
    if (tokens.id_token) this.idToken = tokens.id_token;
    const claims = decodeJwtPayload(tokens.access_token);
    const tenantId = (claims["tenant_id"] as string | undefined) ?? null;
    const actorId = (claims["sub"] as string | undefined) ?? null;
    const scopes = parseScopes(claims["scope"]);

    this.setStatus({
      signedIn: true,
      accessToken: tokens.access_token,
      expiresAt,
      tenantId,
      actorId,
      scopes,
    });

    if (tokens.refresh_token) {
      await this.saveRefreshToken(tokens.refresh_token);
    }

    if (this.refreshTimer) clearTimeout(this.refreshTimer);
    const delay = Math.max(5_000, expiresAt - Date.now() - REFRESH_LEAD_MS);
    this.refreshTimer = setTimeout(() => {
      this.silentRefresh().catch((err) => {
        console.warn("auth: scheduled refresh failed:", (err as Error).message);
      });
    }, delay);
  }

  private async silentRefresh(): Promise<void> {
    const refreshToken = await this.loadRefreshToken();
    if (!refreshToken) {
      this.setStatus(SIGNED_OUT);
      return;
    }
    await this.exchangeRefreshToken(refreshToken);
  }

  private setStatus(next: AuthStatus): void {
    this.status = next;
    this.emit("status", next);
  }

  /**
   * DEV ONLY — fake a signed-in session for UI testing without Keycloak.
   * Triggered by main/index.ts when AVA_DEV_AUTH_BYPASS=1 is set.
   *
   * The "token" is a synthetic value that real backends will reject. Use only
   * with the mock gateway (scripts/mock-gateway.mjs), which doesn't verify
   * JWTs. Anyone running this against a real gateway will get 401s — by
   * design, so you can't accidentally pretend you're authenticated in prod.
   */
  devBypassSignIn(actorId = "dev-user", tenantId = "dev-tenant"): void {
    if (process.env.NODE_ENV === "production") {
      throw new Error("devBypassSignIn refuses to run with NODE_ENV=production");
    }
    this.setStatus({
      signedIn: true,
      accessToken: "dev-bypass-token",
      expiresAt: Date.now() + 60 * 60 * 1000, // 1h
      actorId,
      tenantId,
      scopes: this.scopes.filter((s) => s !== "openid" && s !== "profile" && s !== "email"),
    });
  }

  // ---- Refresh-token persistence (OS keychain via safeStorage) --------------

  private refreshTokenPath(): string {
    return join(app.getPath("userData"), "auth.bin");
  }

  private async saveRefreshToken(token: string): Promise<void> {
    if (!safeStorage.isEncryptionAvailable()) {
      // No keychain available (rare; some Linux setups). Skip persistence —
      // the user signs in again next launch. Better than writing plaintext.
      return;
    }
    const enc = safeStorage.encryptString(token);
    await fs.writeFile(this.refreshTokenPath(), enc, { mode: 0o600 });
  }

  private async loadRefreshToken(): Promise<string | null> {
    try {
      const buf = await fs.readFile(this.refreshTokenPath());
      if (!safeStorage.isEncryptionAvailable()) return null;
      return safeStorage.decryptString(buf);
    } catch {
      return null;
    }
  }

  private async clearRefreshToken(): Promise<void> {
    await fs.unlink(this.refreshTokenPath()).catch(() => undefined);
  }
}

// =============================================================================
// Loopback callback server (RFC 8252 §7.3).
//
// One-shot: starts on a random ephemeral 127.0.0.1 port, fires `onListening`
// the moment the port is known so the caller can open the browser, waits for
// `/callback?code=…&state=…`, returns a tiny "you can close this tab" page,
// then shuts itself down. Times out after 5 minutes if the user abandons
// the browser flow.
// =============================================================================

// AVA brand colors mirror the renderer theme so the bridge moment
// between browser and app doesn't feel disjointed. We deliberately
// do NOT auto-close the tab: Chrome / Safari refuse `window.close()`
// on tabs they didn't open (security policy), so the close was a
// no-op anyway, and the desktop-side `app.focus({ steal: true })`
// often fails to bring the Electron window forward (macOS Stage
// Manager / Spaces / unfocused-app activation policy). The
// auto-close together with a non-focused app left the user staring
// at the browser thinking the app should have appeared. Better UX:
// show "Anmeldung erfolgreich", tell them explicitly to switch back,
// and let them close the tab on their own time.
const CALLBACK_HTML = `<!doctype html><meta charset="utf-8">
<title>AVA · Anmeldung erfolgreich</title>
<style>
  body{font:16px/1.5 -apple-system,system-ui,sans-serif;margin:0;min-height:100vh;display:flex;align-items:center;justify-content:center;background:#0b0d12;color:#e5e7eb}
  .card{text-align:center;padding:2.5rem 3rem;border:1px solid #1f2937;border-radius:12px;background:#111827;max-width:420px}
  h1{margin:0 0 .5rem;font-size:1.5rem;color:#f3f4f6}
  p{margin:0;color:#9ca3af}
  .check{display:inline-flex;width:48px;height:48px;border-radius:50%;background:#00c0a7;color:#0b0d12;align-items:center;justify-content:center;font-size:24px;margin-bottom:1rem;font-weight:bold}
</style>
<div class="card">
  <div class="check">&#10003;</div>
  <h1>Anmeldung erfolgreich</h1>
  <p>Bitte zurück zur AVA-App wechseln. Dieses Fenster kannst du jetzt schließen.</p>
</div>`;

/** Bring the Electron main window to front + focus after a successful
 *  loopback callback. macOS, Windows and Linux all support
 *  `app.focus({ steal: true })` for cross-process focus stealing
 *  (intentional UX here — the user just completed login and is
 *  expecting to come back to the app). If no main window has been
 *  created yet (very unlikely on the auth path) we fall back to
 *  app-level focus only. */
function focusAppAfterAuth(): void {
  try {
    app.focus({ steal: true });
    const wins = BrowserWindow.getAllWindows();
    if (wins.length > 0) {
      const w = wins[0]!;
      if (w.isMinimized()) w.restore();
      w.show();
      w.focus();
    }
  } catch (err) {
    // Focus is purely cosmetic — never fail the auth flow over it.
    console.warn("auth: focusAppAfterAuth failed:", (err as Error).message);
  }
}

function runLoopbackFlow(
  expectedState: string,
  onListening: (port: number) => void,
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
      // Close after the response flushes — keeps the browser tab from
      // hanging on a half-closed connection.
      setImmediate(() => server.close());
      if (timer) clearTimeout(timer);
      if (error) return reject(new Error(`auth provider returned error: ${error}`));
      if (!code) return reject(new Error("missing authorization code"));
      if (state !== expectedState) return reject(new Error("state mismatch (CSRF guard)"));
      // Pull the app back to front the moment we have a valid code.
      // The browser tab closes itself on a short timer; meanwhile the
      // user sees their AVA window pop forward without a manual
      // alt-tab. This is the actual "redirect to the app" UX —
      // browsers can't focus a desktop app from JS, so we do it from
      // the OS side.
      focusAppAfterAuth();
      const port = (server.address() as AddressInfo).port;
      resolve({ code, redirectUri: `http://127.0.0.1:${port}/callback` });
    });
    server.on("listening", () => {
      onListening((server.address() as AddressInfo).port);
    });
    server.on("error", (err) => {
      if (timer) clearTimeout(timer);
      reject(err);
    });
    // Random ephemeral port — Keycloak client config must allow
    // http://127.0.0.1:* as a redirect URI for native apps.
    server.listen(0, "127.0.0.1");

    timer = setTimeout(
      () => {
        server.close();
        reject(new Error("login timed out (5 min)"));
      },
      5 * 60_000,
    );
  });
}

// =============================================================================
// Helpers
// =============================================================================

function base64url(buf: Buffer): string {
  return buf
    .toString("base64")
    .replace(/\+/g, "-")
    .replace(/\//g, "_")
    .replace(/=+$/, "");
}

function decodeJwtPayload(jwt: string): Record<string, unknown> {
  const parts = jwt.split(".");
  if (parts.length !== 3) return {};
  try {
    const json = Buffer.from(
      parts[1]!.replace(/-/g, "+").replace(/_/g, "/"),
      "base64",
    ).toString();
    return JSON.parse(json) as Record<string, unknown>;
  } catch {
    return {};
  }
}

function parseScopes(scope: unknown): string[] {
  if (typeof scope === "string") return scope.split(/\s+/).filter(Boolean);
  if (Array.isArray(scope)) return scope.filter((s): s is string => typeof s === "string");
  return [];
}

// v0.1.204 — diagnostic-friendly fetch wrapper for the OAuth flow.
//
// Three behaviours bundled in one helper:
//
//   1. Per-attempt AbortSignal.timeout so a silently-dropping
//      network doesn't hang the auth flow forever. The previous
//      `await fetch(url)` had no timeout; on a tester's older
//      Intel Mac it stalled until the user closed the window.
//
//   2. Retries with exponential-ish backoff (250 ms, 1 s). Covers
//      a Fly machine cold-start (~1-2 s wakeup), a single dropped
//      packet, or undici's stale-connection edge case.
//
//   3. Cause-chain stringification on final failure. undici wraps
//      the real reason (DNS lookup failure, TLS handshake reject,
//      ECONNREFUSED, …) in a `.cause` chain that doesn't surface
//      in `Error.message`. We walk the chain and concatenate the
//      messages so the renderer's error toast actually shows the
//      root cause — "DNS-Auflösung fehlgeschlagen" beats the
//      opaque "TypeError: fetch failed".
//
// Backoff defaults are tuned for an OAuth-discovery first call;
// callers that need different semantics can override.

interface RetryOpts {
  retries: number;
  timeoutMs: number;
}

async function fetchWithRetry(
  url: string,
  init: RequestInit = {},
  opts: RetryOpts,
): Promise<Response> {
  const delays = [250, 1000];
  let lastErr: unknown = null;
  for (let attempt = 0; attempt < opts.retries; attempt++) {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), opts.timeoutMs);
    try {
      const res = await fetch(url, { ...init, signal: controller.signal });
      clearTimeout(timeout);
      // Don't retry on a 4xx/5xx response — the caller handles
      // those. Retry only network-level errors (caught below).
      return res;
    } catch (err) {
      clearTimeout(timeout);
      lastErr = err;
      // Abort = timeout for our purposes; treat like a transient
      // network failure and retry.
      const isLastAttempt = attempt === opts.retries - 1;
      if (isLastAttempt) break;
      const delay = delays[attempt] ?? delays[delays.length - 1] ?? 1000;
      await new Promise((r) => setTimeout(r, delay));
    }
  }
  throw new Error(
    `fetch ${url} failed after ${opts.retries} attempt(s): ${stringifyErrorCauseChain(lastErr)}`,
  );
}

/**
 * Walk an Error's `.cause` chain and concatenate the messages.
 * Node's undici puts the real reason ("getaddrinfo ENOTFOUND ...",
 * "Hostname/IP does not match certificate's altnames", etc.) in
 * `err.cause`, but `String(err)` only shows the outermost wrapper.
 * This helper makes the user-facing error message diagnose-ably
 * specific.
 */
function stringifyErrorCauseChain(err: unknown): string {
  const parts: string[] = [];
  let cur: unknown = err;
  let depth = 0;
  while (cur && depth < 8) {
    if (cur instanceof Error) {
      parts.push(cur.name === "Error" ? cur.message : `${cur.name}: ${cur.message}`);
      cur = (cur as { cause?: unknown }).cause;
    } else if (typeof cur === "string") {
      parts.push(cur);
      cur = null;
    } else {
      parts.push(String(cur));
      cur = null;
    }
    depth += 1;
  }
  return parts.length > 0 ? parts.join(" ← caused by ") : "unknown";
}

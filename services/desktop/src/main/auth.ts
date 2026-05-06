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

  constructor(
    private readonly issuer: string,
    private readonly clientId: string,
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

  async signOut(): Promise<void> {
    if (this.refreshTimer) clearTimeout(this.refreshTimer);
    this.refreshTimer = null;
    await this.clearRefreshToken();
    this.setStatus(SIGNED_OUT);
    // We deliberately don't navigate to end_session_endpoint — Keycloak
    // sessions in the system browser are intentionally separate from app
    // state. The user can clear them from the browser if they care.
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
    const res = await fetch(url);
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
    const res = await fetch(disc.token_endpoint, {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: body.toString(),
    });
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
    const res = await fetch(disc.token_endpoint, {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: body.toString(),
    });
    if (!res.ok) {
      const text = await res.text().catch(() => "");
      throw new Error(`refresh failed: ${res.status} ${text.slice(0, 200)}`);
    }
    const tokens = (await res.json()) as TokenResponse;
    await this.applyTokens(tokens);
  }

  private async applyTokens(tokens: TokenResponse): Promise<void> {
    const expiresAt = Date.now() + tokens.expires_in * 1000;
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
// between browser and app doesn't feel disjointed. The page closes
// itself after a short pause — this is best-effort because Chrome /
// Safari often refuse `window.close()` on tabs they didn't open
// (security). We rely on the desktop-side `app.focus()` (below) for
// the actual "back to the app" experience; the tab closing is a
// nicety, not the redirect mechanism.
const CALLBACK_HTML = `<!doctype html><meta charset="utf-8">
<title>AVA — Anmeldung erfolgreich</title>
<style>
  body{font:16px/1.5 -apple-system,system-ui,sans-serif;margin:0;min-height:100vh;display:flex;align-items:center;justify-content:center;background:#0b0d12;color:#e5e7eb}
  .card{text-align:center;padding:2.5rem 3rem;border:1px solid #1f2937;border-radius:12px;background:#111827}
  h1{margin:0 0 .5rem;font-size:1.5rem;color:#f3f4f6}
  p{margin:0;color:#9ca3af}
  .check{display:inline-flex;width:48px;height:48px;border-radius:50%;background:#10b981;color:#fff;align-items:center;justify-content:center;font-size:24px;margin-bottom:1rem}
</style>
<div class="card">
  <div class="check">&#10003;</div>
  <h1>Anmeldung erfolgreich</h1>
  <p>Sie können dieses Fenster schließen und zur AVA-App zurückkehren.</p>
</div>
<script>setTimeout(()=>window.close(),800)</script>`;

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

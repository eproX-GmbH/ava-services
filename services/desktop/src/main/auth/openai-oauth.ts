// v0.1.353 — OpenAI „Sign in with ChatGPT"-OAuth (PKCE).
//
// Pendant zu `anthropic-oauth.ts`. Spiegelt den Flow, den OpenAIs
// Codex-CLI nutzt: derselbe öffentliche `client_id`, derselbe
// Authorize-/Token-Endpunkt, dieselbe Redirect-URL
// (`http://localhost:1455/auth/callback`). Statt einen lokalen
// HTTP-Server zu starten (wie das CLI) öffnet AVA ein internes
// Electron-`BrowserWindow` und fängt die Redirect-Navigation auf
// `localhost:1455` ab, bevor sie wirklich an einen (nicht
// existierenden) lokalen Server geht — exakt das Muster aus
// `anthropic-oauth-flow.ts`.
//
// Wichtig (Abo-Pfad): Das so erzeugte Access-Token läuft NICHT gegen
// `api.openai.com/v1`, sondern gegen den Codex-Backend-Endpunkt
// `https://chatgpt.com/backend-api/codex/responses` (Responses-API).
// Dort wird zusätzlich der Header `chatgpt-account-id` verlangt — die
// Account-ID steckt als JWT-Claim im id_token/access_token (siehe
// `decodeChatgptAccountId`).
//
// Caveats (dem Nutzer kommuniziert): Der Backend-Endpunkt ist
// undokumentiert und kann sich ohne Vorwarnung ändern; Rate-Limits sind
// abo-gebunden (5h-Fenster); laut OpenAI nur für persönliche Nutzung.

import { createHash, randomBytes } from "node:crypto";

/** Öffentlicher PKCE-Client des Codex-CLI. OpenAI akzeptiert ihn ohne
 *  Client-Secret — derselbe Wert, den Codex, opencode & Zed benutzen. */
export const OPENAI_OAUTH_CLIENT_ID = "app_EMoamEEZ73f0CkXaXp7hrann";

/** Authorize-Endpunkt (Login-Frontend auf auth.openai.com). */
export const OPENAI_OAUTH_AUTHORIZE_URL =
  "https://auth.openai.com/oauth/authorize";

/** Token-Endpunkt — derselbe, den auch das Codex-CLI ansteuert. */
export const OPENAI_OAUTH_TOKEN_URL = "https://auth.openai.com/oauth/token";

/** Redirect-URL für den Authorization-Code-Flow. Das Codex-CLI lauscht
 *  hier auf einem lokalen Server; wir fangen die Navigation per
 *  `webContents.on('will-redirect'|'will-navigate')` ab, bevor sie den
 *  (nicht existierenden) lokalen Server erreicht. */
export const OPENAI_OAUTH_REDIRECT_URI = "http://localhost:1455/auth/callback";

/** Scopes für den Codex-Subscription-Login. `offline_access` ist nötig,
 *  damit wir einen refresh_token bekommen. */
export const OPENAI_OAUTH_SCOPE = "openid profile email offline_access";

export interface PkceParams {
  verifier: string;
  challenge: string;
  state: string;
}

export interface OpenAITokenResult {
  accessToken: string;
  refreshToken?: string;
  expiresIn?: number;
  scope?: string;
  tokenType?: string;
  /** ChatGPT-Account-ID, aus dem id_token/access_token-JWT extrahiert.
   *  Wird als `chatgpt-account-id`-Header an den Codex-Endpunkt gesendet. */
  accountId?: string;
}

function base64url(buf: Buffer): string {
  return buf
    .toString("base64")
    .replace(/=+$/, "")
    .replace(/\+/g, "-")
    .replace(/\//g, "_");
}

/** Erzeugt PKCE-Verifier, -Challenge und CSRF-State frisch. */
export function generatePkce(): PkceParams {
  const verifier = base64url(randomBytes(32));
  const challenge = base64url(createHash("sha256").update(verifier).digest());
  const state = base64url(randomBytes(32));
  return { verifier, challenge, state };
}

/**
 * Vollständige Authorize-URL. Die Codex-spezifischen Parameter
 * (`id_token_add_organizations`, `codex_cli_simplified_flow`,
 * `originator`) sind nötig, damit OpenAIs Consent-Seite den
 * vereinfachten CLI-Flow zeigt und die Account-/Org-Claims ins Token
 * legt.
 */
export function buildAuthorizationUrl(pkce: PkceParams): string {
  const params = new URLSearchParams({
    response_type: "code",
    client_id: OPENAI_OAUTH_CLIENT_ID,
    redirect_uri: OPENAI_OAUTH_REDIRECT_URI,
    scope: OPENAI_OAUTH_SCOPE,
    code_challenge: pkce.challenge,
    code_challenge_method: "S256",
    state: pkce.state,
    id_token_add_organizations: "true",
    codex_cli_simplified_flow: "true",
    originator: "codex_cli_rs",
  });
  return `${OPENAI_OAUTH_AUTHORIZE_URL}?${params.toString()}`;
}

/**
 * Dekodiert die `chatgpt_account_id` aus einem OpenAI-JWT
 * (id_token oder access_token). Der Claim liegt verschachtelt unter
 * `["https://api.openai.com/auth"].chatgpt_account_id`; als Fallback
 * prüfen wir auch Top-Level-Felder. Gibt null zurück, wenn nichts
 * gefunden wird (der Aufrufer kann dann ohne Account-ID weitermachen —
 * manche Endpoints akzeptieren das, andere nicht).
 */
export function decodeChatgptAccountId(jwt: string | undefined): string | null {
  if (!jwt) return null;
  const parts = jwt.split(".");
  const segment = parts[1];
  if (!segment) return null;
  try {
    const payloadJson = Buffer.from(
      segment.replace(/-/g, "+").replace(/_/g, "/"),
      "base64",
    ).toString("utf8");
    const payload = JSON.parse(payloadJson) as Record<string, unknown>;
    const authClaim = payload["https://api.openai.com/auth"] as
      | Record<string, unknown>
      | undefined;
    const fromClaim = authClaim?.["chatgpt_account_id"];
    if (typeof fromClaim === "string" && fromClaim.length > 0) return fromClaim;
    const topLevel = payload["chatgpt_account_id"];
    if (typeof topLevel === "string" && topLevel.length > 0) return topLevel;
    return null;
  } catch {
    return null;
  }
}

/**
 * Tauscht einen Authorization-Code gegen Access-/Refresh-Token (+ id_token).
 * OpenAIs Token-Endpoint erwartet `application/x-www-form-urlencoded`.
 */
export async function exchangeCodeForToken(args: {
  code: string;
  verifier: string;
}): Promise<OpenAITokenResult> {
  const body = new URLSearchParams({
    grant_type: "authorization_code",
    code: args.code,
    redirect_uri: OPENAI_OAUTH_REDIRECT_URI,
    client_id: OPENAI_OAUTH_CLIENT_ID,
    code_verifier: args.verifier,
  });
  const resp = await fetch(OPENAI_OAUTH_TOKEN_URL, {
    method: "POST",
    headers: {
      "Content-Type": "application/x-www-form-urlencoded",
      Accept: "application/json",
    },
    body: body.toString(),
  });
  return parseTokenResponse(resp, "Token");
}

/**
 * Tauscht einen Refresh-Token gegen ein frisches Access-Token (+ ggf.
 * rotierten Refresh-Token). Für den Hintergrund-Refresher.
 */
export async function refreshAccessToken(args: {
  refreshToken: string;
}): Promise<OpenAITokenResult> {
  const body = new URLSearchParams({
    grant_type: "refresh_token",
    refresh_token: args.refreshToken,
    client_id: OPENAI_OAUTH_CLIENT_ID,
    scope: OPENAI_OAUTH_SCOPE,
  });
  const resp = await fetch(OPENAI_OAUTH_TOKEN_URL, {
    method: "POST",
    headers: {
      "Content-Type": "application/x-www-form-urlencoded",
      Accept: "application/json",
    },
    body: body.toString(),
  });
  return parseTokenResponse(resp, "Refresh");
}

async function parseTokenResponse(
  resp: Response,
  label: string,
): Promise<OpenAITokenResult> {
  if (!resp.ok) {
    let detail = "";
    try {
      detail = await resp.text();
    } catch {
      detail = "<kein Antwort-Body>";
    }
    const err = new Error(
      `OpenAI-${label}-Endpoint antwortete mit HTTP ${resp.status}: ${detail}`,
    );
    (err as Error & { status?: number }).status = resp.status;
    throw err;
  }
  const json = (await resp.json()) as {
    access_token?: unknown;
    refresh_token?: unknown;
    id_token?: unknown;
    expires_in?: unknown;
    scope?: unknown;
    token_type?: unknown;
  };
  if (typeof json.access_token !== "string" || json.access_token.length < 10) {
    throw new Error(`OpenAI-${label}-Antwort enthielt kein gültiges access_token.`);
  }
  const out: OpenAITokenResult = { accessToken: json.access_token };
  if (typeof json.refresh_token === "string") out.refreshToken = json.refresh_token;
  if (typeof json.expires_in === "number") out.expiresIn = json.expires_in;
  if (typeof json.scope === "string") out.scope = json.scope;
  if (typeof json.token_type === "string") out.tokenType = json.token_type;
  // Account-ID bevorzugt aus dem id_token (enthält die Org-/Account-
  // Claims durch `id_token_add_organizations=true`), sonst aus dem
  // access_token.
  const accountId =
    decodeChatgptAccountId(
      typeof json.id_token === "string" ? json.id_token : undefined,
    ) ?? decodeChatgptAccountId(json.access_token);
  if (accountId) out.accountId = accountId;
  return out;
}

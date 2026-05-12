// Phase A6 — Anthropic OAuth-Subscription-Login (PKCE).
//
// Spiegelt das Verhalten von Anthropics offiziellem `claude setup-token`-
// CLI: derselbe öffentliche `client_id`, derselbe Authorize-/Token-
// Endpunkt, dieselbe Redirect-URL. Statt einer Terminal-Aufforderung
// öffnet AVA aber ein internes Electron-`BrowserWindow` und fängt die
// Redirect-URL serverseitig ab — der Nutzer sieht die Code-Anzeige-
// Seite nie und muss nichts per Hand kopieren.
//
// Sicherheit:
//   - PKCE (S256). Verifier wird nur in der Renderer-losen Main-Process-
//     Speicherung gehalten, fließt nicht in die Token-Antwort und wird
//     nach dem Tausch verworfen.
//   - State-Round-Trip wird im aufrufenden Flow (anthropic-oauth-flow.ts)
//     gegen den Redirect-Parameter geprüft.
//   - Token-Antwort wird ausschließlich an `console.anthropic.com`
//     gesendet — derselbe Endpunkt, den auch Claude Code nutzt.

import { createHash, randomBytes } from "node:crypto";

/** Öffentlicher PKCE-Client von Claude Code. Anthropic akzeptiert ihn
 *  ohne Client-Secret für OAuth-Token-Erzeugung — derselbe Wert, den
 *  `claude setup-token`, OpenClaw und OpenCode benutzen. */
export const ANTHROPIC_OAUTH_CLIENT_ID =
  "9d1c250a-e61b-44d9-88ed-5944d1962f5e";

/** Anthropic-Authorize-Endpunkt (Login-Frontend auf claude.ai). */
export const ANTHROPIC_OAUTH_AUTHORIZE_URL =
  "https://claude.ai/oauth/authorize";

/** Token-Endpunkt — derselbe, den auch das Claude-Code-CLI ansteuert. */
export const ANTHROPIC_OAUTH_TOKEN_URL =
  "https://console.anthropic.com/v1/oauth/token";

/** Redirect-URL für den Authorization-Code-Flow. Die Seite zeigt im
 *  normalen Browser den Code zum Copy-Paste; wir fangen die Navigation
 *  über `webContents.on('will-redirect'|'will-navigate')` ab, bevor
 *  die Seite überhaupt lädt. */
export const ANTHROPIC_OAUTH_REDIRECT_URI =
  "https://console.anthropic.com/oauth/code/callback";

/** Scope für reine Inference-Aufrufe — gleich wie `claude setup-token`. */
export const ANTHROPIC_OAUTH_SCOPE = "user:inference";

export interface PkceParams {
  /** 32-Byte base64url-codierter Code-Verifier. */
  verifier: string;
  /** base64url(sha256(verifier)), ohne Padding. */
  challenge: string;
  /** 32-Byte base64url-codierter State. Wird beim Redirect verifiziert. */
  state: string;
}

export interface TokenResult {
  accessToken: string;
  refreshToken?: string;
  expiresIn?: number;
  scope?: string;
  tokenType?: string;
}

/**
 * Base64url-Codierung wie in RFC 7636 §4.1 vorgeschrieben:
 * Padding entfernt, `+` → `-`, `/` → `_`.
 */
function base64url(buf: Buffer): string {
  return buf
    .toString("base64")
    .replace(/=+$/, "")
    .replace(/\+/g, "-")
    .replace(/\//g, "_");
}

/** Erzeugt PKCE-Verifier, -Challenge und CSRF-State frisch. */
export function generatePkce(): PkceParams {
  const verifierBytes = randomBytes(32);
  const verifier = base64url(verifierBytes);
  const challengeBytes = createHash("sha256").update(verifier).digest();
  const challenge = base64url(challengeBytes);
  const state = base64url(randomBytes(32));
  return { verifier, challenge, state };
}

/**
 * Vollständige Authorize-URL. `code=true` ist Anthropic-spezifisch:
 * ohne den Parameter führt der Flow nicht zur Code-Anzeige-Seite,
 * sondern direkt zurück zur Claude-Code-App-Integration.
 */
export function buildAuthorizationUrl(pkce: PkceParams): string {
  const params = new URLSearchParams({
    client_id: ANTHROPIC_OAUTH_CLIENT_ID,
    response_type: "code",
    redirect_uri: ANTHROPIC_OAUTH_REDIRECT_URI,
    scope: ANTHROPIC_OAUTH_SCOPE,
    state: pkce.state,
    code_challenge: pkce.challenge,
    code_challenge_method: "S256",
    code: "true",
  });
  return `${ANTHROPIC_OAUTH_AUTHORIZE_URL}?${params.toString()}`;
}

/**
 * Tauscht einen Authorization-Code gegen ein Bearer-Access-Token.
 *
 * Bei Nicht-2xx-Antworten wird der Response-Body in die Fehlermeldung
 * gehoben — die UI zeigt dem Nutzer dann den Anthropic-Originaltext
 * (oft hilfreich, z. B. bei abgelaufenem Code).
 */
export async function exchangeCodeForToken(args: {
  code: string;
  verifier: string;
  state: string;
}): Promise<TokenResult> {
  // Anthropic's token endpoint expects a JSON body — confirmed against
  // multiple working third-party PKCE implementations (changjonathanc
  // gist, ben-vargas gist, opencode-anthropic-auth, anomalyco). An
  // earlier v0.1.136 draft switched to application/x-www-form-urlencoded
  // assuming OAuth 2.0 spec defaults — that also got HTTP 400.
  //
  // The body MUST include `state` (the same value passed in the
  // authorize URL). Omitting it produces the same 400 "Invalid request
  // format" response that bit us on v0.1.133–135.
  const body = JSON.stringify({
    grant_type: "authorization_code",
    code: args.code,
    state: args.state,
    redirect_uri: ANTHROPIC_OAUTH_REDIRECT_URI,
    client_id: ANTHROPIC_OAUTH_CLIENT_ID,
    code_verifier: args.verifier,
  });

  const resp = await fetch(ANTHROPIC_OAUTH_TOKEN_URL, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Accept: "application/json",
    },
    body,
  });

  if (!resp.ok) {
    let detail = "";
    try {
      detail = await resp.text();
    } catch {
      detail = "<kein Antwort-Body>";
    }
    const err = new Error(
      `Anthropic-Token-Endpoint antwortete mit HTTP ${resp.status}: ${detail}`,
    );
    // Status als zusätzliche Eigenschaft anhängen, damit der äußere
    // Flow benutzerfreundliche Meldungen anhand des Codes wählen kann
    // ohne die Fehlerstring zu parsen.
    (err as Error & { status?: number }).status = resp.status;
    throw err;
  }

  const json = (await resp.json()) as {
    access_token?: unknown;
    refresh_token?: unknown;
    expires_in?: unknown;
    scope?: unknown;
    token_type?: unknown;
  };

  if (typeof json.access_token !== "string" || json.access_token.length < 10) {
    throw new Error(
      "Anthropic-Token-Antwort enthielt kein gültiges `access_token`.",
    );
  }

  const out: TokenResult = { accessToken: json.access_token };
  if (typeof json.refresh_token === "string") {
    out.refreshToken = json.refresh_token;
  }
  if (typeof json.expires_in === "number") {
    out.expiresIn = json.expires_in;
  }
  if (typeof json.scope === "string") {
    out.scope = json.scope;
  }
  if (typeof json.token_type === "string") {
    out.tokenType = json.token_type;
  }
  return out;
}
